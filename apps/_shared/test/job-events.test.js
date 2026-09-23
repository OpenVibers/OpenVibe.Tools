'use strict';
// tools.job.* → OpenVibe.Events (roadmap Wave 11): every transition writes exactly one event to the
// jobs database's outbox in the transaction that records it; a rolled-back transition writes none;
// sandbox jobs and cancellations write none; payloads carry no input, file name, output data or
// browser session and validate against openvibe-contracts; the relay posts to EVENTS_URL with the
// tools service token; and without EVENTS_URL nothing is set up at all.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { dep } = require('./deps');

const Database = dep('better-sqlite3');
const contracts = dep('openvibe-contracts');
const sdk = dep('openvibe-sdk');
const jobs = require('../jobs');
const { outboxFromEnv, payloadFor, ownerRef } = require('../jobs/events');

const USER = 'usr_01JAAAAAAAAAAAAAAAAAAAAAAA';
const APP = 'app_01JCCCCCCCCCCCCCCCCCCCCCCC';
const SESSION = 'session:0123456789abcdef0123456789abcdef01234567';
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

const gates = new Map();
function gate(name) {
    if (!gates.has(name)) { let open; const promise = new Promise(r => { open = r; }); gates.set(name, { promise, open }); }
    return gates.get(name);
}
const flaky = new Set();
function define(system) {
    system.define({
        type: 'test.upper', maxFiles: 1,
        async run({ input, files, outDir, signal }) {
            if (input.gate) await Promise.race([gate(input.gate).promise, new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))))]);
            const text = files.length ? fs.readFileSync(files[0].path, 'utf8') : input.text || '';
            const out = path.join(outDir, 'secret-output-name.txt');
            fs.writeFileSync(out, text.toUpperCase());
            return { files: [{ path: out, name: 'secret-output-name.txt', mime: 'text/plain' }], data: { echoed: input.text || null } };
        },
    });
    // Its error names the input file (by name and by server path), which must not reach the network.
    system.define({
        type: 'test.boom', maxFiles: 1,
        async run({ files }) { throw new Error(`Cannot read ${files[0].name} at ${files[0].path}`); },
    });
    system.define({
        type: 'test.flaky', maxFiles: 1,
        async run({ input, files, outDir }) {
            if (flaky.has(input.tag)) throw Object.assign(new Error('upstream hiccup'), { retryable: true });
            const out = path.join(outDir, 'f.txt');
            fs.writeFileSync(out, fs.readFileSync(files[0].path));
            return { files: [{ path: out, name: 'f.txt', mime: 'text/plain' }] };
        },
    });
    system.define({
        type: 'test.fragile', onRestart: 'fail',
        async run({ input, signal }) {
            await Promise.race([gate(input.gate).promise, new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))))]);
            return { data: {} };
        },
    });
}

// ── A fake Network token endpoint + OpenVibe.Events, as a fetch ──
function fakeNetwork() {
    const calls = { token: [], publish: [] };
    let seq = 0;
    async function fetchImpl(url, init = {}) {
        const u = new URL(String(url));
        const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
        if (u.host === 'network.test' && u.pathname === '/oauth/token') {
            const form = Object.fromEntries(new URLSearchParams(String(init.body)));
            calls.token.push(form);
            return reply(200, { access_token: 'events-token', token_type: 'Bearer', expires_in: 300, scope: form.scope });
        }
        if (u.host === 'events.test' && u.pathname === '/api/v1/events' && init.method === 'POST') {
            const headers = new Headers(init.headers);
            const body = JSON.parse(String(init.body));
            const list = body.events || [body];
            calls.publish.push({ authorization: headers.get('authorization'), events: list });
            const results = list.map(e => ({ event_id: e.event_id, seq: ++seq, duplicate: false }));
            return reply(201, body.events ? { results } : results[0]);
        }
        return reply(404, { code: 'not_found' });
    }
    return { fetch: fetchImpl, calls };
}

const ENV = { EVENTS_URL: 'http://events.test/', OV_OAUTH_CLIENT_SECRET: 'tools-secret', OV_NETWORK_INTERNAL_URL: 'http://network.test' };

function satellite(dir, { wrap, concurrency = 1, net } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const db = new Database(path.join(dir, 'jobs.db'));
    const { outbox, reason } = outboxFromEnv({ db, sdk, env: ENV, fetch: net.fetch, log: silent });
    assert.ok(outbox, `outbox configured (${reason})`);
    const system = jobs.createJobSystem({ db, contracts, service: 'img', dataDir: dir, concurrency, outbox: wrap ? wrap(outbox) : outbox, progressThrottleMs: 0, log: silent });
    define(system);
    system.start();
    const envelopes = (jobId) => db.prepare('SELECT envelope FROM event_outbox ORDER BY id').all().map(r => JSON.parse(r.envelope))
        .filter(e => !jobId || e.subject.id === jobId);
    return { db, system, outbox, envelopes, close() { system.stop(); outbox.stop(); db.close(); } };
}

const types = (list) => list.map(e => e.event_type);
function checkContracts(env) {
    const v = contracts.validate(`${env.event_type}@1`, env.payload);
    assert.ok(v.valid, `${env.event_type} payload validates: ${JSON.stringify(v.errors)}`);
    const e = contracts.validate('events.event-envelope@1', env);
    assert.ok(e.valid, `${env.event_type} envelope validates: ${JSON.stringify(e.errors)}`);
    assert.strictEqual(env.source, 'tools');
    assert.deepStrictEqual(env.subject, { type: 'job', id: env.payload.job_id });
    assert.strictEqual(env.visibility, 'internal');
    assert.strictEqual(env.payload.service, 'img');
}
function noLeaks(list, extra = []) {
    const text = JSON.stringify(list);
    for (const s of [SECRET_INPUT, SECRET_FILE, 'secret-output-name', 'session:', SESSION.slice(8), 'echoed', '/tmp', os.tmpdir(), ...extra]) {
        assert.ok(!text.includes(s), `no "${s}" in published events`);
    }
    for (const env of list) {
        for (const k of ['input', 'input_json', 'files', 'files_json', 'data', 'idempotency_key', 'request_hash']) {
            assert.ok(!(k in env.payload), `${env.event_type} has no ${k}`);
        }
    }
}
const settled = (s, id, state) => until(() => { const r = s.system.get(id); return r && r.state === state && r; }, `${id} ${state}`);

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-job-events-'));
    try {
        // ── Inert without EVENTS_URL ─────────────────────────────
        {
            const db = new Database(':memory:');
            assert.deepStrictEqual(outboxFromEnv({ db, sdk, env: {} }), { outbox: null, reason: 'EVENTS_URL is not set' });
            assert.strictEqual(outboxFromEnv({ db, sdk, env: { EVENTS_URL: 'http://events.test' } }).outbox, null, 'no secret, no outbox');
            assert.strictEqual(outboxFromEnv({ db, sdk, env: { ...ENV, EVENTS_PUBLISH: 'off' } }).outbox, null, 'EVENTS_PUBLISH=off');
            assert.strictEqual(outboxFromEnv({ db, sdk: null, env: ENV }).outbox, null, 'no sdk, no outbox');
            const dir = path.join(root, 'inert');
            fs.mkdirSync(dir);
            const system = jobs.createJobSystem({ db, contracts, service: 'img', dataDir: dir, log: silent });
            define(system);
            system.start();
            const { job } = await system.submit({ owner: `user:${USER}`, type: 'test.upper', input: { text: 'x' } });
            await until(() => system.get(job.id).state === 'succeeded', 'inert job');
            assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'event_outbox'").get().n, 0, 'no outbox table without EVENTS_URL');
            assert.deepStrictEqual(system.stats().events, { enabled: false });
            system.stop(); db.close();
        }

        const net = fakeNetwork();
        // An outbox that can be told to fail right after it wrote a row (a failing write inside the transaction).
        let failOn = null;
        const wrap = (outbox) => ({
            ...outbox,
            enqueue(envelope, opts) {
                const env = outbox.enqueue(envelope, opts);
                if (failOn === envelope.event_type) throw new Error('disk I/O error (test)');
                return env;
            },
        });
        let s = satellite(path.join(root, 'a'), { net, wrap });

        // ── A signed-in person's job: created, started, succeeded — once each ──
        let { job } = await s.system.submit({ owner: `user:${USER}`, type: 'test.upper', input: { text: SECRET_INPUT }, files: [{ buffer: Buffer.from('hello'), name: SECRET_FILE, mime: 'text/plain' }] });
        await settled(s, job.id, 'succeeded');
        let list = s.envelopes(job.id);
        assert.deepStrictEqual(types(list), ['tools.job.created', 'tools.job.started', 'tools.job.succeeded']);
        list.forEach(checkContracts);
        noLeaks(list);
        assert.deepStrictEqual(list[0].actor, { type: 'user', id: USER }, 'created: the owner acts');
        assert.deepStrictEqual(list[1].actor, { type: 'service', id: 'tools' });
        assert.deepStrictEqual(list[2].actor, { type: 'service', id: 'tools' });
        assert.deepStrictEqual(list.map(e => e.priority), ['low', 'low', 'important']);
        assert.deepStrictEqual(list.map(e => e.payload.state), ['queued', 'running', 'succeeded']);
        assert.deepStrictEqual(list[0].payload.owner, { type: 'user', id: USER });
        assert.strictEqual(list[0].payload.retry_of, null);
        assert.strictEqual(list[1].payload.attempts, 1);
        const done = list[2].payload;
        assert.ok(done.started_at && done.finished_at && done.expires_at);
        assert.deepStrictEqual(Object.keys(done.result), ['files']);
        assert.strictEqual(done.result.files.length, 1);
        assert.deepStrictEqual(Object.keys(done.result.files[0]).sort(), ['index', 'media', 'mime', 'sha256', 'size', 'storage']);
        assert.strictEqual(done.result.files[0].storage, 'local');
        assert.strictEqual(done.result.files[0].media, null);
        assert.strictEqual(done.result.files[0].size, 5);
        assert.deepStrictEqual(s.system.stats().events.enabled, true);

        // ── A failure whose message names the input file: failed once, name and path scrubbed ──
        ({ job } = await s.system.submit({ owner: `user:${USER}`, type: 'test.boom', input: { text: SECRET_INPUT }, files: [{ buffer: Buffer.from('x'), name: SECRET_FILE, mime: 'text/plain' }] }));
        await settled(s, job.id, 'failed');
        list = s.envelopes(job.id);
        assert.deepStrictEqual(types(list), ['tools.job.created', 'tools.job.started', 'tools.job.failed']);
        list.forEach(checkContracts);
        noLeaks(list);
        const failed = list[2].payload;
        assert.strictEqual(failed.error.code, 'tools.job.failed');
        assert.strictEqual(failed.error.status, 422);
        assert.match(failed.error.detail, /^Cannot read \[file\] at \[file\]$/);
        assert.strictEqual(failed.retryable, false);
        assert.deepStrictEqual(Object.keys(failed.error).sort(), ['code', 'detail', 'status']);

        // ── A browser session's job: owner null, the service acts, the session never appears ──
        ({ job } = await s.system.submit({ owner: SESSION, type: 'test.upper', input: { text: SECRET_INPUT } }));
        await settled(s, job.id, 'succeeded');
        list = s.envelopes(job.id);
        assert.deepStrictEqual(types(list), ['tools.job.created', 'tools.job.started', 'tools.job.succeeded']);
        list.forEach(checkContracts);
        noLeaks(list);
        for (const e of list) { assert.strictEqual(e.payload.owner, null); assert.deepStrictEqual(e.actor, { type: 'service', id: 'tools' }); }

        // ── Principals: a service and a production app are subjects ──
        ({ job } = await s.system.submit({ owner: 'svc:live', type: 'test.upper', input: {} }));
        await settled(s, job.id, 'succeeded');
        list = s.envelopes(job.id);
        list.forEach(checkContracts);
        assert.deepStrictEqual(list[0].actor, { type: 'service', id: 'live' });
        assert.deepStrictEqual(list[0].payload.owner, { type: 'service', id: 'live' });
        assert.deepStrictEqual(ownerRef(contracts, `app:${APP}`), { type: 'app', id: APP });
        assert.strictEqual(ownerRef(contracts, 'app:nope'), null);

        // ── Sandbox app jobs are never announced ─────────────────
        const before = s.envelopes().length;
        ({ job } = await s.system.submit({ owner: `app:${APP}`, type: 'test.upper', input: { text: 'sandbox' }, env: 'sandbox' }));
        await settled(s, job.id, 'succeeded');
        const sandboxFail = (await s.system.submit({ owner: `app:${APP}`, type: 'test.boom', files: [{ buffer: Buffer.from('x'), name: 'a.txt' }], env: 'sandbox' })).job;
        await settled(s, sandboxFail.id, 'failed');
        assert.strictEqual(s.envelopes(job.id).length + s.envelopes(sandboxFail.id).length, 0, 'sandbox jobs emit nothing');
        assert.strictEqual(s.envelopes().length, before);

        // ── Retry: a new created (retry_of) + its run; the failed job gets nothing new ──
        flaky.add('t1');
        const first = (await s.system.submit({ owner: `user:${USER}`, type: 'test.flaky', input: { tag: 't1' }, files: [{ buffer: Buffer.from('abc'), name: SECRET_FILE }] })).job;
        await settled(s, first.id, 'failed');
        assert.strictEqual(s.envelopes(first.id).at(-1).payload.retryable, true);
        flaky.delete('t1');
        const retried = s.system.retry(first.id).job;
        await settled(s, retried.id, 'succeeded');
        assert.deepStrictEqual(types(s.envelopes(first.id)), ['tools.job.created', 'tools.job.started', 'tools.job.failed'], 'the retried job gets no new event');
        list = s.envelopes(retried.id);
        assert.deepStrictEqual(types(list), ['tools.job.created', 'tools.job.started', 'tools.job.succeeded']);
        list.forEach(checkContracts);
        noLeaks(list);
        assert.strictEqual(list[0].payload.retry_of, first.id);
        assert.strictEqual(s.system.retry(first.id).replayed, true);
        assert.strictEqual(s.envelopes(retried.id).length, 3, 'a replayed retry creates no event');

        // ── An Idempotency-Key replay creates no job and no event ──
        const k1 = (await s.system.submit({ owner: `user:${USER}`, type: 'test.upper', input: { text: 'k' }, idempotencyKey: 'key-00000001' })).job;
        await settled(s, k1.id, 'succeeded');
        const k2 = await s.system.submit({ owner: `user:${USER}`, type: 'test.upper', input: { text: 'k' }, idempotencyKey: 'key-00000001' });
        assert.strictEqual(k2.replayed, true);
        assert.strictEqual(s.envelopes(k1.id).length, 3);

        // ── Cancelled jobs are not announced (neither queued nor running) ──
        const blocker = (await s.system.submit({ owner: `user:${USER}`, type: 'test.upper', input: { gate: 'g1' } })).job;
        await settled(s, blocker.id, 'running');
        const queued = (await s.system.submit({ owner: `user:${USER}`, type: 'test.upper', input: { text: 'q' } })).job;
        assert.strictEqual(s.system.cancel(queued.id).changed, true);
        assert.deepStrictEqual(types(s.envelopes(queued.id)), ['tools.job.created']);
        s.system.cancel(blocker.id);
        await settled(s, blocker.id, 'cancelled');
        assert.deepStrictEqual(types(s.envelopes(blocker.id)), ['tools.job.created', 'tools.job.started']);

        // ── Rollbacks: a failed outbox write undoes the transition, and no event is left ──
        const count = () => s.envelopes().length;
        let n = count();
        failOn = 'tools.job.created';
        await assert.rejects(s.system.submit({ owner: `user:${USER}`, type: 'test.upper', input: { text: 'rollback' } }), /disk I\/O error/);
        failOn = null;
        assert.strictEqual(count(), n, 'rolled-back submit: no event');
        assert.strictEqual(s.db.prepare("SELECT COUNT(*) AS n FROM tool_jobs WHERE input_json LIKE '%rollback%'").get().n, 0, 'rolled-back submit: no job');

        // claim(): the job stays queued and nothing says it started.
        failOn = 'tools.job.started';
        const stuck = (await s.system.submit({ owner: `user:${USER}`, type: 'test.upper', input: { text: 'claim' } })).job;
        await sleep(50);
        assert.strictEqual(s.system.get(stuck.id).state, 'queued', 'rolled-back claim: still queued');
        assert.strictEqual(s.system.get(stuck.id).attempts, 0);
        assert.deepStrictEqual(types(s.envelopes(stuck.id)), ['tools.job.created'], 'rolled-back claim: no started event');
        failOn = null;
        // The next kick (any submit) starts it: exactly one started.
        const kicker = (await s.system.submit({ owner: `user:${USER}`, type: 'test.upper', input: { text: 'kick' } })).job;
        await settled(s, stuck.id, 'succeeded');
        await settled(s, kicker.id, 'succeeded');
        assert.deepStrictEqual(types(s.envelopes(stuck.id)), ['tools.job.created', 'tools.job.started', 'tools.job.succeeded']);

        // finish(): the job stays running (recovered on the next start) and nothing says it ended.
        failOn = 'tools.job.succeeded';
        const unfinished = (await s.system.submit({ owner: `user:${USER}`, type: 'test.upper', input: { text: 'finish' } })).job;
        await until(() => s.envelopes(unfinished.id).length === 2 && s.system.stats().executing === 0, 'finish attempt');
        await sleep(30);
        assert.strictEqual(s.system.get(unfinished.id).state, 'running', 'rolled-back finish: still running');
        assert.deepStrictEqual(types(s.envelopes(unfinished.id)), ['tools.job.created', 'tools.job.started']);
        failOn = null;

        // ── Restart: the stuck job is re-queued (not announced) and started again (announced again);
        //    a running onRestart:'fail' job fails once with tools.job.interrupted ──
        const fragile = (await s.system.submit({ owner: `user:${USER}`, type: 'test.fragile', input: { gate: 'never' } })).job;
        await settled(s, fragile.id, 'running');
        s.close();
        s = satellite(path.join(root, 'a'), { net });
        await settled(s, unfinished.id, 'succeeded');
        assert.deepStrictEqual(types(s.envelopes(unfinished.id)), ['tools.job.created', 'tools.job.started', 'tools.job.started', 'tools.job.succeeded']);
        assert.strictEqual(s.envelopes(unfinished.id)[2].payload.attempts, 2);
        const fr = s.envelopes(fragile.id);
        assert.deepStrictEqual(types(fr), ['tools.job.created', 'tools.job.started', 'tools.job.failed']);
        fr.forEach(checkContracts);
        assert.strictEqual(fr[2].payload.error.code, 'tools.job.interrupted');
        assert.strictEqual(fr[2].payload.retryable, true);
        assert.ok(fr[2].payload.started_at);

        // ── Every event so far: valid, and never a secret ──
        const all = s.envelopes();
        all.forEach(checkContracts);
        noLeaks(all);
        assert.strictEqual(new Set(all.map(e => e.event_id)).size, all.length, 'unique event ids');

        // ── The relay: POST EVENTS_URL/api/v1/events with the tools token for openvibe.events ──
        assert.strictEqual(s.outbox.pending(), all.length);
        const r = await s.outbox.flush();
        assert.strictEqual(r.sent, all.length);
        assert.strictEqual(s.outbox.pending(), 0);
        const published = net.calls.publish.flatMap(c => c.events);
        assert.deepStrictEqual(published.map(e => e.event_id), all.map(e => e.event_id), 'published in order, once');
        assert.ok(net.calls.publish.every(c => c.authorization === 'Bearer events-token'));
        assert.deepStrictEqual(net.calls.token[0], { grant_type: 'client_credentials', client_id: 'tools', client_secret: 'tools-secret', audience: 'openvibe.events', scope: 'events.event.publish' });
        s.close();

        // ── Payload builder: a result in Media is { media_id, role } only ──
        const row = {
            id: `job_${contracts.ids.ulid()}`, type: 'img.process', type_version: 1, owner: `user:${USER}`, state: 'succeeded', attempts: 1, max_attempts: 3,
            created_at: Date.now() - 1000, started_at: Date.now() - 500, finished_at: Date.now(), expires_at: Date.now() + 3600000, retry_of: null, env: 'production',
            files_json: JSON.stringify([{ name: SECRET_FILE }]),
            result_json: JSON.stringify({ files: [{ name: 'secret-output-name.webp', mime: 'image/webp', size: 12, sha256: 'a'.repeat(64), storage: 'media', media: { media_id: `med_${contracts.ids.ulid()}`, role: 'output', namespace: 'tools', size_bytes: 12, content_hash: 'a'.repeat(64), mime_type: 'image/webp', status: 'ready' } }], data: { width: 3 } }),
        };
        const p = payloadFor('tools.job.succeeded', row, { contracts, service: 'img' });
        assert.ok(contracts.validate('tools.job.succeeded@1', p).valid);
        assert.deepStrictEqual(Object.keys(p.result.files[0].media).sort(), ['media_id', 'role']);
        assert.strictEqual(payloadFor('tools.job.succeeded', row, { contracts, service: 'img', referenced: true }).expires_at, null, 'a referenced result does not expire');
        assert.ok(!JSON.stringify(p).includes('secret-output-name'));

        console.log('job events (tools.job.* outbox): all checks passed');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exit(1); });
