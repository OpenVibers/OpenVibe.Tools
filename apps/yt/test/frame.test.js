'use strict';
// The tool frame on the YouTube downloader's page (openvibe-shared ≥ 4.57.1, owner ask 11, part 2):
//   • the page is a tool page in the same frame: the head, the box, the answer slot, the family, the
//     folds and "People also use", in that order;
//   • the terms come from the app's real configuration — the file's lifetime from the cleanup config,
//     its size and the video's length from the download limits, the rate from the guard's quota table —
//     and they follow it when it changes;
//   • the one button says the verb, never "Run".
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { frameFor, termsOf } = require('../server/frame');
const config = require('../server/config');
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
    const html = frameFor('yt.openvibe.tools');
    inOrder(html, [
        '<header class="ovk-tool-head', '<h1 class="ovk-tool-title">', 'class="ovk-tool-card"', 'class="ovk-tool-out"',
        'class="ovk-family"', 'class="ovk-tool-folds"', 'People also use',
    ]);
    assert.ok(html.includes('href="https://openvibe.tools">Tools'), 'the crumb is the tools home');
    assert.ok(html.includes('id="url-input"'), 'the box has the link field');
    assert.ok(html.includes('aria-current="page"'), 'the family marks this tool');
    assert.ok(html.includes('id="save-btn"') && html.includes('<span>Download</span>'), 'the answer downloads the file');
    assert.strictEqual((html.match(/<h1/g) || []).length, 1, 'one h1');
}

// ── The terms come from the app's own configuration ──
{
    const facts = factsOf(frameFor('yt.openvibe.tools'));
    assert.deepStrictEqual(facts.slice(0, 2), ['Free', 'Runs on our server; your file is deleted after 60 minutes'], 'free, on our server, and the file\'s lifetime');
    assert.ok(facts.includes('One file up to 2 GB'), 'the size from the download limits');
    assert.ok(facts.includes('Up to 3 hours long'), 'the length from the download limits');
    assert.ok(facts.includes('1 download a minute without an account'), 'the rate from the guard\'s table and the tool\'s own cost');

    const savedTtl = config.retention.fileTTL;
    const savedSize = config.download.maxFilesize;
    const savedDuration = config.download.maxDuration;
    try {
        config.retention.fileTTL = 30 * 60 * 1000;
        assert.ok(factsOf(frameFor('yt.openvibe.tools')).includes('Runs on our server; your file is deleted after 30 minutes'), 'the lifetime follows the config');
        config.download.maxFilesize = 512;
        assert.ok(factsOf(frameFor('yt.openvibe.tools')).includes('One file up to 512 MB'), 'the size follows the config');
        config.download.maxDuration = 600;
        assert.ok(factsOf(frameFor('yt.openvibe.tools')).includes('Up to 10 minutes long'), 'the length follows the config');
    } finally {
        config.retention.fileTTL = savedTtl;
        config.download.maxFilesize = savedSize;
        config.download.maxDuration = savedDuration;
    }
}

// ── The one button says the verb ──
{
    const html = frameFor('yt.openvibe.tools');
    const buttons = [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)]
        .map((m) => m[1].replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '').trim())
        .filter(Boolean);
    assert.ok(buttons.includes('Fetch the video'), 'the box button says the verb');
    assert.ok(buttons.includes('Start the download'), 'the download button says the verb');
    assert.ok(!buttons.includes('Run'), 'never Run');
    assert.ok(/<span>Download<\/span>/.test(html), 'the answer downloads the file');
}

// ── The page the server sends: the frame, the title, the canonical and the structured data ──
(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-yt-frame-'));
    const app = await startApp('yt', { DATA_DIR: tmp });
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
        for (const host of ['yt.openvibe.tools', 'youtube-downloader.openvibe.tools']) {
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
    console.log('tool frame (yt): the downloader page framed, the terms from the config, the buttons say the verb: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
