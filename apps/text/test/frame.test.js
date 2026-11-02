'use strict';
// The tool frame on the text pages (openvibe-shared ≥ 4.57.1, owner ask 11, part 2):
//   • every text tool's page is a tool page in the same frame: the head, the box, the answer slot, the
//     family, the folds and "People also use", in that order;
//   • the terms come from the app's real configuration — the work happens in the browser, the size of
//     the text is the tool's own limit, the rate is the guard's quota table — and they follow it when
//     it changes;
//   • the one button says the verb, never "Run".
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { frameAround, termsOf, PAGE_OF, TOOL_OF_FILE, VERB } = require('../server/frame');
const { HOSTNAME_MAP } = require('../server/hosts');
const { SPECS } = require('../server/descriptors');
const { startApp } = require('../../_shared/test/spawn');

/** The hosts that are a tool's own page (the hubs are their own thing). */
const TOOL_HOSTS = Object.entries(HOSTNAME_MAP).filter(([host, file]) => TOOL_OF_FILE[file]);

/** The frame's order: each marker appears once, and in this order. */
function inOrder(html, parts) {
    let at = -1;
    for (const p of parts) {
        const i = html.indexOf(p, at + 1);
        assert.ok(i > at, `${p} after ${parts[parts.indexOf(p) - 1] || 'the top'} (${i} > ${at})`);
        at = i;
    }
}

/** The head's terms, as text. */
function factsOf(html) {
    const m = /<ul class="ovk-tool-facts">([\s\S]*?)<\/ul>/.exec(html);
    if (!m) return [];
    return m[1].replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<\/li>\s*<li>/g, '\n').replace(/<[^>]+>/g, '').split('\n').map((s) => s.trim()).filter(Boolean);
}

/** The page a host serves, with the frame around it. */
function pageOf(host, file) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
    return frameAround(html, host, { file, hostnameMap: HOSTNAME_MAP });
}

// ── Every text tool's page is a framed tool page, in the same order ──
{
    for (const [host, file] of TOOL_HOSTS) {
        const html = pageOf(host, file);
        inOrder(html, [
            '<header class="ovk-tool-head', '<h1 class="ovk-tool-title">', 'class="ovk-tool-card"', 'class="ovk-tool-out"',
            'class="ovk-family"', 'class="ovk-tool-folds"', 'People also use',
        ]);
        assert.ok(html.includes('https://text.openvibe.tools/">Text tools'), `${host}: the crumb is the family`);
        assert.ok(html.includes('aria-current="page"'), `${host}: the family marks this tool`);
        assert.ok(html.includes('Use it from code') && html.includes('https://openvibe.tools/api/v1/tools/'), `${host}: the API fold`);
        assert.strictEqual((html.match(/<h1/g) || []).length, 1, `${host}: one h1`);
    }
    assert.ok(TOOL_HOSTS.length >= 60, `the text app has ${TOOL_HOSTS.length} tool pages`);
}

// ── The terms come from the app's own configuration ──
{
    const spec = SPECS.find((s) => s.id === 'fancy');
    const facts = factsOf(pageOf('fancy.openvibe.tools', 'fancy.html'));
    assert.deepStrictEqual(facts.slice(0, 2), ['Free', 'Runs in your browser: nothing is sent'], 'fancy: free, and it runs in the browser');
    assert.ok(facts.includes('API: 120 runs a minute without an account'), 'fancy: the rate from the guard\'s table');
    assert.ok(facts.includes(`Up to ${Math.round(spec.limits.maxInputBytes / 1024)} KB of text`), 'fancy: the size from the tool\'s own limit');

    // Change the configuration: the line follows it.
    const saved = spec.limits.maxInputBytes;
    try {
        spec.limits.maxInputBytes = 5 * 1024;
        assert.ok(factsOf(pageOf('fancy.openvibe.tools', 'fancy.html')).includes('Up to 5 KB of text'), 'the size follows the config');
    } finally {
        spec.limits.maxInputBytes = saved;
    }
    const savedEnv = process.env.TOOLS_GUARD_LIMITS;
    try {
        process.env.TOOLS_GUARD_LIMITS = JSON.stringify({ 'tools-run': { anonymous: { perMinute: 40, burst: 20, perDay: 0 } } });
        assert.ok(factsOf(pageOf('fancy.openvibe.tools', 'fancy.html')).includes('API: 40 runs a minute without an account'), 'the rate follows the guard\'s table');
    } finally {
        if (savedEnv === undefined) delete process.env.TOOLS_GUARD_LIMITS;
        else process.env.TOOLS_GUARD_LIMITS = savedEnv;
    }

    // A tool that runs on the device only is not rate limited at all.
    const logo = factsOf(pageOf('logo.openvibe.tools', 'logo-hub.html'));
    assert.ok(logo.includes('No limit: it runs on your device'), 'logo: no server, so no limit to claim');
}

// ── The one button says the verb ──
{
    let withButton = 0;
    for (const [host, file] of TOOL_HOSTS) {
        const html = pageOf(host, file);
        const toolId = TOOL_OF_FILE[file];
        assert.ok(!/>\s*Run\s*</.test(html), `${host}: never Run`);
        const m = /<button[^>]*class="[^"]*generate-btn[^"]*"[^>]*>[\s\S]*?<i[^>]*><\/i>\s*([^<]+?)\s*<\/button>/.exec(html);
        if (!m) continue;   // a live or gallery page: it has no action button to name
        withButton += 1;
        assert.strictEqual(m[1], VERB[toolId], `${host}: the button says the verb`);
        assert.notStrictEqual(m[1], 'Generate', `${host}: not a generic "Generate"`);
    }
    assert.ok(withButton >= 10, `only ${withButton} pages have an action button`);
    assert.strictEqual(VERB.escape, 'Escape the text', 'escape: the verb');
    assert.ok(/<i class="fas fa-bolt"><\/i>\s*Escape the text\s*<\/button>/.test(pageOf('escape.openvibe.tools', 'escape.html')), 'escape: the button says the verb');
    assert.ok(/<i class="fas fa-bolt"><\/i>\s*Make a slug\s*<\/button>/.test(pageOf('slug.openvibe.tools', 'slug.html')), 'slug: the button says the verb');
}

// ── The page the server sends: the frame, the title, the canonical and the structured data ──
(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-text-frame-'));
    const app = await startApp('text', { DATA_DIR: tmp });
    const get = (host) => new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port: app.port, path: '/', headers: { Host: host, Connection: 'close' }, timeout: 15000 }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (d) => { body += d; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
        req.on('error', () => resolve({ status: 0, body: '' }));
    });
    try {
        for (const host of ['escape.openvibe.tools', 'fancy.openvibe.tools', 'slug.openvibe.tools', 'logo.openvibe.tools']) {
            const r = await get(host);
            assert.strictEqual(r.status, 200, `${host}: answers 200`);
            assert.ok(r.body.includes('<h1 class="ovk-tool-title">'), `${host}: the frame's title`);
            assert.ok(r.body.includes('<link rel="canonical"'), `${host}: a canonical`);
            assert.ok(r.body.includes('"@type":"BreadcrumbList"'), `${host}: the structured data`);
            assert.ok(r.body.includes('/shared/kit.css?'), `${host}: the kit's look`);
            assert.ok(r.body.includes('/js/tool-frame.js'), `${host}: the frame's behaviour`);
            assert.strictEqual((r.body.match(/<h1/g) || []).length, 1, `${host}: one h1`);
        }
    } finally {
        await app.kill();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log(`tool frame (text): ${TOOL_HOSTS.length} text pages framed, the terms from the config, the button says the verb: all checks passed`);
})().catch((err) => { console.error(err); process.exit(1); });
