'use strict';
// dev.html on the network's web runtime (openvibe-shared/web-runtime, roadmap WS-P task 6). The page's own script runs
// in a vm with a small fake DOM, timers and fetch:
//   - each Run is a route generation: running the webhook tool again stops the previous bin's poller and aborts its
//     request, and Clear stops the poller (before, every Run left a 2 s poller running for an hour);
//   - two quick runs of a minifier add Terser's <script> once;
//   - a webhook request's method and headers are shown as text (a sender's markup never becomes the page's).
//   node apps/gateway/test/dev-runtime.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'dev.html'), 'utf8');
const runtimeTag = html.indexOf('<script src="/shared/web-runtime.js"></script>');
assert.ok(runtimeTag > 0 && runtimeTag < html.indexOf("const API='https://openvibe.tools/api/dev'"), 'dev.html loads the web runtime before its own script');
assert.ok(require('openvibe-shared/files').isBrowserFile('web-runtime.js'), 'the pinned openvibe-shared serves web-runtime.js at /shared/');
const start = html.indexOf("<script>\n'use strict';\nconst API=");
const PAGE = html.slice(start + '<script>'.length, html.indexOf('</script>', start));
assert.ok(!/\bsetInterval\(/.test(PAGE), 'no page poller outside a run\'s scope');

function page(host) {
    const els = new Map();
    const el = (id) => {
        if (id === 'pasted') return null;
        if (!els.has(id)) els.set(id, { id, innerHTML: '', value: '', textContent: '', style: {}, classList: { add() {}, remove() {} }, remove() {} });
        return els.get(id);
    };
    const scripts = [];
    const timers = new Map(); let tid = 0;
    const requests = [];
    const bins = [];
    const ctx = {
        console, JSON, Promise, Date, Math, Object, Array, Error, URL, URLSearchParams, AbortController, TextEncoder, Blob,
        location: { hostname: host, search: '', href: `https://${host}/`, origin: `https://${host}` },
        navigator: {}, localStorage: { getItem: () => null, setItem() {} },
        CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
        document: {
            getElementById: el, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, dispatchEvent() {},
            head: { appendChild: (n) => { scripts.push(n); return n; } },
            createElement: (tag) => { const n = { tagName: tag.toUpperCase(), dataset: {}, setAttribute() {}, remove() { n.removed = true; } }; return n; },
        },
        setTimeout: (f, ms) => { timers.set(++tid, { f, ms, kind: 'timeout' }); return tid; },
        clearTimeout: (id) => { timers.delete(id); },
        setInterval: (f, ms) => { timers.set(++tid, { f, ms, kind: 'interval' }); return tid; },
        clearInterval: (id) => { timers.delete(id); },
        fetch: (u, init = {}) => new Promise((resolve, reject) => {
            const req = { url: String(u), method: init.method || 'GET', signal: init.signal, resolve };
            requests.push(req);
            if (init.signal) init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
            const json = (body) => resolve({ ok: true, status: 200, json: async () => body });
            if (req.method === 'POST' && /\/webhook\/bins$/.test(req.url)) { bins.push(req); req.answer = () => json({ ok: true, binId: `bin${bins.length}` }); return; }
            if (/\/webhook\/bins\/bin\d+$/.test(req.url)) {
                return json({ ok: true, requests: [{ method: '<img src=x onerror=alert(1)>', headers: { 'x-evil<b>': '<script>alert(2)</script>' }, body: '<i>body</i>', timestamp: 0 }] });
            }
            reject(new Error(`unexpected ${req.method} ${req.url}`));
        }),
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    const shared = path.dirname(require.resolve('openvibe-shared/package.json'));
    vm.runInContext(fs.readFileSync(path.join(shared, 'web-runtime.js'), 'utf8'), ctx, { filename: 'web-runtime.js' });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'dev-engine.js'), 'utf8'), ctx, { filename: 'dev-engine.js' });
    vm.runInContext(PAGE, ctx, { filename: 'dev.html' });
    const intervals = () => [...timers.values()].filter((t) => t.kind === 'interval');
    return { ctx, el, scripts, timers, intervals, requests, bins, eval: (code) => vm.runInContext(code, ctx) };
}
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

(async () => {
    // ── The webhook tool: one poller, the newest run's ──
    const p = page('webhook.openvibe.tools');
    const first = p.ctx.run();
    await settle();
    const second = p.ctx.run();                 // before the first bin was created
    await settle();
    p.bins[1].answer();
    await second;
    await first;                                // aborted, quietly
    assert.ok(p.bins[0].signal.aborted, 'the first run\'s request was aborted');
    assert.match(p.el('out').innerHTML, /bin2\/in/, 'the newest run owns the output');
    assert.ok(!/bin1/.test(p.el('out').innerHTML));
    assert.strictEqual(p.intervals().length, 1, 'one poller');

    const third = p.ctx.run();                  // a third run: bin3, and bin2's poller stops
    await settle();
    assert.strictEqual(p.intervals().length, 0, 'bin2\'s poller stopped when the third run began');
    p.bins[2].answer();
    await third;
    assert.strictEqual(p.intervals().length, 1, 'still one poller after running again');
    p.intervals()[0].f();
    await settle();
    const shown = p.el('whr').innerHTML;
    assert.match(p.requests[p.requests.length - 1].url, /bin3$/, 'the poller asks for the newest bin');
    assert.ok(!/<img|<script|<b>/.test(shown), `a sender's markup is text: ${shown}`);
    assert.match(shown, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(shown, /x-evil&lt;b&gt;: &lt;script&gt;alert\(2\)&lt;\/script&gt;/);
    p.ctx.clr();
    assert.strictEqual(p.intervals().length, 0, 'Clear stops the poller');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(p.eval('RT.leaks()'))), []);

    // ── A minifier run twice at once: Terser's script is added once ──
    const q = page('jsminify.openvibe.tools');
    q.el('in1').value = 'function f ( a ) { return a + 1 ; }';
    const a = q.ctx.run(); const b = q.ctx.run();
    await settle();
    const terserTags = q.scripts.filter((s) => /terser/.test(s.src));
    assert.strictEqual(terserTags.length, 1, 'one <script> for Terser');
    q.ctx.Terser = { minify: async (src) => ({ code: src.replace(/\s+/g, '') }) };
    terserTags[0].onload();
    await Promise.all([a, b]);
    assert.match(q.el('out').innerHTML, /functionf\(a\)\{returna\+1;\}/);

    console.log('dev.html runtime: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
