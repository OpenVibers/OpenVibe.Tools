'use strict';
// The home on a phone (the owner's short-pages rule, 2026-10-30): the parts a reader rarely needs — the tools
// opened most this week, what shipped and the questions — fold closed, with a checkbox and a label and no script.
// Everything stays in the page for the crawlers, and where there is room the fold is open and looks like the section
// it replaces.
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
                + `<label class="fold-h" for="fold-${id}-open"><h2[^>]*>[^<]*${title}[^<]*(?:<span class="fold-count">\\d+</span>)?</h2>.*?<div class="fold-body">`);
            assert.ok(re.test(home), `the ${title} fold is on the home`);
        }
        // The parts themselves are in the page, not removed: every question and every site in the network.
        assert.ok((home.match(/<summary>[^<]+<\/summary>/g) || []).length >= 5, 'the questions are in the page');
        assert.match(home, /<summary>Do I need an account\?<\/summary>/, 'the questions keep their own summaries');
        assert.match(home, /class="net"/, 'the rest of OpenVibe is in the page');
        assert.match(home, /data-ov-shipped="list"/, 'what shipped is in the page');
        // What the home keeps: the search, the good places to start and the jobs.
        assert.match(home, /<form class="search"/, 'the search is where it was');
        assert.match(home, /<h2 id="start-h">Good places to start<\/h2>/, 'the good places to start are where they were');
        assert.match(home, /<div class="jobs"><div class="sec-h jobs-h"><h2>Tools by job<\/h2>/, 'the jobs are where they were');
        // A fold says what it holds (the owner's rule, 2026-10-31: folds show their count).
        assert.match(home, /<h2 id="faq-h">Questions <span class="fold-count">\d+<\/span><\/h2>/, 'the questions fold shows its count');
        // The CSS: the fold is closed on a phone and open where there is room.
        const css = home.slice(home.indexOf('/* The fold (the owner'));
        assert.ok(css.length > 0, 'the fold rules are on the page');
        assert.match(css, /\.fold-body\{display:none\}/, 'the body is closed by default');
        assert.match(css, /\.fold-toggle:checked~\.fold-body\{display:block\}/, 'the title row opens it');
        assert.match(css, /\.fold-toggle\{display:none\}/, 'the toggle is hidden where there is room');
        assert.match(css, /\.fold-body\{display:block\}/, 'the body is open where there is room');
        console.log('home short: all checks passed');
    } finally {
        srv.close();
    }
})().catch((e) => { console.error(e); process.exit(1); });
