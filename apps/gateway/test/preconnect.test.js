'use strict';
// Exactly one preconnect to openvibe.network, with crossorigin: the Shared SEO head already adds
// one; a second one (without crossorigin) opens a wasted connection.
const assert = require('assert');
const http = require('http');
const express = require('express');
const site = require('../server/pages/site');

(async () => {
    const app = express();
    app.use(site.createSiteRouter());
    const srv = http.createServer(app);
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
        const home = await (await fetch(`http://127.0.0.1:${srv.address().port}/`)).text();
        const pcs = [...home.matchAll(/<link rel="preconnect" href="https:\/\/openvibe\.network"[^>]*>/g)].map((m) => m[0]);
        assert.strictEqual(pcs.length, 1, `exactly one openvibe.network preconnect, saw ${pcs.length}: ${pcs.join(' | ')}`);
        assert.ok(pcs[0].includes('crossorigin'), 'the preconnect carries crossorigin (CORS fetches)');
    } finally { srv.close(); }
    console.log('preconnect: one crossorigin hint to openvibe.network');
})().catch((e) => { console.error(e); process.exit(1); });
