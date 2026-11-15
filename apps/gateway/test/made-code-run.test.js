'use strict';
// Code tools on machines (plan 2026-11-13 §AD.13 (2); made/run-code.js): a made code tool runs as an OpenVibe.Run
// function job on the skill runner (openvibe-skill-runner@1.1.0, OpenVibe.Link v0.70.0):
//   - the job carries the tool's entry and its SHA-256 (the digest the tool names), the runner's tool name, the input,
//     the tool's network as the job's egress (none by default) and the trust its hosting allows; it goes as OpenVibe's
//     operator (X-OV-Subject, X-OV-Project), and the run waits for the job and answers its output ({ data } or { text });
//   - a failed tool, an expired job (no machine free) and a job that takes too long fail in words; hosting mine says it
//     waits for a person's own project; without Run set up a code tool is still the page's alone (501);
//   - through the API (POST /api/v1/made-tools/:id/run), a code tool now runs, and its answer is checked against its
//     output schema; a code tool can take a trigger once code tools run on machines.
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const { createDb } = require('openvibe-sdk/db');
const { openToolsDb } = require('../../_shared/db');
const { ajvFrom } = require('../../_shared/tools/run');
const { createMadeTools } = require('../server/made/store');
const { createMadeToolRoutes } = require('../server/made/routes');
const { createCodeRunner, toolName } = require('../server/made/run-code');
const { entryOf } = require('../server/made/code');

const OPERATOR = 'usr_01JCZ3NDEKTSV4RRFFQ69G5FA0';
const PROJECT = 'prj_01JCZ3NDEKTSV4RRFFQ69G5FA0';
const ADA = 'usr_01JCZ3NDEKTSV4RRFFQ69G5FAW';
const SRC = "function run(input) {\n  return { words: String(input.text || '').split(/\\s+/).filter(Boolean).length };\n}\n";

(async () => {
    assert.strictEqual(toolName('word-count'), 'word_count');
    assert.strictEqual(toolName('9lives'), 'lives');

    // A Run that takes the job, places it, then answers what the runner wrote.
    const jobs = [];
    let mode = 'ok';
    const run = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            const json = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
            if (req.method === 'POST' && req.url === '/api/v1/jobs') {
                const b = JSON.parse(body);
                jobs.push({ body: b, headers: req.headers, reads: 0 });
                return json(201, { job: { id: `job_${jobs.length}`, state: 'queued' }, created: true });
            }
            const m = /^\/api\/v1\/jobs\/job_(\d+)$/.exec(req.url);
            if (m) {
                const j = jobs[Number(m[1]) - 1];
                j.reads++;
                if (mode === 'slow') return json(200, { id: `job_${m[1]}`, state: 'queued' });
                if (j.reads < 2) return json(200, { id: `job_${m[1]}`, state: 'running' });
                if (mode === 'expired') return json(200, { id: `job_${m[1]}`, state: 'expired' });
                const args = j.body.args;
                const ok = (mode === 'ok' || mode === 'text') && crypto.createHash('sha256').update(args.source).digest('hex') === args.sha256;
                const words = String(args.input.text || '').split(/\s+/).filter(Boolean).length;
                // run.job-read-result@1: the job itself, not wrapped (production showed it, 11-15).
                return json(200, { id: `job_${m[1]}`, state: 'succeeded', result: ok ? { ok: true, output: mode === 'text' ? `${words} words` : { words }, exit: 0 } : { ok: false, error: 'the tool exited with code 1', exit: 1, stderr: 'TypeError: boom' } });
            }
            json(404, {});
        });
    }).listen(0, '127.0.0.1');
    await new Promise((ok) => run.once('listening', ok));
    const runUrl = `http://127.0.0.1:${run.address().port}`;
    const tokens = { authHeaders: async () => ({ Authorization: 'Bearer svc-tools' }) };
    const runner = createCodeRunner({ runUrl, tokens, subject: OPERATOR, project: PROJECT, pollMs: 20, waitMs: 2000 });
    assert.strictEqual(runner.enabled, true);
    assert.strictEqual(createCodeRunner({ runUrl, tokens, subject: '', project: PROJECT }).enabled, false, 'no operator, no runs');

    const entry = entryOf(SRC);
    const sha = crypto.createHash('sha256').update(entry).digest('hex');
    const tool = { id: 'mtl_01JCZ3NDEKTSV4RRFFQ69G5FA1', slug: 'word-count', kind: 'code', net: 'deny', hosting: 'openvibe', code: { sha256: sha }, output: { kind: 'json' } };
    const out = await runner.run(tool, SRC, { text: 'one two three' });
    assert.deepStrictEqual(out.data, { words: 3 });
    const j = jobs[0];
    assert.deepStrictEqual([j.body.class, j.body.artifact, j.body.args.tool, j.body.args.sha256, j.body.args.source, j.body.egress, j.body.requirements.trust],
        ['function', { name: 'openvibe-skill-runner', version: '1.1.0' }, 'word_count', sha, entry, 'none', ['first-party', 'user-owned']], 'the job: the runner, the entry and its digest, no network, OpenVibe\'s machines');
    assert.deepStrictEqual([j.headers.authorization, j.headers['x-ov-subject'], j.headers['x-ov-project']], ['Bearer svc-tools', OPERATOR, PROJECT], 'as OpenVibe\'s operator');
    assert.ok(j.body.limits.wall_ms <= 30000 && j.body.limits.mem_bytes === 268435456);

    await runner.run({ ...tool, hosting: 'shared', net: 'public' }, SRC, { text: 'a' });
    assert.deepStrictEqual([jobs[1].body.egress, jobs[1].body.requirements.trust], ['public', ['first-party', 'user-owned', 'community']], 'shared: machines people lend too');
    mode = 'text';
    assert.deepStrictEqual(await runner.run({ ...tool, output: { kind: 'text' } }, SRC, { text: 'a b' }), { text: '2 words', job: 'job_3' });
    mode = 'fail';
    await assert.rejects(runner.run(tool, SRC, { text: 'x' }), (e) => e.status === 422 && /The code failed: the tool exited with code 1 \(TypeError: boom\)/.test(e.message));
    mode = 'expired';
    await assert.rejects(runner.run(tool, SRC, { text: 'x' }), (e) => e.code === 'tools.made.machine_failed' && /No machine/.test(e.message));
    mode = 'slow';
    await assert.rejects(runner.run(tool, SRC, { text: 'x' }), (e) => e.status === 504 && /No machine took the run in time/.test(e.message));
    await assert.rejects(runner.run({ ...tool, hosting: 'mine' }, SRC, {}), (e) => e.status === 501 && e.code === 'tools.made.mine_not_ready');
    await assert.rejects(runner.run({ ...tool, code: { sha256: 'f'.repeat(64) } }, SRC, {}), (e) => e.status === 409);
    mode = 'ok';

    // ── through the API: the code tool runs, its answer checked; it can take a trigger ──
    const { db, ready } = openToolsDb({ createDb, service: 'tools-test', log: { warn() {}, info() {}, log() {}, error() {} } });
    await ready;
    const store = createMadeTools({ db });
    const triggers = require('../server/made/triggers').createTriggers({ db, baseUrl: 'https://openvibe.tools' });
    const app = express();
    app.use(cookieParser());
    let server;
    app.use('/api/v1/made-tools', createMadeToolRoutes({
        store, runner: { run: async () => { throw new Error('no prompt runs here'); } }, origin: 'https://openvibe.tools', log: { error() {}, log() {} }, triggers, codeRunner: runner,
        verify: async (t) => (t === 'ada' ? { sub: ADA } : null), extractToken: (req) => (req.headers.authorization || '').replace(/^Bearer /, '') || null,
        ...ajvFrom(require), address: () => server.address(),
    }));
    server = http.createServer(app).listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api/v1/made-tools`;
    const call = async (method, path, body) => {
        const res = await fetch(base + path, { method, headers: { Authorization: 'Bearer ada', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    try {
        const made = await call('POST', '', { slug: 'word-count', name: 'Word count', summary: 'Counts words.', kind: 'code', input: { type: 'object', properties: { text: { type: 'string' } } }, output: { kind: 'json', schema: { type: 'object', required: ['words'], properties: { words: { type: 'number' } } } }, source_code: SRC });
        assert.strictEqual(made.status, 201, JSON.stringify(made.body));
        const ran = await call('POST', `/${made.body.id}/run`, { input: { text: 'the quick brown fox' } });
        assert.deepStrictEqual([ran.status, ran.body.state, ran.body.result], [200, 'succeeded', { data: { words: 4 } }], JSON.stringify(ran.body));
        assert.match(ran.body.job, /^job_\d+$/, 'the run names its Run job');
        mode = 'fail';
        const bad = await call('POST', `/${made.body.id}/run`, { input: { text: 'x' } });
        assert.deepStrictEqual([bad.status, bad.body.state, bad.body.error.code], [200, 'failed', 'tools.made.code_failed']);
        mode = 'ok';
        const trig = await call('POST', `/${made.body.id}/triggers`, { kind: 'link' });
        assert.strictEqual(trig.status, 201, 'a code tool takes a trigger once code tools run on machines');
    } finally {
        server.close(); run.close();
        await db.close();
    }
    console.log('made code run: Run function jobs on the skill runner as OpenVibe\'s operator (digest, egress, trust by hosting), answers and failures in words; through the API; triggers');
})().catch((err) => { console.error(err); process.exit(1); });
