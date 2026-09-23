'use strict';
// X-OV-Canonical-Host on every satellite: the shared helpers, the text pages (several hosts per
// file) and the static maps / food pages. Img, audio and docs are covered by their own app tests.
const assert = require('assert');
const path = require('path');
const hr = require('../host-role');

const req = (host, headers = {}, p = '/') => ({ headers: { host, ...headers }, path: p, originalUrl: p, method: 'GET' });
function res() {
    const r = { headers: {}, statusCode: 200, body: null, redirected: null };
    r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
    r.send = (b) => { r.body = b; return r; };
    r.sendFile = (f) => { r.body = `FILE:${f}`; return r; };
    r.redirect = (code, to) => { r.statusCode = code; r.redirected = to; return r; };
    return r;
}
const via = (tool, canonical, role = 'short', short = '') => ({ 'x-ov-tool': tool, 'x-ov-host-role': role, 'x-ov-canonical-host': canonical, 'x-ov-short-host': short });

// ── Helpers ──────────────────────────────────────────────────
assert.strictEqual(hr.canonicalHostFor(req('png.openvibe.tools', via('png', 'png-converter.example.com')), 'png.openvibe.tools'), 'png-converter.example.com');
assert.strictEqual(hr.canonicalHostFor(req('png.openvibe.tools'), 'png.openvibe.tools'), 'png.openvibe.tools', 'no gateway: own host');
assert.strictEqual(hr.canonicalHostFor(req('png.openvibe.tools', via('png', 'bad host!')), 'png.openvibe.tools'), 'png.openvibe.tools', 'a malformed header is ignored');
const has = (h) => ['png.openvibe.tools', 'jpg.openvibe.tools'].includes(h);
assert.strictEqual(hr.ownHost(req('my-custom.example', via('png', 'my-custom.example', 'canonical')), has), 'png.openvibe.tools', 'custom domain → the tool it serves');
assert.strictEqual(hr.ownHost(req('jpg.openvibe.tools:443'), has), 'jpg.openvibe.tools');
const html = '<html><head><link rel="canonical" href="https://maps.openvibe.tools/"><script type="application/ld+json">{"url":"https://maps.openvibe.tools/"}</script></head><body><a href="https://maps.openvibe.tools/about">x</a></body></html>';
const stamped = hr.restampHead(html, 'maps.openvibe.tools', 'survival-map.example.org');
assert.ok(stamped.includes('href="https://survival-map.example.org/"') && stamped.includes('"url":"https://survival-map.example.org/"'));
assert.ok(stamped.includes('<a href="https://maps.openvibe.tools/about">'), 'only the head is rewritten');
assert.strictEqual(hr.restampHead(html, 'maps.openvibe.tools', 'maps.openvibe.tools'), html);

// ── hostGuard: redirects ─────────────────────────────────────
const guard = hr.hostGuard({ knows: has, aliasOf: (h) => (h === 'jpeg.openvibe.tools' ? 'jpg.openvibe.tools' : '') });
const run = (r) => { const out = res(); let passed = false; guard(r, out, () => { passed = true; }); return { passed, out }; };
let g = run(req('pngs.openvibe.tools', via('png', 'png-converter.example.com', 'alias', 'png.openvibe.tools'), '/x?y=1'));
assert.strictEqual(g.out.statusCode, 301); assert.strictEqual(g.out.redirected, 'https://png.openvibe.tools/x?y=1', 'gateway alias → short host');
g = run(req('jpeg.openvibe.tools'));
assert.strictEqual(g.out.redirected, 'https://jpg.openvibe.tools/', 'own alias → its target');
g = run(req('elsewhere.example'));
assert.strictEqual(g.out.redirected, hr.TOOLS_HOME, 'not ours → tools index');
assert.ok(run(req('elsewhere.example', {}, '/api/health')).passed, 'APIs are never redirected');
assert.ok(run(req('localhost:4012')).passed && run(req('png.openvibe.tools')).passed);

// ── stampedPage: maps and food ───────────────────────────────
for (const [app, host] of [['maps', 'maps.openvibe.tools'], ['food', 'food.openvibe.tools']]) {
    const send = hr.stampedPage(path.join(__dirname, '..', '..', app, 'public', 'index.html'), host);
    let out = res();
    send(req(host, via(app, `${app}.example.net`, 'canonical')), out);
    assert.ok(out.body.includes(`<link rel="canonical" href="https://${app}.example.net/">`), `${app}: canonical follows the gateway`);
    assert.ok(out.body.includes(`<meta property="og:url" content="https://${app}.example.net/">`), `${app}: og:url too`);
    assert.strictEqual(out.headers.vary, 'X-OV-Canonical-Host');
    out = res();
    send(req(host), out);
    assert.ok(out.body.includes(`<link rel="canonical" href="https://${host}/">`), `${app}: direct → own host`);
}

// ── Text: several hosts per page ─────────────────────────────
const textSeo = require('../../text/server/seo');
const MAP = { 'case.openvibe.tools': 'case.html', 'uppercase.openvibe.tools': 'case.html' };
const send = textSeo.pageSender(MAP);
let out = res();
send(req('uppercase.openvibe.tools'), out);
assert.ok(out.body.includes('<link rel="canonical" href="https://case.openvibe.tools">'), 'text: an alias page points at its primary host');
out = res();
send(req('case-converter.example.com', via('case', 'case-converter.example.com', 'canonical')), out);
assert.ok(out.body.includes('<link rel="canonical" href="https://case-converter.example.com">'), 'text: the gateway canonical wins');
assert.ok(/Case/i.test(out.body.match(/<title>([^<]*)<\/title>/)[1]), 'text: a custom domain gets its tool page through X-OV-Tool');

console.log('host-role + canonical host (text, maps, food): all checks passed');
