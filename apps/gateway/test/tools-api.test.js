'use strict';
// GET /api/v1/tools, /api/v1/tools/:id and /api/v1/tools/:id/schema (ADR-027, tools.tool.read), on
// real processes: the gateway and all seven satellites.
//   • the answers are contract documents: tools.tool-list@1 (checkList), tools.tool@1 (checkDescriptor)
//     with embedded schemas, and a schema document whose $defs the list's $refs point at
//   • open and cacheable: Access-Control-Allow-Origin * for any origin (the gateway's own CORS never
//     refuses them), OPTIONS preflight, ETag with 304 on If-None-Match, Cache-Control public 300 s, HEAD
//   • unknown ids are 404 problem+json tools.tool.not_found (planned and mirrors say so); a bad filter 400
//   • counted by the gateway's /api/ limiter; /api/catalog.json is unchanged
//   • each satellite answers for its own tools, with its own live status (a missing program → unavailable),
//     and the gateway picks that status up
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const contracts = require('openvibe-contracts');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const { startApp } = require('../../_shared/test/spawn');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-tools-api-'));
const MISSING = path.join(tmp, 'not-installed');
const get = async (url, headers = {}, method = 'GET') => {
    const r = await fetch(url, { method, headers });
    const text = await r.text();
    let body = null; try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: r.status, h: r.headers, text, body };
};

(async () => {
    const procs = [];
    const start = async (...a) => { const p = await startApp(...a); procs.push(p); return p; };
    try {
        // Satellites, each missing the program one of its tools needs.
        const sat = {
            img: await start('img', { DATA_DIR: path.join(tmp, 'img'), HEIF_DEC_PATH: MISSING }),
            docs: await start('docs', { DATA_DIR: path.join(tmp, 'docs'), QPDF_PATH: MISSING, PDFTOPPM_PATH: MISSING, PDFINFO_PATH: MISSING }),
            audio: await start('audio', { DATA_DIR: path.join(tmp, 'audio'), FFMPEG_PATH: MISSING }),
            yt: await start('yt', { DATA_DIR: path.join(tmp, 'yt'), DOWNLOADS_DIR: path.join(tmp, 'yt', 'dl'), YTDLP_PATH: MISSING }),
            text: await start('text', { DATA_DIR: path.join(tmp, 'text') }),
            maps: await start('maps', { DATA_DIR: path.join(tmp, 'maps') }, undefined, { readyPath: '/api/ready' }),
        };
        sat.food = await start('food', { DATA_DIR: path.join(tmp, 'food'), MAPS_API: sat.maps.base }, undefined, { readyPath: '/api/ready' });
        const ports = Object.entries(sat).map(([n, p]) => `${n}=${p.port}`).join(',');
        const gw = await start('gateway', { TOOLS_SATELLITE_PORTS: ports, OV_DOMAINS_URL: 'http://127.0.0.1:9/api/domains', OV_REGISTRY_URL: 'http://127.0.0.1:9/registry' });
        const G = gw.base;
        // The gateway reads every satellite's own status on boot: wait for all seven, so the list does
        // not change between the ETag checks below (a busy machine answers slower than the first request).
        for (let i = 0; i < 200; i++) {
            const rd = (await get(`${G}/api/ready`)).body;
            const d = rd && rd.checks && rd.checks.tool_registry && rd.checks.tool_registry.detail;
            if (d && d.satellites_polled >= 7) break;
            await new Promise(res => setTimeout(res, 100));
        }

        // ── The list: a tools.tool-list@1 document with every tool ──
        let r = await get(`${G}/api/v1/tools`, { Origin: 'https://someone-elses-site.example' });
        assert.strictEqual(r.status, 200, r.text.slice(0, 300));
        assert.match(r.h.get('content-type'), /^application\/json/);
        assert.strictEqual(r.h.get('access-control-allow-origin'), '*', 'open to any origin');
        assert.ok(!r.h.get('access-control-allow-credentials'), 'no credentials');
        assert.strictEqual(r.h.get('cache-control'), 'public, max-age=300');
        assert.ok(r.h.get('x-ratelimit-limit') || r.h.get('ratelimit-limit') || r.h.get('ratelimit-policy'), 'counted by the gateway\'s /api/ limiter');
        const etag = r.h.get('etag');
        assert.match(etag, /^"[A-Za-z0-9_-]+"$/);
        const list = r.body;
        const lc = contracts.tools.checkList(list);
        assert.ok(lc.valid, JSON.stringify(lc.errors.slice(0, 5)));
        assert.strictEqual(list.count, 169);
        assert.ok(list.tools.every(d => !d.input || d.input.$ref), 'inputs are $refs in the list');
        assert.ok(!Number.isNaN(Date.parse(list.updated_at)));
        assert.deepStrictEqual(list.families.map(f => f.id).sort(), ['audio', 'dev', 'docs', 'img', 'media', 'net', 'pastes', 'places', 'text']);

        // ETag → 304 (strong, weak, in a list); HEAD; preflight.
        assert.strictEqual((await get(`${G}/api/v1/tools`, { 'If-None-Match': etag })).status, 304);
        assert.strictEqual((await get(`${G}/api/v1/tools`, { 'If-None-Match': `"x", W/${etag}` })).status, 304);
        r = await get(`${G}/api/v1/tools`, {}, 'HEAD');
        assert.deepStrictEqual([r.status, r.text, r.h.get('etag')], [200, '', etag]);
        r = await get(`${G}/api/v1/tools/png`, { Origin: 'https://a.example', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'if-none-match' }, 'OPTIONS');
        assert.strictEqual(r.status, 204);
        assert.strictEqual(r.h.get('access-control-allow-origin'), '*');
        assert.match(r.h.get('access-control-allow-headers'), /If-None-Match/);

        // Filters.
        const count = async (q) => (await get(`${G}/api/v1/tools?${q}`)).body;
        let l = await count('family=img');
        assert.strictEqual(l.count, 15); assert.deepStrictEqual(l.families, [{ id: 'img', name: 'Image Tools', count: 15 }]);
        assert.ok(contracts.tools.checkList(l).valid);
        l = await count('execution=client&api=true');
        assert.ok(l.tools.length >= 40 && l.tools.every(d => d.execution === 'client' && d.api));
        l = await count('api=false');
        assert.ok(l.tools.some(d => d.id === 'yt') && l.tools.every(d => !d.api && d.run === null));
        l = await count('q=json%20minify');
        assert.ok(l.tools.some(d => d.id === 'jsonminify'), 'text search');
        l = await count('family=net,dev&execution=sync');
        assert.ok(l.tools.every(d => ['net', 'dev'].includes(d.family) && d.execution === 'sync') && l.tools.some(d => d.id === 'opengraph'));
        r = await get(`${G}/api/v1/tools?execution=later`);
        assert.deepStrictEqual([r.status, r.body.code], [400, 'tools.query.invalid']);
        assert.match(r.h.get('content-type'), /^application\/problem\+json/);
        r = await get(`${G}/api/v1/tools?api=yes`);
        assert.strictEqual(r.status, 400);

        // ── One tool: tools.tool@1 with its schemas embedded ──
        r = await get(`${G}/api/v1/tools/png`);
        assert.strictEqual(r.status, 200);
        const png = r.body;
        assert.ok(contracts.validate('tools.tool@1', png).valid);
        assert.ok(contracts.tools.checkDescriptor(png).valid);
        assert.strictEqual(png.input.type, 'object', 'embedded');
        assert.deepStrictEqual(png.run.job, { type: 'img.process', operation: 'convert', preset: { defaultFormat: 'png' } });
        assert.strictEqual((await get(`${G}/api/v1/tools/png`, { 'If-None-Match': r.h.get('etag') })).status, 304);
        for (const id of ['dns', 'port', 'jsonminify', 'yt', 'logo', 'mergepdf', 'pastes', 'maps']) {
            const d = (await get(`${G}/api/v1/tools/${id}`)).body;
            assert.ok(contracts.tools.checkDescriptor(d).valid, `${id}: ${JSON.stringify(contracts.tools.checkDescriptor(d).errors)}`);
        }

        // ── The schema document the $refs point at ──
        const ref = list.tools.find(d => d.id === 'dns').input.$ref;
        assert.strictEqual(ref, 'https://openvibe.tools/api/v1/tools/dns/schema#/$defs/input');
        r = await get(`${G}${new URL(ref).pathname}`);
        assert.strictEqual(r.status, 200);
        assert.match(r.h.get('content-type'), /^application\/schema\+json/);
        assert.strictEqual(r.h.get('access-control-allow-origin'), '*');
        const doc = r.body;
        assert.strictEqual(doc.$schema, 'https://json-schema.org/draft/2020-12/schema');
        assert.strictEqual(doc.$id, 'https://openvibe.tools/api/v1/tools/dns/schema');
        const dns = (await get(`${G}/api/v1/tools/dns`)).body;
        assert.deepStrictEqual(doc.$defs.input, dns.input);
        assert.deepStrictEqual(doc.$defs.output, dns.output.schema);
        // The $ref resolves with a JSON Schema validator, as a client would use it.
        const ajv = new Ajv2020({ strict: false }); addFormats(ajv);
        ajv.addSchema(doc);
        const v = ajv.compile({ $ref: ref });
        assert.ok(v({ target: 'example.com', types: ['MX'] }));
        assert.ok(!v({ types: ['MX'] }), 'target is required');
        assert.strictEqual((await get(`${G}/api/v1/tools/yt/schema`)).body.$defs.input, false, 'no API, no input');

        // ── Not tools ──
        for (const [id, why] of [['no-such-tool', /No tool is called/], ['qr', /planned/], ['jsonfmt', /mirror of json|second build of json/]]) {
            r = await get(`${G}/api/v1/tools/${id}`);
            assert.strictEqual(r.status, 404, id);
            assert.match(r.h.get('content-type'), /^application\/problem\+json/);
            assert.strictEqual(r.body.code, 'tools.tool.not_found');
            assert.strictEqual(r.body.status, 404);
            assert.match(r.body.detail, why);
            assert.strictEqual(r.h.get('access-control-allow-origin'), '*');
            assert.strictEqual((await get(`${G}/api/v1/tools/${id}/schema`)).status, 404);
        }
        assert.strictEqual((await get(`${G}/api/v1/tools/Bad_Id`)).status, 404);

        // ── /api/catalog.json is unchanged (Network reads it) ──
        const catalog = (await get(`${G}/api/catalog.json`)).body;
        assert.strictEqual(catalog.tools.length, 169);
        assert.ok(catalog.tools.every(t => ['available', 'unavailable'].includes(t.status) && t.hosts && t.hosts.canonical));
        assert.ok(!('api' in catalog.tools[0]) && !('execution' in catalog.tools[0]), 'no descriptor fields leak into the catalogue');

        // ── Each satellite answers for its own tools, with its own status ──
        const own = { img: 'img', docs: 'docs', audio: 'audio', yt: 'media', text: 'text', maps: 'places', food: 'places' };
        const counts = {};
        for (const [name, p] of Object.entries(sat)) {
            r = await get(`${p.base}/api/v1/tools`, { Origin: 'https://elsewhere.example' });
            assert.strictEqual(r.status, 200, `${name}: ${r.text.slice(0, 200)}`);
            assert.strictEqual(r.h.get('access-control-allow-origin'), '*', `${name}: open CORS`);
            assert.ok(r.h.get('etag'), `${name}: ETag`);
            assert.strictEqual((await get(`${p.base}/api/v1/tools`, { 'If-None-Match': r.h.get('etag') })).status, 304, `${name}: 304`);
            const c = contracts.tools.checkList(r.body);
            assert.ok(c.valid, `${name}: ${JSON.stringify(c.errors.slice(0, 3))}`);
            assert.ok(r.body.tools.length && r.body.tools.every(d => d.family === own[name]), `${name}: only its own tools`);
            counts[name] = r.body.count;
            const first = r.body.tools[0].id;
            const one = await get(`${p.base}/api/v1/tools/${first}`);
            assert.ok(contracts.tools.checkDescriptor(one.body).valid, `${name}: /api/v1/tools/${first}`);
            assert.strictEqual((await get(`${p.base}/api/v1/tools/${first}/schema`)).status, 200);
            assert.strictEqual((await get(`${p.base}/api/v1/tools/png-nope`)).status, 404);
        }
        assert.deepStrictEqual(counts, { img: 15, docs: 10, audio: 36, yt: 1, text: 33, maps: 1, food: 1 });
        const status = async (base, id) => (await get(`${base}/api/v1/tools/${id}`)).body;
        let d = await status(sat.docs.base, 'protectpdf');
        assert.strictEqual(d.status, 'unavailable'); assert.match(d.statusReason, /qpdf/);
        assert.strictEqual((await status(sat.docs.base, 'pdf2jpg')).status, 'unavailable');
        assert.strictEqual((await status(sat.docs.base, 'mergepdf')).status, 'stable');
        assert.strictEqual((await status(sat.img.base, 'heic')).status, 'unavailable', 'HEIC without libheif');
        assert.strictEqual((await status(sat.img.base, 'png')).status, 'stable');
        assert.strictEqual((await status(sat.audio.base, 'mp3')).status, 'unavailable', 'audio without ffmpeg');
        assert.strictEqual((await status(sat.yt.base, 'yt')).status, 'unavailable', 'yt without yt-dlp');
        assert.strictEqual((await status(sat.text.base, 'logo')).status, 'stable');

        // The gateway polled them at boot: the same statuses in the full registry.
        for (let i = 0; i < 50 && (await status(G, 'protectpdf')).status !== 'unavailable'; i++) await new Promise(res => setTimeout(res, 100));
        for (const id of ['protectpdf', 'unlockpdf', 'pdf2jpg', 'heic', 'mp3', 'merge', 'yt']) assert.strictEqual((await status(G, id)).status, 'unavailable', `gateway: ${id}`);
        for (const id of ['png', 'mergepdf', 'fancy', 'dns']) assert.strictEqual((await status(G, id)).status, 'stable', `gateway: ${id}`);
        l = await count('status=unavailable');
        assert.ok(l.tools.length >= 3 + 36 + 5 && contracts.tools.checkList(l).valid, 'status filter');

        // Readiness: the registry is checked, and it passes.
        const ready = (await get(`${G}/api/ready`)).body;
        assert.strictEqual(ready.checks.tool_registry.status, 'ok', JSON.stringify(ready.checks.tool_registry));
        assert.strictEqual(ready.checks.tool_registry.required, false);

        // ── Favourites without an account (WS-L task 1): this browser's ov_tool_favs cookie ──
        {
            const fav = (method, tool, cookie = '') => fetch(`${G}/api/v1/me/favorites/${tool}`, { method, headers: cookie ? { Cookie: cookie } : {} });
            let r = await fav('PUT', 'png');
            assert.strictEqual(r.status, 200);
            assert.deepStrictEqual(await r.json(), { mode: 'device', favorites: ['png'] });
            const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
            assert.strictEqual(cookie, 'ov_tool_favs=png');
            r = await fav('PUT', 'yaml', cookie);
            const both = (r.headers.get('set-cookie') || '').split(';')[0];
            assert.deepStrictEqual((await r.json()).favorites, ['yaml', 'png'], 'newest first');
            const me = await (await fetch(`${G}/api/v1/me/recent-tools`, { headers: { Cookie: `${both}; ov_recent_tools=uuid` } })).json();
            assert.deepStrictEqual(me, { mode: 'device', recent: [{ tool: 'uuid' }], favorites: ['yaml', 'png'] }, 'the launcher reads them back');
            assert.strictEqual((await fav('PUT', 'no-such-tool', cookie)).status, 404);
            r = await fav('DELETE', 'png', cookie);
            assert.deepStrictEqual((await r.json()).favorites, []);
            assert.match(r.headers.get('set-cookie') || '', /^ov_tool_favs=; Path=\/; Max-Age=0/, 'the last unstar clears the cookie');
        }

        // ── The gateway's /api/ limiter counts registry reads (120 a minute per address) ──
        let limited = null;
        for (let i = 0; i < 130 && !limited; i++) { const x = await fetch(`${G}/api/v1/tools/png`); if (x.status === 429) limited = x; }
        assert.ok(limited, 'the 121st request in a minute is refused');
        assert.strictEqual(limited.headers.get('access-control-allow-origin'), '*', 'even a 429 is readable cross-origin');

        console.log(`tools API: gateway ${list.count} tools (list, one, schema, ETag/304, CORS *, 404 problem, filters, limiter); satellites ${Object.entries(counts).map(([n, c]) => `${n} ${c}`).join(', ')} with live status`);
    } finally {
        await Promise.all(procs.map(p => p.kill()));
        fs.rmSync(tmp, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exit(1); });
