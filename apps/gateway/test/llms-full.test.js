'use strict';
// Discovery: /llms-full.txt (every public page llms.txt lists, as text) and the IndexNow key file
// (served only when INDEXNOW_KEY is set). Fetched from the real HTTP layer over a stand-in Express
// app, the same wiring server/index.js mounts.
const assert = require('assert');
const http = require('http');
const express = require('express');
const site = require('../server/pages/site');
const registry = require('../server/registry');
const { createToolsIndexNow } = require('../server/seo/indexnow');

const HOST = 'openvibe.tools';
// Format-valid placeholder (8-128 alphanumeric, what createIndexNow accepts), not a secret.
const KEY = 'testtesttesttest';

function serve(app) {
    const srv = http.createServer(app);
    return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

(async () => {
    // ── /llms-full.txt ──────────────────────────────────────
    const app = express();
    app.use(site.createSiteRouter());
    const srv = await serve(app);
    const base = `http://127.0.0.1:${srv.address().port}`;
    try {
        const r = await fetch(`${base}/llms-full.txt`);
        assert.strictEqual(r.status, 200, 'llms-full is served');
        assert.ok(/^text\/plain/.test(r.headers.get('content-type') || ''), 'llms-full is text/plain');
        const body = await r.text();
        assert.ok(body.startsWith('# OpenVibe.Tools\n'), 'llms-full opens with the llms.txt header');
        // Same summary line as llms.txt (llmsFull builds its header from the same llmsTxt call).
        const idx = await (await fetch(`${base}/llms.txt`)).text();
        const summary = idx.split('\n').find((l) => l.startsWith('> '));
        assert.ok(summary && body.includes(summary), 'the same summary as llms.txt');
        // Every public page llms.txt lists: each tool, under its family heading, with its text.
        const { tools, families } = registry.get();
        for (const f of families.filter((x) => x.path)) {
            assert.ok(body.includes(`## ${f.name}`), `section for ${f.name}`);
            for (const t of tools.filter((x) => x.family === f.id)) {
                assert.ok(body.includes(t.url), `${t.id} URL is listed`);
                assert.ok(body.includes(t.description), `${t.id} carries its description`);
            }
        }
        // Nothing robots keeps out of crawlers leaks into the model-readable document (the catalog URL
        // in the summary is the one path robots explicitly allows, so only /auth/ and /search can appear).
        assert.ok(!body.includes('/auth/') && !body.includes('/search') && !body.includes('Disallow'), 'no private paths');
        // llms.txt points at the full document.
        assert.ok(idx.includes('/llms-full.txt'), 'llms.txt lists llms-full.txt');
        // AGT-5: each of the site's own pages at its Markdown twin, the twin-less /developers marked (HTML), an
        // Optional section last. A tool on another subdomain keeps its URL.
        assert.ok(idx.includes('[Developer guide](https://openvibe.tools/developers) (HTML)'), 'the twin-less guide keeps its URL');
        assert.ok(idx.includes('[Sitemap](https://openvibe.tools/sitemap.xml)'), 'the sitemap is listed in Optional');
        assert.match(idx, /\n## Optional\n/);
        assert.strictEqual(idx.lastIndexOf('\n## '), idx.indexOf('\n## Optional'), 'Optional is the last section');
        const own = [...idx.matchAll(/\]\((https:\/\/openvibe\.tools[^)\s]*)\)( \(HTML\))?/g)];
        assert.ok(own.length >= 4, String(own.length));
        for (const [, url, html] of own) {
            const p = new URL(url).pathname;
            assert.ok(p.endsWith('.md') || /\.[a-z0-9]+$/.test(p) || p.startsWith('/api/') || html, `${url} is a twin, a file or marked (HTML)`);
        }
    } finally { srv.close(); }

    // ── IndexNow key file ───────────────────────────────────
    const mount = (key) => {
        const a = express();
        const ix = createToolsIndexNow(`https://${HOST}`, key);
        if (ix.enabled) a.use(ix.keyFile);
        else a.use((_req, res) => res.status(404).end());
        return a;
    };
    const off = await serve(mount(''));
    const offBase = `http://127.0.0.1:${off.address().port}`;
    try {
        assert.strictEqual(createToolsIndexNow(`https://${HOST}`, '').enabled, false, 'unset key is off');
        const r = await fetch(`${offBase}/${KEY}.txt`);
        assert.strictEqual(r.status, 404, 'unset key: the key file is not served');
    } finally { off.close(); }
    const on = await serve(mount(KEY));
    const onBase = `http://127.0.0.1:${on.address().port}`;
    try {
        const r = await fetch(`${onBase}/${KEY}.txt`);
        assert.strictEqual(r.status, 200, 'set key: the key file answers');
        assert.ok(/^text\/plain/.test(r.headers.get('content-type') || ''), 'the key file is text/plain');
        assert.strictEqual((await r.text()).trim(), KEY, 'the key file carries the key');
    } finally { on.close(); }

    console.log('llms-full + IndexNow: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
