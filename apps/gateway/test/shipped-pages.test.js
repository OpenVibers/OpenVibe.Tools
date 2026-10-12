'use strict';
// The shared update system on openvibe.tools: the home shows what shipped, /updates is the log (the
// same markup every OpenVibe site renders, from openvibe-shared/frame), and the footer links it.
const assert = require('assert');
const http = require('http');
const express = require('express');
const site = require('../server/pages/site');

(async () => {
    const app = express();
    app.use(site.createSiteRouter());
    const srv = http.createServer(app);
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    try {
        const home = await (await fetch(`${base}/`)).text();
        assert.ok(home.includes('data-ov-shipped="latest" data-service="tools" href="/updates"'), 'home pill');
        assert.ok(home.includes('data-ov-shipped="list" data-service="tools"'), 'home recent list');
        assert.ok(home.includes('data-service="tools" href="/updates"') && home.includes('>Updates</a>'), 'the footer line and Updates link');
        // The shared navbar's deferred script lands in a mount that already holds its height (no layout shift);
        // without JavaScript the mount goes away and the plain topbar shows.
        assert.ok(home.includes('<div id="navbar-mount"></div><noscript><style>#navbar-mount{display:none}</style><header class="topbar">') && home.indexOf('id="navbar-mount"') < home.indexOf('<main'), 'navbar mount before the noscript topbar and the page');
        assert.ok(home.includes('#navbar-mount{min-height:52px}'), 'the mount holds the navbar height');
        const r = await fetch(`${base}/updates`);
        assert.strictEqual(r.status, 200);
        const up = await r.text();
        assert.ok(up.includes('What shipped on OpenVibe.Tools') && up.includes('data-ov-shipped="log" data-service="tools"'));
        assert.ok(up.includes('<link rel="canonical" href="https://openvibe.tools/updates"'));
        assert.ok(site.sitemapEntries().some((u) => u.loc === 'https://openvibe.tools/updates'));
        console.log('shipped pages: all checks passed');
    } finally { srv.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
