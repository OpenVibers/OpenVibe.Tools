'use strict';
// The "read" tool (web page reader): HTML → title, description, readable Markdown/text, links; the
// shared SSRF guard (private targets 403, redirects re-checked); the raw size cap; content types;
// and the run API (POST /api/v1/tools/read/run) answering JSON that matches the descriptor's output
// schema. Mock resolver and transports: nothing touches a real network.
const assert = require('assert');
const express = require('express');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const contracts = require('openvibe-contracts');
const { createEgress } = require('../../_shared/egress');
const { createGuard } = require('../../_shared/guard');
const { ajvFrom } = require('../../_shared/tools/run');
const createDevRoutes = require('../server/dev/routes');
const { readHtml } = require('../server/dev/reader');
const { SPECS } = require('../server/dev/descriptors');

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Hello &amp; welcome</title>
<meta name="description" content="A page about &quot;things&quot;">
<style>body{color:red}</style><script>var hidden = "script text";</script></head>
<body>
<header><a href="/home">HEADER-LINK</a> HEADER TEXT</header>
<nav><ul><li><a href="/nav">NAV-ITEM</a></li></ul></nav>
<main>
<h1>Big title</h1>
<p>First paragraph with a <a href="/docs/intro?x=1&amp;y=2">relative link</a> and &copy; 2026&nbsp;text.</p>
<h2>Things</h2>
<ul><li>one<li>two with <a href="https://other.example/page">other</a></ul>
<p>Duplicate <a href="/docs/intro?x=1&amp;y=2">again</a>, <a href="javascript:alert(1)">js</a>, <a href="mailto:a@b.c">mail</a>, <a href="#top">top</a>.</p>
<pre>line 1
  line 2</pre>
<form><input name="q"> FORM-TEXT</form>
<svg><text>SVG-TEXT</text></svg>
<noscript>NOSCRIPT-TEXT</noscript>
</main>
<aside>ASIDE-TEXT</aside>
<footer>FOOTER TEXT</footer>
</body></html>`;

const DNS = { 'public.example': ['93.184.216.34'], 'redirector.example': ['93.184.216.35'], 'rebind.example': ['127.0.0.1'], 'lan.example': ['192.168.1.20'] };
const lookup = (host, _o, cb) => { const a = DNS[host]; if (!a) return cb(Object.assign(new Error('nf'), { code: 'ENOTFOUND' })); cb(null, a.map(address => ({ address, family: 4 }))); };
const dialled = [];
const seenReq = [];
function fakeSocket(address) {
    const s = new EventEmitter();
    s.setTimeout = () => {}; s.destroy = () => {}; s.end = () => {};
    process.nextTick(() => s.emit('connect'));
    dialled.push(address);
    return s;
}
// path → { status, type, body (string|Buffer), location }
const SITE = {
    '/': { type: 'text/html; charset=utf-8', body: PAGE },
    '/plain': { type: 'text/plain', body: 'just some text\r\nsecond line\r\n' },
    '/image': { type: 'image/png', body: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    '/json': { type: 'application/json', body: '{"a":1}' },
    '/big': { type: 'text/html', body: '<html><body><main><p>' + 'word '.repeat(600) + '</p></main></body></html>' },
    '/huge': { type: 'text/html', body: '<html><body>' + '<p>' + 'x'.repeat(1024) + '</p>' + '<p>padding</p>'.repeat(300000) + '</body></html>' },
    '/notfound': { status: 404, type: 'text/html', body: '<html><head><title>Gone</title></head><body><p>Nothing here.</p></body></html>' },
    '/latin1': { type: 'text/html; charset=iso-8859-1', body: Buffer.from('<html><body><p>caf\xe9</p></body></html>', 'latin1') },
};
function fakeHttp(opts, cb) {
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => {
        const answer = (address) => {
            dialled.push(address);
            seenReq.push({ host: opts.hostname, path: opts.path, headers: opts.headers });
            let page;
            if (opts.hostname === 'redirector.example') {
                const to = { '/to-loopback': 'http://127.0.0.1:3000/admin', '/to-public': 'https://public.example/plain' }[opts.path];
                page = to ? { status: 302, location: to, body: '' } : SITE['/'];
            } else page = SITE[opts.path] || SITE['/'];
            const res = Readable.from(page.body.length ? [Buffer.isBuffer(page.body) ? page.body : Buffer.from(page.body)] : []);
            Object.assign(res, { statusCode: page.status || 200, statusMessage: 'x', headers: { 'content-type': page.type || 'text/html', ...(page.location && { location: page.location }) } });
            cb(res);
        };
        if (opts.lookup) opts.lookup(opts.hostname, {}, (err, address) => err ? req.emit('error', err) : answer(address)); else answer(opts.hostname);
    };
    return req;
}
const egress = createEgress({
    lookup, tcpConnect: ({ host }) => fakeSocket(host),
    tlsConnect: (o) => { const s = fakeSocket(o.host); s.getPeerCertificate = () => ({}); return s; },
    httpRequest: fakeHttp, httpsRequest: fakeHttp,
});

(async () => {
    // ── The extraction itself ──
    const r = readHtml(PAGE, { baseUrl: 'https://public.example/a/b', format: 'markdown', maxChars: 20000 });
    assert.equal(r.title, 'Hello & welcome');
    assert.equal(r.description, 'A page about "things"');
    assert.equal(r.lang, 'en');
    for (const gone of ['HEADER', 'NAV-ITEM', 'FOOTER', 'ASIDE', 'FORM-TEXT', 'SVG-TEXT', 'NOSCRIPT', 'script text', 'color:red']) assert.ok(!r.text.includes(gone), `dropped: ${gone}`);
    assert.ok(r.text.startsWith('# Big title\n\nFirst paragraph with a [relative link](https://public.example/docs/intro?x=1&y=2) and © 2026 text.'), r.text);
    assert.ok(r.text.includes('## Things\n\n- one\n- two with [other](https://other.example/page)\n\n'), r.text);
    assert.ok(r.text.includes('```\nline 1\n  line 2\n```'));
    assert.deepEqual(r.links, [{ text: 'relative link', href: 'https://public.example/docs/intro?x=1&y=2' }, { text: 'other', href: 'https://other.example/page' }], 'absolute http(s) only, de-duplicated, no javascript:/mailto:/#fragment');
    assert.equal(r.truncated, false);
    const plain = readHtml(PAGE, { baseUrl: 'https://public.example/', format: 'text', maxChars: 20000 });
    assert.ok(plain.text.startsWith('Big title\n\nFirst paragraph with a relative link and'), plain.text);
    assert.ok(!plain.text.includes('](') && !plain.text.includes('```'));
    assert.equal(plain.links.length, 2, 'links are still listed in text mode');
    // No <main>: body minus furniture; many links are capped at 50.
    const many = readHtml('<body><nav>N</nav><p>' + Array.from({ length: 80 }, (_, i) => `<a href="/p${i}">p${i}</a>`).join(' ') + '</p></body>', { baseUrl: 'https://x.example/' });
    assert.equal(many.links.length, 50);
    assert.ok(!many.text.includes('N\n'));
    // Hostile / broken markup does not throw or hang.
    readHtml('<div>'.repeat(5000) + 'deep' + '<a href="' + 'a'.repeat(100000), { baseUrl: 'https://x.example/' });
    readHtml('<<<>>><p <b>>&#xFFFFFFF;&#0;&bogus;', { baseUrl: 'https://x.example/' });
    const cut = readHtml('<main><p>' + 'sentence one. '.repeat(500) + '</p></main>', { baseUrl: 'https://x.example/', maxChars: 1000 });
    assert.ok(cut.truncated && cut.text.length <= 1000);
    console.log('extraction: ok');

    // ── Route: SSRF, caps, content types ──
    const app = express();
    const devRouter = createDevRoutes(null, null, { egress });
    app.use('/api/dev', devRouter);
    const srv = await new Promise(res => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
    const base = `http://127.0.0.1:${srv.address().port}`;
    const q = encodeURIComponent;
    const get = async (p) => { const x = await fetch(base + p); return { status: x.status, body: await x.json() }; };

    for (const u of ['http://localhost:3000/', 'http://127.0.0.1:4000/', 'http://[::1]/', 'http://10.1.1.1/', 'http://192.168.0.1/', 'http://169.254.169.254/latest/meta-data/', 'https://rebind.example/', 'https://lan.example/', 'localhost:4100']) {
        dialled.length = 0;
        const x = await get(`/api/dev/read?url=${q(u)}`);
        assert.equal(x.status, 403, `${u} → ${x.status}`);
        assert.ok(x.body.code && /not a public internet address/.test(x.body.error));
        assert.deepEqual(dialled, [], `${u}: no connection`);
    }
    dialled.length = 0;
    assert.equal((await get(`/api/dev/read?url=${q('https://redirector.example/to-loopback')}`)).status, 403, 'a redirect to loopback is refused');
    assert.deepEqual(dialled, ['93.184.216.35'], 'only the public hop was dialled');
    assert.equal((await get('/api/dev/read')).status, 400);
    assert.equal((await get(`/api/dev/read?url=${q('ftp://public.example/')}`)).status, 400);
    assert.equal((await get('/api/dev/read?url=public.example&format=pdf')).status, 400);
    assert.equal((await get('/api/dev/read?url=public.example&max_chars=10')).status, 400);
    assert.equal((await get('/api/dev/read?url=public.example&max_chars=99999')).status, 400);
    assert.equal((await get('/api/dev/read?url=nowhere.example')).status, 400, 'an unresolvable name is a bad URL');

    let x = await get('/api/dev/read?url=public.example');
    assert.equal(x.status, 200);
    assert.deepEqual([x.body.url, x.body.status, x.body.content_type, x.body.title, x.body.lang, x.body.truncated], ['https://public.example/', 200, 'text/html', 'Hello & welcome', 'en', false]);
    assert.equal(x.body.chars, x.body.text.length);
    const sent = seenReq[seenReq.length - 1].headers;
    assert.equal(sent['User-Agent'], 'OpenVibeReader/1.0 (+https://read.openvibe.tools)');
    assert.equal(sent.Accept, 'text/html,application/xhtml+xml,text/plain;q=0.9');

    x = await get(`/api/dev/read?url=${q('https://redirector.example/to-public')}`);
    assert.equal(x.status, 200); assert.equal(x.body.url, 'https://public.example/plain', 'the final URL after redirects');
    assert.deepEqual([x.body.content_type, x.body.text, x.body.title, x.body.links], ['text/plain', 'just some text\nsecond line', '', []], 'plain text is returned as is');

    x = await get('/api/dev/read?url=public.example/image');
    assert.equal(x.status, 415); assert.equal(x.body.code, 'tools.read.unsupported_content_type');
    assert.equal((await get('/api/dev/read?url=public.example/json')).status, 415);

    x = await get('/api/dev/read?url=public.example/notfound');
    assert.deepEqual([x.status, x.body.status, x.body.title, x.body.text], [200, 404, 'Gone', 'Nothing here.'], 'the upstream status is reported');
    assert.equal((await get('/api/dev/read?url=public.example/latin1')).body.text, 'café', 'the declared charset is honoured');

    x = await get('/api/dev/read?url=public.example/big&max_chars=1000');
    assert.equal(x.body.truncated, true); assert.ok(x.body.text.length <= 1000 && x.body.chars === x.body.text.length);
    x = await get('/api/dev/read?url=public.example/huge');
    assert.equal(x.status, 200); assert.equal(x.body.truncated, true, 'the 2 MB raw cap is reported');
    assert.ok(x.body.chars <= 20000, 'and the default max_chars still applies');
    console.log('route: ok');

    // ── Through the run API ──
    const guard = createGuard({ app: 'gateway', contracts, issuer: 'https://openvibe.network', keys: { get: () => null }, specs: SPECS, env: { TOOLS_GUARD: 'report' }, log: { log() {}, warn() {}, error() {} }, pruneIntervalMs: 0 });
    const runApp = express();
    runApp.use(guard.identify);
    const { createGatewayRun } = require('../server/run');
    const runDev = createDevRoutes(null, null, { egress, guard });
    const toolRegistry = require('../server/registry/descriptors');
    const run = createGatewayRun({
        guard, contracts, toolRegistry, routers: { net: null, dev: runDev }, ports: () => ({}),
        parseJson: express.json({ limit: '64kb' }), jobIndex: new Map(), ...ajvFrom(require),
    });
    runApp.use(run.handle);
    const rsrv = await new Promise(res => { const s = runApp.listen(0, '127.0.0.1', () => res(s)); });
    const rbase = `http://127.0.0.1:${rsrv.address().port}`;
    const post = async (id, body) => { const y = await fetch(`${rbase}/api/v1/tools/${id}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: y.status, body: await y.json() }; };

    let y = await post('read', { input: { url: 'public.example', format: 'text', max_chars: 5000 } });
    assert.equal(y.status, 200, JSON.stringify(y.body));
    assert.equal(y.body.state, 'succeeded');
    const data = y.body.result.data;
    const spec = SPECS.find(s => s.id === 'read');
    const { Ajv, addFormats } = ajvFrom(require);
    const ajv = new Ajv({ strict: false }); if (addFormats) addFormats(ajv);
    assert.ok(ajv.validate(spec.output.schema, data), JSON.stringify(ajv.errors));
    assert.equal(data.title, 'Hello & welcome');
    assert.ok(data.text.startsWith('Big title'));
    y = await post('read', { input: { url: 'http://127.0.0.1:3000/' } });
    assert.ok(y.status === 403 || (y.body.error && /public internet/.test(JSON.stringify(y.body))), `run API refuses loopback: ${y.status} ${JSON.stringify(y.body)}`);
    y = await post('read', { input: { url: 'public.example', max_chars: 5 } });
    assert.equal(y.status, 422, 'input validated against the descriptor');
    y = await post('read', { input: {} });
    assert.equal(y.status, 422);
    console.log('run API: ok');

    srv.closeAllConnections(); srv.close(); rsrv.closeAllConnections(); rsrv.close();
    console.log('read tool: all checks passed');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
