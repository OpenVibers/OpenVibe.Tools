'use strict';
// The home's job sections as one block (the owner's short-pages rule, 2026-10-30): on a phone a row of chips picks one
// job at a time, with radio inputs and :has() and no script; every section stays in the page; a wider screen, or a
// browser without :has(), shows them all and no chips.
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
        assert.match(block, /<div class="job-pick" role="radiogroup" aria-label="Tools by job">/);
        const radios = [...block.matchAll(/<input type="radio" name="job-pick" id="jp-([a-z]+)" value="\1"( checked)?><label for="jp-\1">[^<]+<\/label>/g)];
        assert.deepStrictEqual(radios.map((m) => m[1]), sections, 'one chip per section, in the same order');
        assert.deepStrictEqual(radios.filter((m) => m[2]).map((m) => m[1]), [sections[0]], 'the first job is picked');
        // The CSS: the chips and their heading only under 640 px and only with :has(); one rule shows each picked section.
        const css = home.slice(home.indexOf('.job-pick,.job-pick-h{display:none}'));
        assert.ok(css.startsWith('.job-pick,.job-pick-h{display:none}'), 'hidden by default');
        assert.match(css, /^\.job-pick,\.job-pick-h\{display:none\}\n@supports selector\(:has\(\*\)\)\{@media \(max-width:640px\)\{/);
        for (const id of sections) assert.ok(css.includes(`.jobs:has(#jp-${id}:checked) #job-${id}`), `${id} shows when its chip is picked`);
        assert.match(css, /\.job-pick label\{[^}]*min-height:44px/, 'a chip is a 44 px target');
        console.log('home jobs: all checks passed');
    } finally {
        srv.close();
    }
})().catch((e) => { console.error(e); process.exit(1); });
