'use strict';
// The home's job sections (the owner's rule, 2026-10-31): every section is on the page and visible on every screen.
// A row of chips used to pick one job at a time on a phone; that hid the rest, so the chips are gone.
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
        const block = home.slice(home.indexOf('<div class="jobs">'), home.indexOf('<section class="fold" aria-labelledby="dev-h">'));
        assert.ok(block.startsWith('<div class="jobs">'), 'the jobs block is on the home');
        const sections = [...block.matchAll(/<section class="job" id="job-([a-z]+)"/g)].map((m) => m[1]);
        assert.ok(sections.length >= 5, `the job sections are all in the page (${sections.length})`);
        assert.ok(!block.includes('job-pick'), 'no chip row picks one job at a time');
        assert.ok(!home.includes('job-pick'), 'no job chip row in the page');
        // The CSS: no rule hides a job section on a phone.
        assert.ok(!/\.jobs \.job\{display:none/.test(home), 'no job section is hidden on a phone');
        assert.ok(!/:has\(#jp-[a-z]+:checked\) #job-/.test(home), 'no rule picks one job at a time');
        assert.match(block, /<div class="sec-h"><h2>Tools by job<\/h2>/, 'the block keeps its heading');
        console.log('home jobs: all checks passed');
    } finally {
        srv.close();
    }
})().catch((e) => { console.error(e); process.exit(1); });
