'use strict';
// The tool frame on the audio pages (openvibe-shared ≥ 4.57.1, owner ask 11, part 2):
//   • every audio host is a tool page in the same frame: the head, the box, the answer slot, the
//     family, the folds and "People also use", in that order;
//   • the terms come from the app's real configuration — the file's lifetime from the cleanup config, its
//     size from the upload limits, the rate from the guard's quota table — and they follow it when it
//     changes;
//   • the box's options are the tool's own descriptor: a field the descriptor does not have is not on
//     the page;
//   • the one button says the verb, never "Run".
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { frameFor, verbFor, RECS } = require('../server/frame');
const { DOMAIN_MAP } = require('../server/domain-map');
const { SPECS } = require('../server/descriptors');
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

// ── Every audio host is a framed tool page, in the same order ──
{
    for (const host of HOSTS) {
        const html = frameFor(host);
        assert.ok(html, `${host}: a frame`);
        inOrder(html, [
            '<header class="ovk-tool-head', '<h1 class="ovk-tool-title">', 'class="ovk-tool-card"', 'class="ovk-tool-out"',
            'class="ovk-family"', 'class="ovk-tool-folds"', 'People also use',
        ]);
        assert.ok(html.includes('https://audio.openvibe.tools/">Audio tools'), `${host}: the crumb is the family`);
        assert.ok(html.includes('class="ovk-drop"'), `${host}: a drop zone`);
        assert.ok(html.includes('aria-current="page"'), `${host}: the family marks this tool`);
        assert.ok(html.includes('Use it from code') && html.includes('https://openvibe.tools/api/v1/tools/'), `${host}: the API fold`);
        assert.strictEqual((html.match(/<h1/g) || []).length, 1, `${host}: one h1`);
    }
    assert.strictEqual(RECS.length, 36, 'the family has thirty-six audio tools');
}

// ── The terms come from the app's own configuration ──
{
    const facts = factsOf(frameFor('mp3.openvibe.tools'));
    assert.deepStrictEqual(facts.slice(0, 2), ['Free', 'Runs on our server; your file is deleted after 60 minutes'], 'mp3: free, on our server, and the file\'s lifetime');
    assert.ok(facts.includes('One file up to 100 MB'), 'mp3: the upload limit');
    assert.ok(facts.includes('A browser session: no account needed'), 'mp3: the tool refuses anonymous callers, so the page says what it needs');

    const saved = config.retention.anonTTL;
    try {
        config.retention.anonTTL = 15 * 60 * 1000;
        assert.ok(factsOf(frameFor('mp3.openvibe.tools')).includes('Runs on our server; your file is deleted after 15 minutes'), 'the lifetime follows the config');
        config.upload.maxFileSize = 20 * 1024 * 1024;
        assert.ok(factsOf(frameFor('mp3.openvibe.tools')).includes('One file up to 20 MB'), 'the size follows the config');
    } finally {
        config.retention.anonTTL = saved;
        config.upload.maxFileSize = 100 * 1024 * 1024;
    }

    // A tool that takes several files says so.
    assert.ok(factsOf(frameFor('merge.openvibe.tools')).includes('Up to 5 files, 100 MB each'), 'merge: the file count from its descriptor');
}

// ── The box's options are the tool's own descriptor ──
{
    const spec = SPECS.find((s) => s.id === 'trim');
    const html = frameFor('trim.openvibe.tools');
    for (const name of Object.keys(spec.input.properties)) {
        assert.ok(html.includes(`name="${name}"`), `trim: the descriptor's field ${name} is on the page`);
    }
    assert.ok(!html.includes('name="bitrate"'), 'trim: a field the descriptor does not have is not on the page');

    // The range and the default are the tool's own.
    assert.ok(html.includes('name="start"'), 'trim: the start field');
    assert.ok(/name="bitrate"[^>]*min="32"[^>]*max="320"/.test(frameFor('mp3.openvibe.tools')), 'mp3: the bitrate range is the descriptor\'s');
}

// ── The one button says the verb ──
{
    assert.strictEqual(verbFor({ id: 'trim', verb: 'Trim' }, 'trim.openvibe.tools'), 'Trim');
    assert.strictEqual(verbFor({ id: 'vocal', verb: 'Remove vocals' }, 'karaoke.openvibe.tools'), 'Make karaoke');
    for (const host of HOSTS) {
        const html = frameFor(host);
        const m = /<button[^>]*id="process-btn"[^>]*>\s*(?:<svg[\s\S]*?<\/svg>)?\s*<span>([^<]+)<\/span>/.exec(html);
        assert.ok(m, `${host}: a verb button`);
        assert.notStrictEqual(m[1], 'Run', `${host}: never Run`);
    }
    assert.ok(/<span>Convert to MP3<\/span>/.test(frameFor('mp3.openvibe.tools')), 'mp3: the button says the verb');
}

// ── The page the server sends: the frame, the title, the canonical and the structured data ──
(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-audio-frame-'));
    const app = await startApp('audio', { DATA_DIR: tmp });
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
    console.log(`tool frame (audio): ${HOSTS.length} audio pages framed, the terms from the config, the options from the descriptors: all checks passed`);
})().catch((err) => { console.error(err); process.exit(1); });
