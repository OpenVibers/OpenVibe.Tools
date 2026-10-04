'use strict';
// Developer-project usage (WS-N task 4, jobs/usage.js): a project's job that ends is counted in the
// transaction that records its end, per project, environment, capability, job type or tool and hour,
// failures by code with their job id and submit trace id; nobody else's jobs and no cancelled job
// count; each closed hour is written to the outbox once as tools.usage.recorded (valid against
// openvibe-contracts, no owner, input or file name); a job ending in an hour already sent re-sends it
// as revision 2; without an outbox nothing is counted. On PostgreSQL (plan T8): openvibe-sdk/db.
// Billing readings (plan T5 step 7, a fetch stub as OpenVibe.Billing): every job that succeeded or failed
// stores one platform.usage-sample@1 reading in that transaction and the flush posts it once (subject only
// for a person, idempotency_key tools:job:<id>); a cancelled job posts nothing; a refused post is logged,
// never thrown, and retried; without OV_BILLING_URL nothing is stored and the rollups still work.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { dep } = require('./deps');
const { testDb, closeAllTestDbs } = require('./testdb');

const contracts = dep('openvibe-contracts');
const sdk = dep('openvibe-sdk');
const jobs = require('../jobs');
const { outboxFromEnv } = require('../jobs/events');
const { keyOf, readingOf, HOUR_MS } = require('../jobs/usage');
const { createBillingClient } = require('../billing');

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
            const db = await testDb(path.join(root, 'inert-db'));
            const dir = path.join(root, 'inert');
            fs.mkdirSync(dir, { recursive: true });
            const system = jobs.createJobSystem({ db, contracts, service: 'img', dataDir: dir, log: silent });
            define(system);
            await system.start();
            const { job } = await system.submit({ owner: `app:${APP}`, type: 'test.upper', input: { text: 'x' }, project: PRJ });
            await until(async () => (await system.get(job.id)).state === 'succeeded', 'inert job');
            assert.strictEqual(Number((await db.prepare('SELECT COUNT(*) AS n FROM tool_job_usage').get()).n), 0, 'inert: nothing counted');
            assert.deepStrictEqual((await system.stats()).usage, { enabled: false });
            assert.strictEqual(Number((await db.prepare('SELECT COUNT(*) AS n FROM tool_job_billing_readings').get()).n), 0, 'inert: no reading stored');
            assert.strictEqual(createBillingClient({ env: {}, fetchImpl: () => { throw new Error('no fetch while inert'); } }).enabled, false);
            assert.ok(!('billing' in (await system.stats())), 'no billing stats while inert');
            system.stop();
        }

        const dir = path.join(root, 'a');
        fs.mkdirSync(dir, { recursive: true });
        const db = await testDb(dir);
        const { outbox } = outboxFromEnv({ db, sdk, env: ENV, fetch: fakeFetch, log: silent });
        await outbox.ready;
        const system = jobs.createJobSystem({ db, contracts, service: 'img', dataDir: dir, concurrency: 1, outbox, progressThrottleMs: 0, log: silent });
        define(system);
        await system.start();
        const run = async (o, state) => {
            const { job } = await system.submit({ owner: `app:${APP}`, type: 'test.upper', input: { text: SECRET_INPUT }, ...o });
            await until(async () => { const r = await system.get(job.id); return r && r.state === state; }, `${job.id} ${state}`);
            return job.id;
        };

        // ── What counts: a project's ended jobs, per capability, dimension and environment ──
        await run({ project: PRJ }, 'succeeded');
        await run({ project: PRJ, traceId: TRACE }, 'succeeded');
        const failedId = await run({ project: PRJ, type: 'test.boom', traceId: TRACE, files: [{ buffer: Buffer.from('x'), name: SECRET_FILE, mime: 'text/plain' }] }, 'failed');
        await run({ project: PRJ, env: 'sandbox' }, 'succeeded');
        await run({ project: PRJ, tool: 'image-resize' }, 'succeeded');
        await run({ project: null, owner: `user:${USER}` }, 'succeeded');   // a person's job: no project, not counted
        assert.strictEqual((await system.get(failedId)).trace_id, TRACE, 'the submit request\'s trace id is kept with the job');
        const { job: held } = await system.submit({ owner: `app:${APP}`, type: 'test.upper', input: { hold: true }, project: PRJ });
        await until(async () => (await system.get(held.id)).state === 'running', 'held job running');
        await system.cancel(held.id);
        await until(async () => (await system.get(held.id)).state === 'cancelled', 'held job cancelled');

        const rows = await db.prepare('SELECT * FROM tool_job_usage ORDER BY capability, dimension, env').all();
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
        assert.strictEqual(keyOf({ ...(await system.get(failedId)), state: 'cancelled' }), null);

        // ── Nothing leaves before the hour closes ──
        const before = (await db.prepare("SELECT COUNT(*) AS n FROM event_outbox WHERE envelope->>'event_type' = 'tools.usage.recorded'").get()).n;
        assert.strictEqual(Number(before), 0);
        assert.strictEqual((await system.flushUsage()).queued, 0);

        // ── After the hour: one tools.usage.recorded per rollup, once ──
        const later = Number(rows[0].window_start) + HOUR_MS + 2 * 60 * 1000;
        assert.strictEqual((await system.flushUsage(later)).queued, 4);
        assert.strictEqual((await system.flushUsage(later)).queued, 0, 'sent once');
        const sent = (await db.prepare('SELECT envelope FROM event_outbox ORDER BY id').all()).map(r => (typeof r.envelope === 'string' ? JSON.parse(r.envelope) : r.envelope)).filter(e => e.event_type === 'tools.usage.recorded');
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
        await db.tx(async () => system.usage.finished({ ...(await system.get(failedId)), state: 'succeeded' }));
        assert.strictEqual((await system.flushUsage(later)).queued, 1);
        const resent = await db.prepare('SELECT envelope FROM event_outbox ORDER BY id DESC LIMIT 1').get();
        const p = (typeof resent.envelope === 'string' ? JSON.parse(resent.envelope) : resent.envelope).payload;
        assert.deepStrictEqual([p.dimension, p.quantity, p.errors, p.revision], ['test.boom', 2, 1, 2]);
        assert.deepStrictEqual((await system.stats()).usage, { pending: 0, invalid: 0, last_invalid: null });
        assert.strictEqual(Number((await db.prepare('SELECT COUNT(*) AS n FROM tool_job_billing_readings').get()).n), 0, 'rollups without OV_BILLING_URL: no reading stored');

        system.stop(); await outbox.stop();

        // ── Billing readings (no events outbox: the readings work without one) ──
        {
            const bdir = path.join(root, 'billing');
            fs.mkdirSync(bdir, { recursive: true });
            const bdb = await testDb(bdir);
            const posts = [];                 // what Billing stored, by idempotency_key
            const stored = new Map();
            const tokens = [];
            let mode = 'ok';
            const billingFetch = async (url, init) => {
                if (String(url) === 'http://network.test/oauth/token') {
                    const form = new URLSearchParams(String(init.body));
                    tokens.push(form.get('audience'));
                    if (mode === 'no-grant') return new Response(JSON.stringify({ error: 'invalid_scope' }), { status: 401 });
                    if (mode === 'invalid-scope') return new Response(JSON.stringify({ error: 'invalid_scope' }), { status: 400 });
                    return new Response(JSON.stringify({ access_token: 'tools-billing-token', expires_in: 3600 }), { status: 200 });
                }
                assert.strictEqual(String(url), 'http://billing.test/api/v1/usage');
                assert.strictEqual(init.headers.Authorization, 'Bearer tools-billing-token');
                if (mode === 'down') return new Response('{"error":{"code":"billing.unavailable"}}', { status: 503 });
                if (mode === 'bad') return new Response('{"error":{"code":"billing.invalid_reading"}}', { status: 400 });
                const reading = JSON.parse(init.body);
                posts.push(reading);
                const replay = stored.has(reading.idempotency_key);
                stored.set(reading.idempotency_key, reading);
                return new Response(JSON.stringify(reading), { status: replay ? 200 : 201 });
            };
            const errors = [];
            const blog = { log() {}, warn() {}, error: (...a) => errors.push(a.join(' ')) };
            const billing = createBillingClient({ env: { OV_BILLING_URL: 'http://billing.test/', OV_NETWORK_INTERNAL_URL: 'http://network.test', OV_OAUTH_CLIENT_SECRET: 'tools-secret' }, fetchImpl: billingFetch, log: blog });
            assert.strictEqual(billing.enabled, true);
            const bsys = jobs.createJobSystem({ db: bdb, contracts, service: 'img', dataDir: bdir, concurrency: 1, billing, progressThrottleMs: 0, pruneIntervalMs: 60 * 60 * 1000, log: blog });
            define(bsys);
            await bsys.start();
            const brun = async (o, state) => {
                const { job } = await bsys.submit({ owner: `app:${APP}`, type: 'test.upper', input: { text: SECRET_INPUT }, ...o });
                await until(async () => { const r = await bsys.get(job.id); return r && r.state === state; }, `${job.id} ${state}`);
                return job.id;
            };
            const readingRows = async () => bdb.prepare('SELECT * FROM tool_job_billing_readings ORDER BY created_at, job_id').all();

            const personId = await brun({ owner: `user:${USER}`, project: null, tool: 'image-resize', traceId: TRACE }, 'succeeded');
            const appId = await brun({ project: PRJ }, 'succeeded');
            const failId = await brun({ project: PRJ, type: 'test.boom', files: [{ buffer: Buffer.from('x'), name: SECRET_FILE, mime: 'text/plain' }] }, 'failed');
            const { job: held } = await bsys.submit({ owner: `user:${USER}`, type: 'test.upper', input: { hold: true } });
            await until(async () => (await bsys.get(held.id)).state === 'running', 'held job running');
            await bsys.cancel(held.id);
            await until(async () => (await bsys.get(held.id)).state === 'cancelled', 'held job cancelled');
            assert.deepStrictEqual((await readingRows()).map(r => [r.job_id, r.sent_at]), [[personId, null], [appId, null], [failId, null]], 'stored in the job-end transaction, unsent; a cancelled job has none');
            assert.strictEqual(posts.length, 0, 'nothing is posted inside the job\'s transaction');

            assert.deepStrictEqual(await bsys.flushReadings(), { posted: 3, refused: 0 });
            assert.deepStrictEqual(tokens, ['openvibe.billing'], 'one token for the Billing audience, cached');
            assert.deepStrictEqual(posts.map(p => p.idempotency_key), [personId, appId, failId].map(id => `tools:job:${id}`));
            for (const p of posts) {
                const v = contracts.validate('platform.usage-sample@1', p);
                assert.ok(v.valid, JSON.stringify(v.errors));
                assert.deepStrictEqual([p.service, p.source, p.quantity, p.unit], ['openvibe.tools', 'openvibe.tools', 1, 'jobs']);
            }
            const [person, appJob, failJob] = posts;
            assert.deepStrictEqual([person.id, person.operation, person.resource, person.subject, person.trace_id, person.project], [`tools-job-${personId}`, 'tools.tool.run', 'image-resize', `user:${USER}`, TRACE, undefined]);
            assert.deepStrictEqual([appJob.operation, appJob.resource, appJob.project, 'subject' in appJob], ['tools.job.create', 'test.upper', PRJ, false], 'an app\'s job carries its project, no subject');
            assert.deepStrictEqual([failJob.operation, failJob.resource, failJob.quantity], ['tools.job.create', 'test.boom', 1], 'a failed job is billed');
            const text = JSON.stringify(posts);
            for (const s of [APP, SECRET_INPUT, SECRET_FILE, 'secret-output-name', 'Cannot read', held.id]) assert.ok(!text.includes(s), `no "${s}" in readings`);
            assert.ok((await readingRows()).every(r => r.sent_at != null && Number(r.attempts) === 0));

            // ── Once per job: a second flush and a re-run of the job's end add nothing ──
            assert.deepStrictEqual(await bsys.flushReadings(), { posted: 0, refused: 0 });
            await bdb.tx(async () => bsys.usage.finished(await bsys.get(personId)));
            assert.strictEqual((await readingRows()).length, 3, 'a re-run stores no second reading');
            assert.deepStrictEqual(await bsys.flushReadings(), { posted: 0, refused: 0 });
            assert.strictEqual(posts.length, 3);
            assert.strictEqual(readingOf(await bsys.get(personId)).idempotency_key, `tools:job:${personId}`, 'the key is stable');
            assert.deepStrictEqual(readingOf(await bsys.get(personId)), person, 'the stored reading is the job\'s reading');
            assert.strictEqual(readingOf(await bsys.get(held.id)), null);

            // ── Refused: logged, never thrown into the job, kept unsent with the error for the next flush ──
            mode = 'down';
            const downId = await brun({ project: PRJ }, 'succeeded');
            const downId2 = await brun({ project: PRJ }, 'succeeded');
            assert.deepStrictEqual(await bsys.flushReadings(), { posted: 0, refused: 1 }, 'Billing down: stop after the first refusal');
            let rows = await readingRows();
            const down = rows.find(r => r.job_id === downId);
            assert.deepStrictEqual([down.sent_at, Number(down.attempts)], [null, 1]);
            assert.match(down.last_error, /^503 /);
            assert.ok(errors.some(e => e.includes(`tools:job:${downId}`) && e.includes('503')), 'the refusal is logged');
            mode = 'bad';
            assert.deepStrictEqual(await bsys.flushReadings(), { posted: 0, refused: 2 }, 'a 4xx for one reading does not stop the others');
            mode = 'ok';
            assert.deepStrictEqual(await bsys.flushReadings(), { posted: 2, refused: 0 });
            rows = await readingRows();
            assert.ok(rows.every(r => r.sent_at != null), 'sent on the next flush');
            assert.deepStrictEqual(posts.slice(3).map(p => p.idempotency_key).sort(), [downId, downId2].map(id => `tools:job:${id}`).sort());
            assert.strictEqual((await bsys.get(downId)).state, 'succeeded', 'the job is untouched by the refusal');

            // ── No grant yet (the token is refused): logged, never thrown ──
            const noGrant = createBillingClient({ env: { OV_BILLING_URL: 'http://billing.test', OV_NETWORK_INTERNAL_URL: 'http://network.test' }, fetchImpl: billingFetch, log: blog });
            mode = 'no-grant';
            const res = await noGrant.post(person);
            assert.deepStrictEqual([res.ok, res.status], [false, 401]);
            mode = 'ok';
            const st = (await bsys.stats()).billing;
            assert.deepStrictEqual([st.pending, st.posted, st.refused, st.invalid], [0, 5, 3, 0]);

            // ── Network answers a missing grant with 400 invalid_scope: the tick stops after the first reading ──
            const scopeId = [await brun({ project: PRJ }, 'succeeded'), await brun({ project: PRJ }, 'succeeded'), await brun({ project: PRJ }, 'succeeded')];
            const noScope = createBillingClient({ env: { OV_BILLING_URL: 'http://billing.test', OV_NETWORK_INTERNAL_URL: 'http://network.test' }, fetchImpl: billingFetch, log: blog });
            const ssys = jobs.createJobSystem({ db: bdb, contracts, service: 'img', dataDir: bdir, concurrency: 1, billing: noScope, progressThrottleMs: 0, pruneIntervalMs: 60 * 60 * 1000, log: blog });
            mode = 'invalid-scope';
            const tokensBefore = tokens.length;
            assert.deepStrictEqual(await ssys.flushReadings(), { posted: 0, refused: 1 }, 'a token refusal ends the tick after the first reading');
            assert.strictEqual(tokens.length - tokensBefore, 1, 'one token request in the tick');
            const unsent = (await readingRows()).filter(r => scopeId.includes(r.job_id));
            assert.strictEqual(unsent.length, 3);
            assert.ok(unsent.every(r => r.sent_at == null), 'all three readings are still unsent');
            assert.deepStrictEqual(unsent.map(r => Number(r.attempts)).sort(), [0, 0, 1], 'attempts raised on the first one only');
            assert.ok(unsent.some(r => /^token: 400 invalid_scope/.test(r.last_error)));
            mode = 'ok';
            bsys.stop();
        }
        console.log('job usage: all checks passed');
    } finally {
        await closeAllTestDbs();
        fs.rmSync(root, { recursive: true, force: true });
    }
})().catch((e) => { console.error(e); process.exit(1); });
