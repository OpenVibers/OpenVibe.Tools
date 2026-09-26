'use strict';
// /developers (the Tools API page): its long commands scroll inside their blocks instead of widening the page
// (the browser check, Host scripts/browser-check.js, found the page 858 px wide at 768 px), and a block that
// scrolls can be reached by keyboard.
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
        const r = await fetch(`http://127.0.0.1:${srv.address().port}/developers`);
        assert.strictEqual(r.status, 200);
        const html = await r.text();
        assert.ok(/pre\{max-width:100%;overflow-x:auto\}/.test(html), 'code blocks scroll inside');
        const pres = html.match(/<pre[^>]*>/g) || [];
        assert.ok(pres.length >= 1, 'the page shows commands');
        assert.ok(pres.every((p) => p === '<pre tabindex="0">'), 'every block is focusable');
        console.log('developers page: all checks passed');
    } finally { srv.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
