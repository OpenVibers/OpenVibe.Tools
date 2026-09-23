'use strict';
// Wave 11 exit criteria for the shared job runtime, end to end over HTTP:
//   an accepted job survives a restart (DB and app closed and reopened), running jobs are re-queued
//   or failed-retryable per type, reattach by id, cancel (queued and running), idempotency keys,
//   owner scoping, SSE resume with Last-Event-ID, bounded concurrency, pruning, results stored
//   as Media objects through Media's v2 object API (with the local fallback), and retrying a failed job.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { dep } = require('./deps');

const express = dep('express');
const cookieParser = dep('cookie-parser');
const Database = dep('better-sqlite3');
const contracts = dep('openvibe-contracts');
const jobs = require('../jobs');

const ISSUER = 'https://openvibe.network';
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const USER_A = 'usr_01JAAAAAAAAAAAAAAAAAAAAAAA';
const USER_B = 'usr_01JBBBBBBBBBBBBBBBBBBBBBBB';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function until(fn, what, ms = 5000) {
    const t0 = Date.now();
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
        await sleep(20);
    }
}

// ── Job types used by the tests ──────────────────────────────
const gates = new Map();   // name → { promise, open() }
function gate(name) {
    if (!gates.has(name)) { let open; const promise = new Promise(r => { open = r; }); gates.set(name, { promise, open }); }
    return gates.get(name);
}
function define(system) {
    // Upper-cases its input file (or input.text); waits on input.gate when given. Re-queued after a restart.
    system.define({
        type: 'test.upper', maxFiles: 1, maxAttempts: 3,
        validate: (input) => (input.text != null && typeof input.text !== 'string' ? 'text must be a string' : null),
        async run({ input, files, outDir, progress, signal }) {
            progress(10, 'Reading');
            if (input.gate) await Promise.race([gate(input.gate).promise, new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))))]);
            const text = files.length ? fs.readFileSync(files[0].path, 'utf8') : input.text || '';
            progress(60, 'Writing');
            const out = path.join(outDir, 'upper.txt');
            fs.writeFileSync(out, text.toUpperCase());
            return { files: [{ path: out, name: 'upper.txt', mime: 'text/plain' }], data: { length: text.length } };
        },
    });
    // Not safe to run twice: after a restart it fails with retryable = true.
    system.define({
        type: 'test.fragile', onRestart: 'fail',
        async run({ input, signal }) {
            await Promise.race([gate(input.gate).promise, new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))))]);
            return { data: { ok: true } };
        },
    });
    system.define({ type: 'test.boom', async run() { throw new Error('This input at /srv/secret/path/x.png is not an image'); } });
    // Upper-cases its file; fails while its input.tag is in `flaky` (a transient failure, then fixed).
    system.define({
        type: 'test.flaky', maxFiles: 1,
        async run({ input, files, outDir }) {
            if (flaky.has(input.tag)) throw Object.assign(new Error('upstream hiccup'), { retryable: true });
            const out = path.join(outDir, 'flaky.txt');
            fs.writeFileSync(out, fs.readFileSync(files[0].path, 'utf8').toUpperCase());
            return { files: [{ path: out, name: 'flaky.txt', mime: 'text/plain' }] };
        },
    });
}
const flaky = new Set();

// ── A fake OpenVibe.Media (object API v2) ────────────────────
function fakeMedia() {
    const objects = new Map();
    const app = express();
    const state = { failInit: false, deleted: [] };
    app.use(express.json());
    const authed = (req, res, next) => (req.headers.authorization === 'Bearer media-token' ? next() : res.status(401).json({ error: 'no' }));
    app.post('/api/v2/tools/objects', authed, (req, res) => {
        if (state.failInit) return res.status(503).json({ code: 'down' });
        const id = `med_${contracts.ids.ulid()}`;
        objects.set(id, { id, meta: req.body, subject: req.headers['x-ov-subject'] || null, bytes: null, status: 'uploading' });
        res.status(201).json({ id, upload: { method: 'PUT', url: `https://openvibe.media/api/v2/tools/objects/${id}/content?token=tok-${id}` } });
    });
    app.put('/api/v2/tools/objects/:id/content', (req, res) => {
        const o = objects.get(req.params.id);
        if (!o || req.query.token !== `tok-${o.id}`) return res.status(401).json({ error: 'bad token' });
        const chunks = [];
        req.on('data', c => chunks.push(c)).on('end', () => { o.bytes = Buffer.concat(chunks); res.json({ id: o.id, size_bytes: o.bytes.length }); });
    });
    app.post('/api/v2/tools/objects/:id/complete', authed, (req, res) => {
        const o = objects.get(req.params.id);
        const sha = crypto.createHash('sha256').update(o.bytes).digest('hex');
        if (req.body.content_hash !== sha) return res.status(422).json({ code: 'media.object.hash_mismatch' });
        o.status = 'ready';
        res.json({ id: o.id, lifecycle_status: 'ready' });
    });
    app.get('/api/v2/tools/objects/:id/download', authed, (req, res) => res.json({ url: `https://openvibe.media/o/${req.params.id}?exp=1&sig=s`, expires_at: 'x', public: false }));
    app.delete('/api/v2/tools/objects/:id', authed, (req, res) => { state.deleted.push(req.params.id); objects.delete(req.params.id); res.json({ ok: true }); });
    app.get('/o/:id', (req, res) => { const o = objects.get(req.params.id); if (!o || req.query.sig !== 's') return res.status(404).end(); res.type('text/plain').send(o.bytes); });
    return { app, objects, state };
}
const fakeTokens = { authHeaders: async () => ({ Authorization: 'Bearer media-token' }), invalidate() {} };

// ── A satellite: express + the job routes over one SQLite file ──
function satellite(dir, { concurrency = 2, media = null, maxActivePerOwner = 10 } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const db = new Database(path.join(dir, 'jobs.db'));
    const system = jobs.createJobSystem({ db, contracts, service: 'test', dataDir: dir, concurrency, media, maxActivePerOwner, progressThrottleMs: 0, log: { log() {}, warn() {}, error() {} } });
    define(system);
    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    app.use((req, _res, next) => { if (req.headers['x-test-user']) req.user = { sub: 7, subject_id: req.headers['x-test-user'] }; next(); });
    const multer = dep('multer');
    const upload = multer({ dest: path.join(dir, 'tmp') });
    const resolveOwner = jobs.createOwnerResolver({ contracts, getPublicKey: () => publicKey, issuer: ISSUER, secureCookie: false });
    jobs.mountJobRoutes(app, { system, contracts, resolveOwner, receive: upload.any() });
    system.start();
    return new Promise(resolve => {
        const server = app.listen(0, '127.0.0.1', () => resolve({
            system, db, base: `http://127.0.0.1:${server.address().port}`,
            close: () => new Promise(r => { system.stop(); server.closeAllConnections(); server.close(() => { db.close(); r(); }); }),
        }));
    });
}

/** A browser-ish client with its own cookie jar (the jobs session cookie). */
function client(base, { user, bearer } = {}) {
    let cookie = '';
    return async function call(p, init = {}) {
        const headers = { ...(init.headers || {}) };
        if (cookie) headers.cookie = cookie;
        if (user) headers['x-test-user'] = user;
        if (bearer) headers.authorization = `Bearer ${bearer}`;
        const res = await fetch((typeof base === 'function' ? base() : base) + p, { ...init, headers, redirect: 'manual' });
        const set = res.headers.get('set-cookie');
        if (set) cookie = set.split(';')[0];
        const type = res.headers.get('content-type') || '';
        const body = /json/.test(type) ? await res.json() : await res.text();
        return { status: res.status, headers: res.headers, body };
    };
}
const json = (body, headers = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

/** Read an SSE stream until `stop(events)` or the server ends it. */
async function readSse(url, { headers = {}, stop = () => false, ms = 5000 } = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    const res = await fetch(url, { headers, signal: ac.signal });
    const events = [];
    if (res.status !== 200) { clearTimeout(timer); return { status: res.status, events }; }
    const dec = new TextDecoder();
    let buf = '';
    try {
        for await (const chunk of res.body) {
            buf += dec.decode(chunk, { stream: true });
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
                const frame = buf.slice(0, i); buf = buf.slice(i + 2);
                const e = {};
                for (const line of frame.split('\n')) { const m = /^(id|event|data): (.*)$/.exec(line); if (m) e[m[1]] = m[2]; }
                if (e.data) { e.data = JSON.parse(e.data); e.id = Number(e.id); events.push(e); }
            }
            if (stop(events)) break;
        }
    } catch (err) { if (err.name !== 'AbortError') throw err; }
    clearTimeout(timer); ac.abort();
    return { status: res.status, events };
}

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-jobs-'));
    try {
        // ── Submit, reattach by id, result download ─────────────
        let s = await satellite(path.join(root, 'a'));
        const alice = client(s.base, { user: USER_A });
        let r = await alice('/api/v1/jobs', json({ type: 'test.upper', input: { text: 'hello' } }));
        assert.strictEqual(r.status, 202, 'accepted');
        assert.match(r.body.id, /^job_[0-9A-Z]{26}$/);
        assert.strictEqual(r.headers.get('location'), `/api/v1/jobs/${r.body.id}`);
        const first = r.body.id;
        const done = await until(async () => { const g = await alice(`/api/v1/jobs/${first}`); return g.body.state === 'succeeded' && g.body; }, 'first job');
        assert.strictEqual(done.result.data.length, 5);
        assert.strictEqual(done.result.files[0].storage, 'local');
        assert.ok(done.expires_at && done.finished_at, 'a finished job says when it expires');
        r = await alice(done.result.files[0].url);
        assert.strictEqual(r.body, 'HELLO');
        assert.match(r.headers.get('content-disposition'), /^attachment; filename="upper.txt"/);

        // Multipart with a file (the way the UI submits).
        const fd = new FormData();
        fd.append('type', 'test.upper'); fd.append('input', '{}');
        fd.append('file', new Blob(['from a file']), 'in.txt');
        r = await alice('/api/v1/jobs', { method: 'POST', body: fd });
        assert.strictEqual(r.status, 202);
        const multi = await until(async () => { const g = await alice(`/api/v1/jobs/${r.body.id}`); return g.body.state === 'succeeded' && g.body; }, 'multipart job');
        assert.strictEqual((await alice(multi.result.files[0].url)).body, 'FROM A FILE');

        // Validation and tool failures are problem+json.
        r = await alice('/api/v1/jobs', json({ type: 'nope', input: {} }));
        assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'tools.job.unknown_type'); assert.match(r.headers.get('content-type'), /problem\+json/);
        r = await alice('/api/v1/jobs', json({ type: 'test.upper', input: { text: 5 } }));
        assert.strictEqual(r.body.code, 'tools.job.invalid');
        r = await alice('/api/v1/jobs', json({ type: 'test.boom' }));
        const boom = await until(async () => { const g = await alice(`/api/v1/jobs/${r.body.id}`); return g.body.state === 'failed' && g.body; }, 'failed job');
        assert.strictEqual(boom.error.code, 'tools.job.failed');
        assert.ok(!/srv\/secret/.test(boom.error.detail), 'server paths are not shown to people');

        // ── Idempotency ─────────────────────────────────────────
        r = await alice('/api/v1/jobs', json({ type: 'test.upper', input: { text: 'once' } }, { 'idempotency-key': 'key-000000001' }));
        const once = r.body.id;
        assert.strictEqual(r.status, 202);
        r = await alice('/api/v1/jobs', json({ type: 'test.upper', input: { text: 'once' } }, { 'idempotency-key': 'key-000000001' }));
        assert.strictEqual(r.status, 200); assert.strictEqual(r.body.id, once, 'same key, same request → same job');
        assert.strictEqual(r.headers.get('idempotent-replayed'), 'true');
        r = await alice('/api/v1/jobs', json({ type: 'test.upper', input: { text: 'twice' } }, { 'idempotency-key': 'key-000000001' }));
        assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'tools.job.idempotency_conflict');
        r = await client(s.base, { user: USER_B })('/api/v1/jobs', json({ type: 'test.upper', input: { text: 'once' } }, { 'idempotency-key': 'key-000000001' }));
        assert.strictEqual(r.status, 202); assert.notStrictEqual(r.body.id, once, 'keys are per owner');

        // ── Owner scoping ───────────────────────────────────────
        const bob = client(s.base, { user: USER_B });
        const guest1 = client(s.base), guest2 = client(s.base), nobody = client(s.base);
        for (const who of [bob, guest1, nobody]) {
            assert.strictEqual((await who(`/api/v1/jobs/${first}`)).status, 404);
            assert.strictEqual((await who(`/api/v1/jobs/${first}`, { method: 'DELETE' })).status, 404);
            assert.strictEqual((await who(`/api/v1/jobs/${first}/events`)).status, 404);
            assert.strictEqual((await who(`/api/v1/jobs/${first}/files/0`)).status, 404);
        }
        r = await guest1('/api/v1/jobs', json({ type: 'test.upper', input: { text: 'guest' } }));
        assert.strictEqual(r.status, 202);
        const guestJob = r.body.id;
        assert.strictEqual((await guest1(`/api/v1/jobs/${guestJob}`)).status, 200, 'the session that made it can reattach');
        assert.strictEqual((await guest2(`/api/v1/jobs/${guestJob}`)).status, 404, 'another browser cannot');
        assert.strictEqual((await alice(`/api/v1/jobs/${guestJob}`)).status, 404, 'nor can a signed-in stranger');
        assert.ok(s.db.prepare('SELECT owner FROM tool_jobs').all().every(x => /^(user:usr_[0-9A-Z]{26}|session:[0-9a-f]{40})$/.test(x.owner)), 'owners are canonical subjects or hashed sessions, never raw cookies');

        // ── SSE: events carry ids; Last-Event-ID resumes after them ──
        const all = await readSse(`${s.base}/api/v1/jobs/${first}/events`, { headers: { 'x-test-user': USER_A } });
        assert.strictEqual(all.status, 200);
        assert.deepStrictEqual(all.events.map(e => e.event), ['job.queued', 'job.running', 'job.progress', 'job.progress', 'job.succeeded']);
        assert.ok(all.events.every((e, i) => i === 0 || e.id > all.events[i - 1].id), 'ids increase');
        const resumed = await readSse(`${s.base}/api/v1/jobs/${first}/events`, { headers: { 'x-test-user': USER_A, 'last-event-id': String(all.events[2].id) } });
        assert.deepStrictEqual(resumed.events.map(e => e.id), all.events.slice(3).map(e => e.id), 'only what came after Last-Event-ID');
        const caughtUp = await readSse(`${s.base}/api/v1/jobs/${first}/events?last_event_id=${all.events[4].id}`, { headers: { 'x-test-user': USER_A } });
        assert.strictEqual(caughtUp.status, 204, 'finished and nothing new: 204 stops EventSource reconnecting');
        // Live: a stream opened on a running job sees the rest as it happens.
        r = await alice('/api/v1/jobs', json({ type: 'test.upper', input: { text: 'live', gate: 'live' } }));
        const liveId = r.body.id;
        await until(async () => (await alice(`/api/v1/jobs/${liveId}`)).body.state === 'running', 'live job running');
        const streaming = readSse(`${s.base}/api/v1/jobs/${liveId}/events`, { headers: { 'x-test-user': USER_A } });
        await sleep(100);
        gate('live').open();
        const live = await streaming;
        assert.strictEqual(live.events[live.events.length - 1].event, 'job.succeeded');
        assert.strictEqual(live.events[live.events.length - 1].data.result.files.length, 1, 'the terminal event carries the result');

        // ── Cancel ──────────────────────────────────────────────
        await s.close();
        s = await satellite(path.join(root, 'b'), { concurrency: 1 });
        const carol = client(s.base, { user: USER_A });
        const blocker = (await carol('/api/v1/jobs', json({ type: 'test.upper', input: { gate: 'block' } }))).body.id;
        const waiting = (await carol('/api/v1/jobs', json({ type: 'test.upper', input: { text: 'later' } }))).body.id;
        await until(async () => (await carol(`/api/v1/jobs/${blocker}`)).body.state === 'running', 'blocker running');
        assert.strictEqual((await carol(`/api/v1/jobs/${waiting}`)).body.state, 'queued', 'concurrency 1: the second job waits');
        r = await carol(`/api/v1/jobs/${waiting}`, { method: 'DELETE' });
        assert.strictEqual(r.status, 200); assert.strictEqual(r.body.state, 'cancelled', 'a queued job is cancelled at once');
        r = await carol(`/api/v1/jobs/${blocker}`, { method: 'DELETE' });
        assert.strictEqual(r.status, 202); assert.strictEqual(r.body.cancel_requested, true, 'a running job is signalled');
        const cancelled = await until(async () => { const g = await carol(`/api/v1/jobs/${blocker}`); return g.body.state === 'cancelled' && g.body; }, 'running job cancelled');
        assert.strictEqual(cancelled.error.code, 'tools.job.cancelled');
        assert.strictEqual((await carol(`/api/v1/jobs/${blocker}`, { method: 'DELETE' })).status, 200, 'cancelling twice is fine');
        const fin = (await carol('/api/v1/jobs', json({ type: 'test.upper', input: { text: 'x' } }))).body.id;
        await until(async () => (await carol(`/api/v1/jobs/${fin}`)).body.state === 'succeeded', 'job to finish');
        r = await carol(`/api/v1/jobs/${fin}`, { method: 'DELETE' });
        assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'tools.job.already_finished');

        // ── Bounded concurrency and the per-owner cap ───────────
        await s.close();
        s = await satellite(path.join(root, 'c'), { concurrency: 2, maxActivePerOwner: 4 });
        const dave = client(s.base, { user: USER_B });
        const ids = [];
        for (let i = 0; i < 4; i++) ids.push((await dave('/api/v1/jobs', json({ type: 'test.upper', input: { gate: 'pool' } }))).body.id);
        await until(async () => s.system.stats().running === 2, 'two running');
        await sleep(50);
        assert.strictEqual(s.system.stats().running, 2, 'never more than the concurrency limit');
        assert.strictEqual(s.system.stats().queued, 2);
        r = await dave('/api/v1/jobs', json({ type: 'test.upper', input: { text: 'one too many' } }));
        assert.strictEqual(r.status, 429); assert.strictEqual(r.body.code, 'tools.job.too_many_active');
        gate('pool').open();
        await until(async () => s.system.stats().succeeded === 4, 'pool drained');

        // ── Restart: an accepted job is not lost ────────────────
        await s.close();
        const dir = path.join(root, 'd');
        s = await satellite(dir, { concurrency: 0 });    // accepts, runs nothing: every job stays queued
        const erin = client(() => s.base, { user: USER_A });   // follows the satellite across restarts
        const fd2 = new FormData();
        fd2.append('type', 'test.upper'); fd2.append('input', '{}'); fd2.append('file', new Blob(['survives']), 'keep.txt');
        r = await erin('/api/v1/jobs', { method: 'POST', body: fd2 });
        assert.strictEqual(r.status, 202);
        const accepted = r.body.id;
        await s.close();                                   // DB and app closed: the process is gone
        s = await satellite(dir, { concurrency: 2 });      // and back
        const back = await until(async () => { const g = await erin(`/api/v1/jobs/${accepted}`); return g.body.state === 'succeeded' && g.body; }, 'accepted job after restart');
        assert.strictEqual((await erin(back.result.files[0].url)).body, 'SURVIVES', 'its uploaded input survived too');

        // Running when the process died: re-queued (test.upper) or failed-retryable (test.fragile).
        const again = (await erin('/api/v1/jobs', json({ type: 'test.upper', input: { text: 'rerun', gate: 'never-1' } }))).body.id;
        const fragile = (await erin('/api/v1/jobs', json({ type: 'test.fragile', input: { gate: 'never-2' } }))).body.id;
        await until(async () => (await erin(`/api/v1/jobs/${again}`)).body.state === 'running' && (await erin(`/api/v1/jobs/${fragile}`)).body.state === 'running', 'both running');
        await s.close();
        gates.get('never-1').open();                       // the gate is open after the restart
        s = await satellite(dir, { concurrency: 2 });
        const rerun = await until(async () => { const g = await erin(`/api/v1/jobs/${again}`); return g.body.state === 'succeeded' && g.body; }, 're-queued job');
        assert.strictEqual(rerun.attempts, 2, 'the interrupted attempt counts');
        const broken = (await erin(`/api/v1/jobs/${fragile}`)).body;
        assert.strictEqual(broken.state, 'failed');
        assert.strictEqual(broken.retryable, true);
        assert.strictEqual(broken.error.code, 'tools.job.interrupted');
        const history = await readSse(`${s.base}/api/v1/jobs/${again}/events`, { headers: { 'x-test-user': USER_A } });
        assert.deepStrictEqual(history.events.map(e => e.event).filter(e => e !== 'job.progress'), ['job.queued', 'job.running', 'job.queued', 'job.running', 'job.succeeded'], 'the event log spans the restart');

        // ── Pruning ─────────────────────────────────────────────
        const pruned = await s.system.prune(Date.now() + 25 * 60 * 60 * 1000);
        assert.ok(pruned >= 3);
        assert.strictEqual((await erin(`/api/v1/jobs/${accepted}`)).status, 404, 'expired jobs are gone');
        assert.ok(!fs.existsSync(path.join(dir, 'jobs', accepted)), 'with their files');
        assert.strictEqual(s.db.prepare('SELECT COUNT(*) AS n FROM tool_job_events WHERE job_id = ?').get(accepted).n, 0, 'and their events');
        await s.close();

        // ── Results as Media objects ────────────────────────────
        const fm = fakeMedia();
        const mediaServer = await new Promise(res => { const srv = fm.app.listen(0, '127.0.0.1', () => res(srv)); });
        const media = jobs.createMediaResults({ internalUrl: `http://127.0.0.1:${mediaServer.address().port}`, tokens: fakeTokens });
        s = await satellite(path.join(root, 'e'), { media });
        const frank = client(s.base, { user: USER_B });
        r = await frank('/api/v1/jobs', json({ type: 'test.upper', input: { text: 'stored in media' } }));
        const m = await until(async () => { const g = await frank(`/api/v1/jobs/${r.body.id}`); return g.body.state === 'succeeded' && g.body; }, 'media job');
        const f0 = m.result.files[0];
        assert.strictEqual(f0.storage, 'media');
        assert.match(f0.media.media_id, /^med_[0-9A-Z]{26}$/, 'the result is a Media object reference');
        const obj = fm.objects.get(f0.media.media_id);
        assert.strictEqual(obj.status, 'ready');
        assert.strictEqual(obj.subject, USER_B, 'owned by the person who ran the job');
        assert.strictEqual(obj.meta.visibility, 'private');
        assert.strictEqual(obj.meta.metadata.job_id, m.id);
        assert.ok(!fs.existsSync(path.join(root, 'e', 'jobs', m.id, 'out', '0-upper.txt')), 'no local copy is kept');
        r = await frank(`${f0.url}?inline=1`);
        assert.strictEqual(r.status, 302); assert.match(r.headers.get('location'), /^https:\/\/openvibe\.media\/o\/med_/, 'previews load from Media');
        r = await frank(f0.url);
        assert.strictEqual(r.body, 'STORED IN MEDIA', 'downloads stream through with the right name');
        assert.match(r.headers.get('content-disposition'), /attachment/);
        // Media down: the result stays local and says so.
        fm.state.failInit = true;
        r = await frank('/api/v1/jobs', json({ type: 'test.upper', input: { text: 'fallback' } }));
        const fb = await until(async () => { const g = await frank(`/api/v1/jobs/${r.body.id}`); return g.body.state === 'succeeded' && g.body; }, 'fallback job');
        assert.strictEqual(fb.result.files[0].storage, 'local');
        assert.ok(fb.result.files[0].media_error);
        assert.strictEqual((await frank(fb.result.files[0].url)).body, 'FALLBACK');
        await s.system.prune(Date.now() + 25 * 60 * 60 * 1000);
        assert.ok(fm.state.deleted.includes(f0.media.media_id), 'pruning deletes the Media object');
        await s.close();
        mediaServer.close();

        // ── Retry a failed job ──────────────────────────────────
        s = await satellite(path.join(root, 'h'));
        const hal = client(s.base, { user: USER_B });
        flaky.add('t1');
        const fd3 = new FormData();
        fd3.append('type', 'test.flaky'); fd3.append('input', JSON.stringify({ tag: 't1' })); fd3.append('file', new Blob(['retry me']), 'in.txt');
        const failedId = (await hal('/api/v1/jobs', { method: 'POST', body: fd3 })).body.id;
        const failedJob = await until(async () => { const g = await hal(`/api/v1/jobs/${failedId}`); return g.body.state === 'failed' && g.body; }, 'flaky job fails');
        assert.strictEqual(failedJob.links.retry, `/api/v1/jobs/${failedId}/retry`);
        assert.ok(fs.readdirSync(path.join(root, 'h', 'jobs', failedId, 'in')).length === 1, 'a failed job keeps its input for a retry');
        assert.strictEqual((await client(s.base, { user: USER_A })(`/api/v1/jobs/${failedId}/retry`, { method: 'POST' })).status, 404, 'only the owner can retry');
        flaky.delete('t1');
        // Two retries at once: one new job, and the other call gets the same one.
        const [ra, rb] = await Promise.all([hal(`/api/v1/jobs/${failedId}/retry`, { method: 'POST' }), hal(`/api/v1/jobs/${failedId}/retry`, { method: 'POST' })]);
        assert.deepStrictEqual([ra.status, rb.status].sort(), [200, 202]);
        assert.strictEqual(ra.body.id, rb.body.id, 'retrying is idempotent');
        const retried = ra.body.id;
        assert.notStrictEqual(retried, failedId);
        assert.strictEqual((ra.status === 202 ? ra : rb).headers.get('location'), `/api/v1/jobs/${retried}`);
        assert.strictEqual((ra.status === 200 ? ra : rb).headers.get('idempotent-replayed'), 'true');
        assert.strictEqual(ra.body.retry_of, failedId);
        const ok = await until(async () => { const g = await hal(`/api/v1/jobs/${retried}`); return g.body.state === 'succeeded' && g.body; }, 'retry succeeds');
        assert.strictEqual((await hal(ok.result.files[0].url)).body, 'RETRY ME', 'the retry ran on the original input');
        const old = (await hal(`/api/v1/jobs/${failedId}`)).body;
        assert.strictEqual(old.state, 'failed', 'the failed job stays failed');
        assert.strictEqual(old.retried_by, retried);
        r = await hal(`/api/v1/jobs/${failedId}/retry`, { method: 'POST' });
        assert.strictEqual(r.status, 200); assert.strictEqual(r.body.id, retried, 'asking again later still answers with the same retry');
        r = await hal(`/api/v1/jobs/${retried}/retry`, { method: 'POST' });
        assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'tools.job.not_failed', 'only failed jobs can be retried');
        const running = (await hal('/api/v1/jobs', json({ type: 'test.upper', input: { gate: 'retry-running' } }))).body.id;
        await until(async () => (await hal(`/api/v1/jobs/${running}`)).body.state === 'running', 'running job');
        assert.strictEqual((await hal(`/api/v1/jobs/${running}/retry`, { method: 'POST' })).body.code, 'tools.job.not_failed');
        gate('retry-running').open();
        // A failed job whose inputs are gone cannot be retried.
        flaky.add('t2');
        const fd4 = new FormData();
        fd4.append('type', 'test.flaky'); fd4.append('input', JSON.stringify({ tag: 't2' })); fd4.append('file', new Blob(['x']), 'x.txt');
        const lost = (await hal('/api/v1/jobs', { method: 'POST', body: fd4 })).body.id;
        await until(async () => (await hal(`/api/v1/jobs/${lost}`)).body.state === 'failed', 'second flaky job fails');
        fs.rmSync(path.join(root, 'h', 'jobs', lost, 'in'), { recursive: true, force: true });
        r = await hal(`/api/v1/jobs/${lost}/retry`, { method: 'POST' });
        assert.strictEqual(r.status, 410); assert.strictEqual(r.body.code, 'tools.job.inputs_gone');
        assert.strictEqual((await hal(`/api/v1/jobs/${lost}`)).body.retried_by, null, 'a refused retry changes nothing');
        await s.close();

        // ── Service/app principals (tools.job.* capabilities) ───
        s = await satellite(path.join(root, 'f'));
        const token = (claims) => contracts.serviceAuth.signServiceToken({
            iss: ISSUER, sub: 'app:app_01JCCCCCCCCCCCCCCCCCCCCCCC', actor_type: 'app', aud: ['openvibe.tools'], project_id: 'prj_01JCCCCCCCCCCCCCCCCCCCCCCC', env: 'production',
            cap: ['tools.job.create', 'tools.job.read'], iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, jti: crypto.randomBytes(8).toString('hex'), ...claims,
        }, privateKey);
        const dev = client(s.base, { bearer: token({}) });
        r = await dev('/api/v1/jobs', json({ type: 'test.upper', input: { text: 'sdk' } }));
        assert.strictEqual(r.status, 202, 'an app with tools.job.create can submit');
        assert.strictEqual(r.headers.get('set-cookie'), null, 'principals get no session cookie');
        const devJob = r.body.id;
        await until(async () => (await dev(`/api/v1/jobs/${devJob}`)).body.state === 'succeeded', 'app job');
        assert.strictEqual(s.system.get(devJob).owner, 'app:app_01JCCCCCCCCCCCCCCCCCCCCCCC');
        r = await dev(`/api/v1/jobs/${devJob}`, { method: 'DELETE' });
        assert.strictEqual(r.status, 403, 'cancel needs tools.job.cancel');
        r = await client(s.base, { bearer: token({ cap: ['tools.job.read'] }) })('/api/v1/jobs', json({ type: 'test.upper', input: {} }));
        assert.strictEqual(r.status, 403); assert.strictEqual(r.body.code, 'capability.denied');
        r = await client(s.base, { bearer: token({ aud: ['openvibe.media'] }) })('/api/v1/jobs', json({ type: 'test.upper', input: {} }));
        assert.strictEqual(r.status, 401); assert.strictEqual(r.body.code, 'token.wrong_audience');
        r = await client(s.base, { bearer: token({ sub: 'app:app_01JDDDDDDDDDDDDDDDDDDDDDDD' }) })(`/api/v1/jobs/${devJob}`);
        assert.strictEqual(r.status, 404, 'another app cannot read it');

        // ── Developer-app sandbox (ADR-014): only apps, kept apart, never sent to Media ───
        const sbx = client(s.base, { bearer: token({ env: 'sandbox', cap: ['tools.job.create', 'tools.job.read', 'tools.job.cancel'] }) });
        r = await sbx('/api/v1/jobs', json({ type: 'test.upper', input: { text: 'sandbox' } }));
        assert.strictEqual(r.status, 202, 'a sandbox app token can submit');
        const sbxJob = r.body.id;
        await until(async () => (await sbx(`/api/v1/jobs/${sbxJob}`)).body.state === 'succeeded', 'sandbox job');
        assert.strictEqual(s.system.get(sbxJob).env, 'sandbox', 'the job remembers its environment');
        assert.ok(s.system.get(sbxJob).ttl_ms <= 30 * 60 * 1000, 'sandbox jobs are kept briefly');
        r = await client(s.base, { bearer: token({ sub: 'app:app_01JDDDDDDDDDDDDDDDDDDDDDDD', env: 'sandbox' }) })(`/api/v1/jobs/${sbxJob}`);
        assert.strictEqual(r.status, 404, 'another sandbox app cannot read it');
        r = await client(s.base, { bearer: contracts.serviceAuth.signServiceToken({
            iss: ISSUER, sub: 'svc:live', actor_type: 'service', aud: ['openvibe.tools'], cap: ['tools.job.create'], env: 'sandbox',
            iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, jti: crypto.randomBytes(8).toString('hex'),
        }, privateKey) })('/api/v1/jobs', json({ type: 'test.upper', input: {} }));
        assert.strictEqual(r.status, 401, 'a sandbox token that is not an app is refused'); assert.strictEqual(r.body.code, 'token.sandbox_refused');
        await s.close();

        console.log('jobs (shared runtime): all checks passed');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exit(1); });
