'use strict';
// The tool frame on the image pages (openvibe-shared ≥ 4.57.1, owner ask 11, part 2):
//   • every image host is a tool page in the same frame: the head, the box, the answer slot, the family,
//     the folds and "People also use", in that order;
//   • the terms come from the app's real configuration — the file's lifetime from the cleanup config, its
//     size from the upload limits, the anonymous rate from the guard's quota table — and they follow it
//     when it changes;
//   • the one button says the verb, never "Run";
//   • the title, the canonical and the structured data stay.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { frameFor, verbFor, TOOLS } = require('../server/frame');
const { DOMAIN_MAP } = require('../server/domain-map');
const config = require('../server/config');
const { startApp } = require('../../_shared/test/spawn');

const HOSTS = Object.keys(DOMAIN_MAP);

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

// ── Every image host is a framed tool page, in the same order ──
{
    for (const host of HOSTS) {
        const html = frameFor(host);
        assert.ok(html, `${host}: a frame`);
        inOrder(html, [
            '<header class="ovk-tool-head', '<h1 class="ovk-tool-title">', 'class="ovk-tool-card"', 'class="ovk-tool-out"',
            'class="ovk-family"', 'class="ovk-tool-folds"', 'People also use',
        ]);
        assert.ok(html.includes('https://img.openvibe.tools/">Image tools'), `${host}: the crumb is the family`);
        assert.ok(html.includes('class="ovk-drop"'), `${host}: a drop zone`);
        assert.ok(html.includes('data-ovk-sample'), `${host}: a sample to try`);
        assert.ok(html.includes('aria-current="page"'), `${host}: the family marks this tool`);
        assert.ok(html.includes('Use it from code') && html.includes('https://openvibe.tools/api/v1/tools/'), `${host}: the API fold`);
        assert.ok(html.includes('About '), `${host}: the about fold`);
        assert.strictEqual((html.match(/<h1/g) || []).length, 1, `${host}: one h1`);
    }
    assert.strictEqual(TOOLS.length, 15, 'the family has fifteen image tools');
}

// ── The terms come from the app's own configuration ──
{
    const html = frameFor('png.openvibe.tools');
    const facts = factsOf(html);
    assert.deepStrictEqual(facts.slice(0, 2), ['Free', 'Runs on our server; your file is deleted after 60 minutes'], 'png: free, on our server, and the file\'s lifetime');
    assert.ok(facts.includes('One file up to 50 MB'), 'png: the upload limit');
    assert.ok(facts.includes('12 conversions a minute without an account'), 'png: the guard\'s anonymous rate');
    assert.ok(facts.includes('No sign-up'), 'png: anonymous');

    // The lifetime follows the cleanup config.
    const saved = config.retention.anonTTL;
    try {
        config.retention.anonTTL = 30 * 60 * 1000;
        assert.ok(factsOf(frameFor('png.openvibe.tools')).includes('Runs on our server; your file is deleted after 30 minutes'), 'the lifetime follows the config');
        config.upload.maxFileSize = 10 * 1024 * 1024;
        assert.ok(factsOf(frameFor('png.openvibe.tools')).includes('One file up to 10 MB'), 'the size follows the config');
    } finally {
        config.retention.anonTTL = saved;
        config.upload.maxFileSize = 50 * 1024 * 1024;
    }

    // A tool that costs more in the quota table gets a lower rate.
    const avif = factsOf(frameFor('avif.openvibe.tools'));
    assert.ok(avif.includes('7 conversions a minute without an account'), 'avif: its own cost in the quota table');

    // A tool that does not convert says runs, not conversions.
    const compress = factsOf(frameFor('compress.openvibe.tools'));
    assert.ok(compress.includes('12 runs a minute without an account'), 'compress: the rate is counted in runs');
    assert.ok(!compress.some((f) => /conversion/.test(f)), 'compress: never a conversion');
}

// ── The one button says the verb ──
{
    assert.strictEqual(verbFor({ op: 'convert', id: 'png', format: 'png' }), 'Convert to PNG');
    assert.strictEqual(verbFor({ op: 'compress', id: 'compress' }), 'Compress');
    assert.strictEqual(verbFor({ op: 'resize', id: 'resize' }), 'Resize');
    assert.strictEqual(verbFor({ op: 'crop', id: 'crop' }), 'Crop');
    for (const host of HOSTS) {
        const html = frameFor(host);
        const m = /<button[^>]*id="process-btn"[^>]*>\s*(?:<svg[\s\S]*?<\/svg>)?\s*<span>([^<]+)<\/span>/.exec(html);
        assert.ok(m, `${host}: a verb button`);
        assert.notStrictEqual(m[1], 'Run', `${host}: never Run`);
        assert.ok(/^[A-Z]/.test(m[1]), `${host}: the button says the verb (${m[1]})`);
    }
}

// ── The page the server sends: the frame, the title, the canonical and the structured data ──
(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-img-frame-'));
    const app = await startApp('img', { DATA_DIR: tmp });
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
        for (const host of HOSTS) {
            const r = await get(host);
            assert.strictEqual(r.status, 200, `${host}: answers 200`);
            assert.ok(r.body.includes('<h1 class="ovk-tool-title">'), `${host}: the frame's title`);
            assert.ok(r.body.includes('<link rel="canonical"'), `${host}: a canonical`);
            assert.ok(r.body.includes('"@type":"BreadcrumbList"'), `${host}: the structured data`);
            assert.ok(r.body.includes('/shared/kit.css?'), `${host}: the kit's look`);
            assert.strictEqual((r.body.match(/<h1/g) || []).length, 1, `${host}: one h1`);
        }
    } finally {
        await app.kill();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
        console.log(`tool frame (img): ${HOSTS.length} image pages framed, the terms from the config, the verb buttons: all checks passed`);
})().catch((err) => { console.error(err); process.exit(1); });

