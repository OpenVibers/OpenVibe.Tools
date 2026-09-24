'use strict';
/** tools.usage: page views and runs by signed-in people become their recent tools in the Network module, merged, deduplicated and capped. */
const assert = require('assert');
const { createRecorder, usagePages } = require('../usage');

const USR = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const modules = new Map();   // subject -> { data, revision }
let conflictOnce = false;
const calls = [];
const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    const reply = (status, body) => ({ status, ok: status < 300, json: async () => body });
    if (u.pathname === '/oauth/token') { calls.push('token'); return reply(200, { access_token: 'svc', expires_in: 300 }); }
    assert.strictEqual(opts.headers.Authorization, 'Bearer svc');
    const m = u.pathname.match(/^\/internal\/modules\/tools\.usage\/(usr_[0-9A-Z]+)$/);
    assert.ok(m, u.pathname);
    calls.push(`${opts.method}`);
    const rec = modules.get(m[1]);
    if (opts.method === 'GET') return rec ? reply(200, { namespace: 'tools.usage', ...rec }) : reply(404, { code: 'modules.not_found' });
    const want = opts.headers['If-Match'];
    if (conflictOnce) { conflictOnce = false; modules.set(m[1], { data: { recent: [{ tool: 'png', at: '2026-09-24T00:00:00.000Z' }] }, revision: 7 }); return reply(412, { code: 'modules.revision_mismatch' }); }
    if (rec && want !== `"${rec.revision}"`) return reply(412, { code: 'modules.revision_mismatch' });
    const data = JSON.parse(opts.body).data;
    modules.set(m[1], { data, revision: rec ? rec.revision + 1 : 1 });
    return reply(rec ? 200 : 201, { data });
};

(async () => {
    let t = Date.parse('2026-09-24T01:00:00Z');
    const r = createRecorder({ env: { OV_OAUTH_CLIENT_SECRET: 'x'.repeat(40), OV_NETWORK_INTERNAL_URL: 'http://network.test' }, fetchImpl, now: () => t, flushMs: 3_600_000 });
    assert.ok(r.record(USR, 'yaml'));
    assert.ok(!r.record(USR, 'yaml'), 'the same tool again within 10 minutes is not news');
    assert.ok(!r.record('42', 'yaml'), 'only a Network subject counts');
    assert.ok(!r.record(USR, '../etc'), 'only a tool id');
    t += 1000; r.record(USR, 'uuid');
    await r.flush();
    assert.deepStrictEqual(modules.get(USR).data.recent.map((e) => e.tool), ['uuid', 'yaml'], 'newest first');
    assert.strictEqual(calls.filter((c) => c === 'token').length, 1);

    t += 11 * 60 * 1000; r.record(USR, 'yaml');
    conflictOnce = true;
    await r.flush();
    assert.strictEqual(r.stats().conflicts, 1);
    assert.strictEqual(r.stats().pending, 1, 'a conflicting write stays pending');
    await r.flush();
    assert.deepStrictEqual(modules.get(USR).data.recent.map((e) => e.tool), ['yaml', 'png'], 'merged with what another writer put there');

    for (let i = 0; i < 40; i++) { t += 1000; r.record(USR, `tool${i}`); }
    await r.flush();
    assert.strictEqual(modules.get(USR).data.recent.length, 30, 'capped at the namespace limit');
    assert.strictEqual(modules.get(USR).data.recent[0].tool, 'tool39');

    // The page middleware: a signed-in document request for a tool host counts; assets, APIs and unknown hosts do not.
    const got = [];
    const mw = usagePages({ snapshot: () => ({ tools: [{ id: 'jsonminify', hosts: ['json-minifier.openvibe.tools', 'jsonminify.openvibe.tools'] }] }), rec: { enabled: true, record: (s, id) => got.push(id) } });
    const req = (host, p, headers = {}, user = { subject_id: USR }) => ({ method: 'GET', hostname: host, path: p, user, get: (h) => headers[h.toLowerCase()] });
    const run = (q) => mw(q, {}, () => {});
    run(req('json-minifier.openvibe.tools', '/', { 'sec-fetch-dest': 'document' }));
    run(req('jsonminify.openvibe.tools', '/', { accept: 'text/html' }));
    run(req('json-minifier.openvibe.tools', '/app.js', { 'sec-fetch-dest': 'script' }));
    run(req('json-minifier.openvibe.tools', '/api/x', { accept: 'text/html' }));
    run(req('openvibe.tools', '/', { 'sec-fetch-dest': 'document', 'x-ov-tool': 'evil' }));
    run(req('json-minifier.openvibe.tools', '/', { 'sec-fetch-dest': 'document' }, null));
    assert.deepStrictEqual(got, ['jsonminify', 'jsonminify']);

    const off = createRecorder({ env: {}, fetchImpl });
    assert.strictEqual(off.enabled, false);
    assert.strictEqual(off.record(USR, 'yaml'), false, 'off without a service secret');
    r.stop();
    console.log('tools usage: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
