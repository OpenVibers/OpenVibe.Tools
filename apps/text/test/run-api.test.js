'use strict';
// The run API for the text tools, end to end: POST /api/v1/tools/:id/run (tools.run-request@1 →
// tools.run@1, ADR-027). The text satellite serves the registry (tools-api.test.js); the tools with
// execution 'client' and api true are run by the gateway, which loads this app's engines
// (apps/text/server/engines.js) in its engine pool (apps/gateway/server/run). This starts the gateway
// the way its server entry runs it (apps/_shared/test/spawn) and checks:
//   • a valid run answers tools.run@1: { state: succeeded, tool, result: { text } | { data } }, and a
//     pure transform's second call is a cache hit
//   • input that does not match the tool's schema is a 422 problem+json with errors[], input over the
//     tool's byte limit a 413, an unknown id a 404 and a page-only tool a 404 not_runnable
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startApp } = require('../../_shared/test/spawn');
const contracts = require(require.resolve('openvibe-contracts', { paths: [path.join(__dirname, '..', '..', 'gateway')] }));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-text-run-'));
let ip = 1;
const freshIp = () => `198.51.${(ip >> 8) & 255}.${ip++ & 255}`;

(async () => {
    const gw = await startApp('gateway', {
        DATA_DIR: path.join(tmp, 'gw'),
        OV_DOMAINS_URL: 'http://127.0.0.1:9/api/domains',
        OV_REGISTRY_URL: 'http://127.0.0.1:9/registry',
    });
    const call = async (p, opts = {}) => {
        const { headers = {}, ...rest } = opts;
        const r = await fetch(`${gw.base}${p}`, { ...rest, headers: { 'X-Forwarded-For': freshIp(), ...headers } });
        const text = await r.text();
        let body = null;
        try { body = JSON.parse(text); } catch { /* not JSON */ }
        return { status: r.status, headers: r.headers, text, body };
    };
    const run = (id, request) => call(`/api/v1/tools/${id}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
    const problem = (r, status, code) => {
        assert.strictEqual(r.status, status, `${r.text.slice(0, 250)}`);
        assert.match(r.headers.get('content-type') || '', /application\/problem\+json/);
        assert.strictEqual(r.body.code, code, r.text.slice(0, 250));
    };
    try {
        // ── A valid run: a tool that answers JSON data ──
        let r = await run('count', { input: { text: 'two words' } });
        assert.strictEqual(r.status, 200, r.text.slice(0, 250));
        const valid = contracts.validate('tools.run@1', r.body);
        assert.ok(valid.valid, `tools.run@1: ${JSON.stringify(valid.errors && valid.errors.slice(0, 3))}`);
        assert.strictEqual(r.body.state, 'succeeded');
        assert.strictEqual(r.body.tool, 'count');
        assert.strictEqual(r.body.result.data.words, 2);
        assert.ok(!('text' in r.body.result), 'a json tool answers { data }, not { text }');
        assert.ok(Number.isInteger(r.body.took_ms));
        assert.strictEqual(r.headers.get('cache-control'), 'no-store');
        // The same pure transform again is answered from the cache.
        r = await run('count', { input: { text: 'two words' } });
        assert.strictEqual(r.headers.get('x-ov-cache'), 'hit', 'a pure transform is cached');

        // ── A valid run: a tool that answers text ──
        r = await run('morse', { input: { text: 'SOS' } });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.result.text, '... --- ...');
        assert.ok(!('data' in r.body.result), 'a text tool answers { text }, not { data }');

        // ── The input schema is enforced before the tool runs ──
        r = await run('ascii', { input: {} });
        problem(r, 422, 'tools.input.invalid');
        assert.deepStrictEqual(r.body.errors, [{ path: '/text', message: 'is required' }], 'errors[] names the missing field');
        r = await run('ascii', { input: { text: 'x'.repeat(2000) } });
        problem(r, 413, 'tools.input.too_large');
        assert.ok(!/sk-live|maps\.internal/.test(r.text));

        // ── An unknown tool, and a tool whose page only exists ──
        problem(await run('nosuchtool', { input: {} }), 404, 'tools.tool.not_found');
        problem(await run('logo', { input: {} }), 404, 'tools.tool.not_runnable');

        // ── Only POST runs a tool ──
        r = await call('/api/v1/tools/count/run', { method: 'GET' });
        assert.strictEqual(r.status, 405, r.text.slice(0, 200));
        assert.strictEqual(r.body.code, 'method_not_allowed');
    } finally {
        await gw.kill();
    }
    console.log('text run API: a valid run is tools.run@1, bad input is 422/413, an unknown or page-only tool is 404');
})().catch((err) => { console.error(err); process.exit(1); });
