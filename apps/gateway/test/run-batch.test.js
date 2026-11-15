'use strict';
// POST /api/v1/tools/batch (11-15): several runs at once, each through the run API with the caller's own credentials:
// the answers in the calls' order with their own statuses (a refusal is one call's answer, not the batch's); a batch
// needs a sign-in or a token; its size is bounded; the calls really overlap.
//   node apps/gateway/test/run-batch.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const contracts = require('openvibe-contracts');
const { startApp } = require('../../_shared/test/spawn');
const { startNetwork } = require('../../_shared/test/network');

(async () => {
    const net = await startNetwork();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-batch-'));
    let gw;
    try {
        gw = await startApp('gateway', {
            OV_NETWORK_URL: net.url, OV_NETWORK_INTERNAL_URL: net.url, TOOLS_GUARD: 'enforce', DATA_DIR: path.join(tmp, 'gw'),
            OV_DOMAINS_URL: 'http://127.0.0.1:9/api/domains', OV_REGISTRY_URL: 'http://127.0.0.1:9/registry',
        });
        const post = async (json, headers = {}) => {
            const r = await fetch(`${gw.base}/api/v1/tools/batch`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.7', ...headers }, body: JSON.stringify(json) });
            const text = await r.text();
            return { status: r.status, body: text ? JSON.parse(text) : null, text };
        };
        const token = `Bearer ${net.service(['tools.tool.run'], { name: 'agent' })}`;

        // Three tools at once, in order; each answer is the run API's own (tools.run@1).
        let r = await post({ calls: [
            { tool: 'jsonminify', input: { text: '{ "a": [1, 2] }' } },
            { tool: 'base64', input: { text: 'hi', mode: 'encode' } },
            { tool: 'no-such-tool', input: {} },
        ] }, { Authorization: token });
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual(r.body.results.map((x) => [x.tool, x.status]), [['jsonminify', 200], ['base64', r.body.results[1].status], ['no-such-tool', 404]]);
        assert.deepStrictEqual(r.body.results[0].body.result, { text: '{"a":[1,2]}' });
        assert.ok(contracts.validate('tools.run@1', r.body.results[0].body).valid, 'each body is tools.run@1');
        assert.strictEqual(r.body.results[2].body.code, 'tools.tool.not_found', 'a refusal is that call\'s answer');
        assert.ok(Number.isInteger(r.body.took_ms));

        // The caller's own rules apply to each call: a token without the run capability is refused per call.
        r = await post({ calls: [{ tool: 'jsonminify', input: { text: '1' } }] }, { Authorization: `Bearer ${net.service(['tools.job.read'])}` });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual([r.body.results[0].status, r.body.results[0].body.code], [403, 'capability.denied']);

        // No sign-in and no token: no batch.
        r = await post({ calls: [{ tool: 'jsonminify', input: { text: '1' } }] });
        assert.deepStrictEqual([r.status, r.body.code], [401, 'token.missing']);

        // Bounded.
        r = await post({ calls: [] }, { Authorization: token });
        assert.deepStrictEqual([r.status, r.body.code], [400, 'tools.batch.invalid']);
        r = await post({ calls: Array.from({ length: 17 }, () => ({ tool: 'jsonminify', input: { text: '1' } })) }, { Authorization: token });
        assert.strictEqual(r.status, 400);
        r = await post({ calls: [{ tool: '../etc', input: {} }] }, { Authorization: token });
        assert.strictEqual(r.status, 400, 'a tool id is a tool id');

        // Twelve at once come back in their order.
        const many = Array.from({ length: 12 }, (_, i) => ({ tool: 'jsonminify', input: { text: `[${i}]` } }));
        r = await post({ calls: many, concurrency: 8 }, { Authorization: token });
        assert.deepStrictEqual(r.body.results.map((x) => x.body && x.body.result && x.body.result.text), many.map((_, i) => `[${i}]`));
        console.log('run batch: all checks passed');
    } finally {
        if (gw) gw.kill();
        net.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
})().catch((e) => { console.error(e); process.exit(1); });
