'use strict';
// The home's job sections as one block. The owner's rule (2026-10-31): never hide content to shorten a page. Every job
// section is shown at every width, each says how many tools it has, and on a phone a job with more than four tools is a
// sideways rail of two rows. No chips, no radio inputs, no section hidden.
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
        const sections = block.match(/<section class="job" id="job-([a-z]+)"/g).map((s) => /job-([a-z]+)/.exec(s)[1]);
        assert.ok(sections.length >= 5, `the job sections are all in the page (${sections.length})`);
        assert.doesNotMatch(home, /type="radio"|job-pick|jp-/, 'no chips pick one job at a time');
        assert.match(block, /^<div class="jobs"><div class="sec-h jobs-h"><h2>Tools by job<\/h2><a class="more" href="\/all-tools">All tools<\/a><\/div>/);
        for (const id of sections) {
            const sec = block.slice(block.indexOf(`<section class="job" id="job-${id}"`));
            const m = /<span class="sec-count">(\d+) tools?<\/span>/.exec(sec.slice(0, sec.indexOf('</div>')));
            assert.ok(m && Number(m[1]) > 0, `${id} says how many tools it has`);
        }
        // The CSS: no rule hides a job section, and the rail is the phone's layout for a job of five tools or more.
        assert.doesNotMatch(home, /\.jobs? \.job\{display:none/, 'no job section is hidden');
        assert.match(home, /@media \(max-width:640px\)\{\n\.jobs-h\{display:flex/);
        assert.match(home, /\.jobs \.job \.tiles:has\(>\.tile:nth-child\(5\)\)\{[^}]*grid-auto-flow:column[^}]*overflow-x:auto/, 'a rail scrolls sideways');
        console.log('home jobs: all checks passed');
    } finally {
        srv.close();
    }
})().catch((e) => { console.error(e); process.exit(1); });
