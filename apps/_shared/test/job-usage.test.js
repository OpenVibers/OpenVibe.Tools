'use strict';
// Developer-project usage (WS-N task 4, jobs/usage.js): a project's job that ends is counted in the
// transaction that records its end, per project, environment, capability, job type or tool and hour,
// failures by code with their job id and submit trace id; nobody else's jobs and no cancelled job
// count; each closed hour is written to the outbox once as tools.usage.recorded (valid against
// openvibe-contracts, no owner, input or file name); a job ending in an hour already sent re-sends it
// as revision 2; without an outbox nothing is counted.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { dep } = require('./deps');

const Database = dep('better-sqlite3');
const contracts = dep('openvibe-contracts');
const sdk = dep('openvibe-sdk');
const jobs = require('../jobs');
const { outboxFromEnv } = require('../jobs/events');
const { keyOf, HOUR_MS } = require('../jobs/usage');

const PRJ = 'prj_01JDDDDDDDDDDDDDDDDDDDDDDD';
const APP = 'app_01JCCCCCCCCCCCCCCCCCCCCCCC';
const USER = 'usr_01JAAAAAAAAAAAAAAAAAAAAAAA';
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const SECRET_INPUT = 'secret-input-text-xyzzy';
const SECRET_FILE = 'holiday-photo-of-alice.txt';
const silent = { log() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, what, ms = 5000) {
    const t0 = Date.now();
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
        await sleep(10);
    }
}

const ENV = { EVENTS_URL: 'http://events.test/', OV_OAUTH_CLIENT_SECRET: 'tools-secret', OV_NETWORK_INTERNAL_URL: 'http://network.test' };
const fakeFetch = async () => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });

function define(system) {
    system.define({
        type: 'test.upper', maxFiles: 1,
        async run({ input, outDir, signal }) {
            if (input.hold) await new Promise((_, rej) => (signal.aborted ? rej(new Error('aborted')) : signal.addEventListener('abort', () => rej(new Error('aborted')))));
            const out = path.join(outDir, 'secret-output-name.txt');
            fs.writeFileSync(out, String(input.text || '').toUpperCase());
            return { files: [{ path: out, name: 'secret-output-name.txt', mime: 'text/plain' }] };
        },
    });
    system.define({
        type: 'test.boom', maxFiles: 1,
        async run({ files }) { throw Object.assign(new Error(`Cannot read ${files[0].name}`), { status: 422, code: 'tools.test.unreadable' }); },
    });
}

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-job-usage-'));
    try {
        // ── Without an outbox: nothing counted, no table ──
        {
            const db = new Database(':memory:');
            const dir = path.join(root, 'inert');
            fs.mkdirSync(dir);
            const system = jobs.createJobSystem({ db, contracts, service: 'img', dataDir: dir, log: silent });
            define(system);
            system.start();
            const { job } = await system.submit({ owner: `app:${APP}`, type: 'test.upper', input: { text: 'x' }, project: PRJ });
            await until(() => system.get(job.id).state === 'succeeded', 'inert job');
            assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'tool_job_usage'").get().n, 0);
            assert.deepStrictEqual(system.stats().usage, { enabled: false });
            system.stop(); db.close();
        }

        const dir = path.join(root, 'a');
        fs.mkdirSync(dir);
        const db = new Database(path.join(dir, 'jobs.db'));
        const { outbox } = outboxFromEnv({ db, sdk, env: ENV, fetch: fakeFetch, log: silent });
        const system = jobs.createJobSystem({ db, contracts, service: 'img', dataDir: dir, concurrency: 1, outbox, progressThrottleMs: 0, log: silent });
        define(system);
        system.start();
        const run = async (o, state) => {
            const { job } = await system.submit({ owner: `app:${APP}`, type: 'test.upper', input: { text: SECRET_INPUT }, ...o });
            await until(() => { const r = system.get(job.id); return r && r.state === state; }, `${job.id} ${state}`);
            return job.id;
        };

        // ── What counts: a project's ended jobs, per capability, dimension and environment ──
        await run({ project: PRJ }, 'succeeded');
        await run({ project: PRJ, traceId: TRACE }, 'succeeded');
        const failedId = await run({ project: PRJ, type: 'test.boom', traceId: TRACE, files: [{ buffer: Buffer.from('x'), name: SECRET_FILE, mime: 'text/plain' }] }, 'failed');
        await run({ project: PRJ, env: 'sandbox' }, 'succeeded');
        await run({ project: PRJ, tool: 'image-resize' }, 'succeeded');
        await run({ project: null, owner: `user:${USER}` }, 'succeeded');   // a person's job: no project, not counted
        assert.strictEqual(system.get(failedId).trace_id, TRACE, 'the submit request\'s trace id is kept with the job');
        const { job: held } = await system.submit({ owner: `app:${APP}`, type: 'test.upper', input: { hold: true }, project: PRJ });
        await until(() => system.get(held.id).state === 'running', 'held job running');
        system.cancel(held.id);
        await until(() => system.get(held.id).state === 'cancelled', 'held job cancelled');

        const rows = db.prepare('SELECT * FROM tool_job_usage ORDER BY capability, dimension, env').all();
        const view = rows.map(r => [r.capability, r.dimension, r.env, r.quantity, r.errors]);
        assert.deepStrictEqual(view, [
            ['tools.job.create', 'test.boom', 'production', 1, 1],
            ['tools.job.create', 'test.upper', 'production', 2, 0],
            ['tools.job.create', 'test.upper', 'sandbox', 1, 0],
            ['tools.tool.run', 'image-resize', 'production', 1, 0],
        ], 'a cancelled job and a person\'s job are not counted');
        const boom = rows[0];
        assert.deepStrictEqual(JSON.parse(boom.error_codes), { 'tools.test.unreadable': 1 });
        const [sample] = JSON.parse(boom.samples);
        assert.deepStrictEqual([sample.code, sample.status, sample.trace_id, sample.ref], ['tools.test.unreadable', 422, TRACE, failedId]);
        assert.strictEqual(keyOf({ ...system.get(failedId), state: 'cancelled' }), null);

        // ── Nothing leaves before the hour closes ──
        const before = db.prepare("SELECT COUNT(*) AS n FROM event_outbox WHERE envelope LIKE '%tools.usage.recorded%'").get().n;
        assert.strictEqual(before, 0);
        assert.strictEqual(system.flushUsage().queued, 0);

        // ── After the hour: one tools.usage.recorded per rollup, once ──
        const later = rows[0].window_start + HOUR_MS + 2 * 60 * 1000;
        assert.strictEqual(system.flushUsage(later).queued, 4);
        assert.strictEqual(system.flushUsage(later).queued, 0, 'sent once');
        const sent = db.prepare('SELECT envelope FROM event_outbox ORDER BY id').all().map(r => JSON.parse(r.envelope)).filter(e => e.event_type === 'tools.usage.recorded');
        assert.strictEqual(sent.length, 4);
        for (const env of sent) {
            const v = contracts.validate('tools.usage.recorded@1', env.payload);
            assert.ok(v.valid, JSON.stringify(v.errors));
            assert.ok(contracts.validate('events.event-envelope@1', env).valid);
            assert.deepStrictEqual([env.source, env.visibility, env.priority, env.subject.type, env.subject.id, env.actor.id], ['tools', 'internal', 'low', 'project', PRJ, 'tools']);
            assert.strictEqual(env.payload.unit, 'jobs');
            assert.strictEqual(Date.parse(env.payload.window_end) - Date.parse(env.payload.window_start), HOUR_MS);
        }
        const text = JSON.stringify(sent);
        for (const s of [APP, USER, SECRET_INPUT, SECRET_FILE, 'secret-output-name', 'Cannot read']) assert.ok(!text.includes(s), `no "${s}" in usage events`);
        const failedRollup = sent.find(e => e.payload.dimension === 'test.boom').payload;
        assert.deepStrictEqual([failedRollup.quantity, failedRollup.errors, failedRollup.samples[0].ref], [1, 1, failedId]);

        // ── A job that ends in an hour already sent: re-sent as revision 2 with the new totals ──
        db.transaction(() => system.usage.finished({ ...system.get(failedId), state: 'succeeded' }))();
        assert.strictEqual(system.flushUsage(later).queued, 1);
        const resent = db.prepare('SELECT envelope FROM event_outbox ORDER BY id DESC LIMIT 1').get();
        const p = JSON.parse(resent.envelope).payload;
        assert.deepStrictEqual([p.dimension, p.quantity, p.errors, p.revision], ['test.boom', 2, 1, 2]);
        assert.deepStrictEqual(system.stats().usage, { pending: 0, invalid: 0, last_invalid: null });

        system.stop(); outbox.stop(); db.close();
        console.log('job usage: all checks passed');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
})().catch((e) => { console.error(e); process.exit(1); });
