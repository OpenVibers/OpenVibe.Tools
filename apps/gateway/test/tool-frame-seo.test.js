'use strict';
// Every tool subdomain in the sitemap still answers 200 with its own title and exactly one h1 (owner ask 11:
// the tool frame replaced the page's hero, and the hero used to carry the only h1 and its own title).
// Runs the gateway as it runs in production (its own process, Host-header routing) and asks each net./dev.
// host from the sitemap. The catalogue is the same list the sitemap is built from.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { startApp } = require('../../_shared/test/spawn');
const site = require('../server/pages/site');
const { CATALOG } = require('../server/seo/catalog');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const get = (port, host) => new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', headers: { Host: host, Connection: 'close' }, timeout: 15000 }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { body += d; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
    req.on('error', () => resolve({ status: 0, body: '' }));
});

(async () => {
    const tools = [...CATALOG.values()].filter((r) => !r.hub && (r.family === 'net' || r.family === 'dev'));
    const byHost = new Map(tools.map((r) => [`${r.sub}.openvibe.tools`, r]));
    const inSitemap = site.sitemapEntries().map((e) => String(e.loc).replace(/^https?:\/\//, '').replace(/\/$/, '')).filter((h) => byHost.has(h));
    assert.ok(inSitemap.length > 50, `the sitemap lists ${inSitemap.length} net./dev. tools`);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-tools-sitemap-'));
    const gw = await startApp('gateway', { DATA_DIR: tmp, OV_DOMAINS_URL: 'http://127.0.0.1:9/api/domains', OV_REGISTRY_URL: 'http://127.0.0.1:9/registry' });
    try {
        for (const host of inSitemap) {
            const rec = byHost.get(host);
            const r = await get(gw.port, host);
            assert.strictEqual(r.status, 200, `${host} answers 200`);
            assert.ok(r.body.includes(`<title>${esc(rec.title)} | OpenVibe</title>`), `${host} has its own title`);
            const h1 = r.body.match(/<h1[\s>]/g) || [];
            assert.strictEqual(h1.length, 1, `${host} has one h1`);
            assert.ok(r.body.includes(`<h1 class="ovk-tool-title">${esc(rec.name)}</h1>`), `${host} h1 is the tool's name`);
            assert.ok(r.body.includes(`<link rel="canonical" href="https://${host}">`), `${host} canonical`);
        }
    } finally {
        await gw.kill();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log(`tool frame sitemap: ${inSitemap.length} net./dev. subdomains answer 200 with their own title, canonical and one h1`);
})().catch((err) => { console.error(err); process.exit(1); });
