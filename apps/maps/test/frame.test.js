'use strict';
// The tool frame on the survival map's page (openvibe-shared ≥ 4.57.1, owner ask 11, part 2):
//   • the page is a tool page in the same frame: the head, the box, the answer slot, the family, the
//     folds and "People also use", in that order;
//   • the terms come from the app's real configuration — the lookups happen on our server and the rate
//     is the guard's quota table — and they follow it when it changes;
//   • the one button says the verb, never "Run".
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { renderFrame, termsOf } = require('../server/frame');
const { SPECS } = require('../server/descriptors');
const { startApp } = require('../../_shared/test/spawn');

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

// ── The page is a framed tool page, in the same order ──
{
    const html = renderFrame('maps.openvibe.tools');
    inOrder(html, [
        '<header class="ovk-tool-head', '<h1 class="ovk-tool-title">', 'class="ovk-tool-card"', 'class="ovk-tool-out"',
        'class="ovk-family"', 'class="ovk-tool-folds"', 'People also use',
    ]);
    assert.ok(html.includes('href="https://openvibe.tools">Tools'), 'the crumb is the tools home');
    assert.ok(html.includes('id="search-input"'), 'the box has the place search');
    assert.ok(html.includes('id="map-container"'), 'the answer holds the map');
    assert.ok(html.includes('aria-current="page"'), 'the family marks this tool');
    assert.ok(html.includes('id="btn-search"') && /<span>Search<\/span>/.test(html), 'the one button says the verb');
    assert.strictEqual((html.match(/<h1/g) || []).length, 1, 'one h1');
}

// ── The terms come from the app's own configuration ──
{
    const facts = factsOf(renderFrame('maps.openvibe.tools'));
    assert.deepStrictEqual(facts.slice(0, 2), ['Free', 'Runs on our server: your search is looked up there'], 'free, and the lookups happen on our server');
    assert.ok(facts.includes('30 lookups a minute without an account'), 'the rate from the guard\'s table and the tool\'s own cost');
    assert.ok(facts.includes('No sign-up'), 'no account needed');

    // Change the configuration: the line follows it.
    const savedEnv = process.env.TOOLS_GUARD_LIMITS;
    try {
        process.env.TOOLS_GUARD_LIMITS = JSON.stringify({ 'tools-map': { anonymous: { perMinute: 20, burst: 10, perDay: 0 } } });
        assert.ok(factsOf(renderFrame('maps.openvibe.tools')).includes('10 lookups a minute without an account'), 'the rate follows the guard\'s table');
    } finally {
        if (savedEnv === undefined) delete process.env.TOOLS_GUARD_LIMITS;
        else process.env.TOOLS_GUARD_LIMITS = savedEnv;
    }
    assert.ok(SPECS.find((s) => s.id === 'maps'), 'the map has a descriptor');
}

// ── The page the server sends: the frame, the title, the canonical and the structured data ──
(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-maps-frame-'));
    const app = await startApp('maps', { DATA_DIR: tmp });
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
        const r = await get('maps.openvibe.tools');
        assert.strictEqual(r.status, 200, 'answers 200');
        assert.ok(r.body.includes('<h1 class="ovk-tool-title">'), 'the frame\'s title');
        assert.ok(r.body.includes('<link rel="canonical"'), 'a canonical');
        assert.ok(r.body.includes('/shared/kit.css?'), 'the kit\'s look');
        assert.ok(r.body.includes('/js/tool-frame.js'), 'the frame\'s behaviour');
        assert.strictEqual((r.body.match(/<h1/g) || []).length, 1, 'one h1');
    } finally {
        await app.kill();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log('tool frame (maps): the survival map framed, the terms from the config, the button says the verb: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
