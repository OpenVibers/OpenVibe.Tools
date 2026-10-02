'use strict';
// Text.OpenVibe's own HTTP surface, started as its server entry runs it (server/index.js, via
// apps/_shared/test/spawn): the tool registry the gateway and the status page read (ADR-027), the
// health route and the page fallbacks. It checks that the text tools are advertised with the run
// contract the gateway executes (api true + run.path), that an unknown tool is a 404 problem+json and
// a bad filter a 400, and that the registry is the public, cacheable answer it claims to be.
//
// The tools themselves are run by the gateway, not by this satellite (its descriptors say execution
// 'client': apps/gateway/server/run runs the text engines, apps/text/server/engines.js). That the
// satellite has no run route of its own is asserted at the end, so this stays true if it changes.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startApp } = require('../../_shared/test/spawn');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-text-api-'));

(async () => {
    const text = await startApp('text', { DATA_DIR: path.join(tmp, 'text') });
    const call = async (p, opts) => {
        const r = await fetch(`${text.base}${p}`, opts);
        const body = await r.text();
        let json = null;
        try { json = JSON.parse(body); } catch { /* not JSON */ }
        return { status: r.status, headers: r.headers, text: body, body: json };
    };
    try {
        // ── Health ──
        let r = await call('/api/health');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.service, 'openvibe-text');

        // ── The tool registry (GET /api/v1/tools) ──
        r = await call('/api/v1/tools');
        assert.strictEqual(r.status, 200, r.text.slice(0, 200));
        assert.strictEqual(r.headers.get('access-control-allow-origin'), '*', 'the registry is open CORS');
        assert.match(r.headers.get('cache-control') || '', /max-age=300/, 'the registry is cacheable');
        assert.ok(r.headers.get('etag'), 'the registry carries an ETag');
        const list = r.body;
        assert.strictEqual(list.count, list.tools.length, 'count matches the list');
        assert.ok(list.count >= 22, `the text tools are advertised (${list.count})`);
        const byId = new Map(list.tools.map((d) => [d.id, d]));
        for (const id of ['count', 'fancy', 'morse', 'compare']) assert.ok(byId.has(id), `${id} is in the registry`);
        // A tool the API runs names its run route; a page-only tool (the canvas makers) does not.
        assert.deepStrictEqual(byId.get('count').run, { method: 'POST', path: '/api/v1/tools/count/run', job: null });
        assert.strictEqual(byId.get('count').api, true);
        assert.strictEqual(byId.get('count').execution, 'client');
        assert.strictEqual(byId.get('logo').api, false, 'a canvas maker has no API');
        assert.strictEqual(byId.get('logo').run, null);
        for (const d of list.tools.filter((t) => t.api)) {
            assert.ok(d.run && d.run.path === `/api/v1/tools/${d.id}/run`, `${d.id}: an API tool names its run path`);
        }

        // An If-None-Match with the ETag is answered 304 (the status page polls this).
        const again = await call('/api/v1/tools', { headers: { 'If-None-Match': r.headers.get('etag') } });
        assert.strictEqual(again.status, 304, 'a matching ETag is 304');

        // A filter narrows the list; a bad filter value is a 400 problem+json.
        r = await call('/api/v1/tools?api=false');
        assert.strictEqual(r.status, 200);
        assert.ok(r.body.count > 0 && r.body.tools.every((d) => d.api === false), 'api=false answers only page-only tools');
        r = await call('/api/v1/tools?status=bogus');
        assert.strictEqual(r.status, 400);
        assert.match(r.headers.get('content-type') || '', /application\/problem\+json/);
        assert.strictEqual(r.body.code, 'tools.query.invalid');
        assert.ok(r.body.error, 'the problem carries a legacy error field');

        // ── One tool and its schema ──
        r = await call('/api/v1/tools/count');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.id, 'count');
        assert.deepStrictEqual(r.body.hosts, ['count.openvibe.tools']);
        assert.strictEqual(r.body.auth.anonymous, true, 'an anonymous tool');
        assert.strictEqual(r.body.output.kind, 'json');
        assert.ok(r.body.input && r.body.input.required.includes('text'), 'the input schema is embedded');
        r = await call('/api/v1/tools/count/schema');
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(Object.keys(r.body.$defs).sort(), ['input', 'output']);
        assert.match(r.body.$id, /\/api\/v1\/tools\/count\/schema$/);

        // ── Unknown tool: a 404 problem+json ──
        r = await call('/api/v1/tools/nosuchtool');
        assert.strictEqual(r.status, 404);
        assert.match(r.headers.get('content-type') || '', /application\/problem\+json/);
        assert.strictEqual(r.body.code, 'tools.tool.not_found');
        assert.match(r.body.detail, /No tool is called/);

        // ── Pages and fallbacks ──
        r = await call('/sitemap.xml');
        assert.strictEqual(r.status, 200);
        assert.match(r.text, /^<\?xml/, 'a sitemap, not the SPA fallback');
        r = await call('/api/does-not-exist');
        assert.strictEqual(r.status, 404);
        assert.deepStrictEqual(r.body, { error: 'Not found' }, 'an unknown /api/ path is JSON, never the page');

        // ── The satellite does not run the tools: their run route lives on the gateway ──
        r = await call('/api/v1/tools/count/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: { text: 'x' } }) });
        assert.strictEqual(r.status, 404, 'POST .../run is not served here (the gateway runs the text engines)');
        assert.ok(!r.headers.get('content-type') || !/json/.test(r.headers.get('content-type')), 'it is not even a run-shaped answer');
    } finally {
        await text.kill();
    }
    console.log('text registry: tools, schemas, 404/400 problem+json and the page fallbacks all answer as specified');
})().catch((err) => { console.error(err); process.exit(1); });
