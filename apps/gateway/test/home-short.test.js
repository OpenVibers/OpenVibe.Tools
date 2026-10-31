'use strict';
// The home on a phone (the owner's rule, 2026-10-31): a short page never hides content. The folds that held the
// tools opened most this week, what shipped and the questions are open on every screen; every job group and every
// most-opened tool is on the page, and a long list scrolls sideways instead of dropping its later cards.
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
        // The folds that are on the home: the parts a reader rarely needs.
        for (const [id, title] of [['shipped', 'Recently shipped on OpenVibe.Tools'], ['faq', 'Questions'], ['net', 'The rest of OpenVibe']]) {
            const re = new RegExp(`<div class="fold-block" id="fold-${id}"><input class="fold-toggle" type="checkbox" id="fold-${id}-open">`
                + `<label class="fold-h" for="fold-${id}-open"><h2[^>]*>[^<]*${title}[^<]*</h2>.*?<div class="fold-body">`);
            assert.ok(re.test(home), `the ${title} fold is on the home`);
        }
        // The parts themselves are in the page, not removed: every question and every site in the network.
        assert.ok((home.match(/<summary>[^<]+<\/summary>/g) || []).length >= 5, 'the questions are in the page');
        assert.match(home, /<summary>Do I need an account\?<\/summary>/, 'the questions keep their own summaries');
        assert.match(home, /class="net"/, 'the rest of OpenVibe is in the page');
        assert.match(home, /data-ov-shipped="list"/, 'what shipped is in the page');
        // What the home keeps: the search and the good places to start.
        assert.match(home, /<form class="search"/, 'the search is where it was');
        assert.match(home, /<h2 id="start-h">Good places to start<\/h2>/, 'the good places to start are where they were');
        // Every job group stays on the page; the phone no longer picks one at a time.
        for (const id of ['files', 'text', 'audio', 'media', 'data', 'web', 'places']) {
            assert.ok(home.includes(`id="job-${id}"`), `the ${id} job group is on the page`);
        }
        // The CSS: no fold, job group or most-opened card is hidden on a phone, and every long row scrolls sideways.
        const css = home.slice(home.indexOf('/* The fold (the owner'));
        assert.ok(css.length > 0, 'the fold rules are on the page');
        assert.match(css, /\.fold-body\{display:block\}/, 'the fold body is open on every screen');
        assert.ok(!/\.fold-body\{display:none\}/.test(css), 'no fold body is hidden');
        assert.ok(!/nth-child\(n\+5\)[^{]*\{[^}]*display:none/.test(css), 'no most-opened tool is hidden');
        assert.ok(!/\.jobs \.job\{display:none/.test(css), 'no job group is hidden');
        assert.match(css, /section\[aria-labelledby="top-h"\] \.grid\{display:flex;overflow-x:auto/, 'the most-opened tools scroll sideways');
        console.log('home short: all checks passed');
    } finally {
        srv.close();
    }
})().catch((e) => { console.error(e); process.exit(1); });
