'use strict';
// The home's headline, "Small tools that …" (the owner, 2026-11-09: slogans that "animate between" the many tools).
// Its last words change, and each phrase is a real link to its tool, already in the page: stacked in one grid cell
// so the swap never moves what is below, and readable by a crawler as plain links. The old one swapped bare text from
// a data attribute, linked nowhere, looped for ever and fell back to "help with <tool name>".
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const site = require('../server/pages/site');

(async () => {
    const app = express();
    app.use(site.createSiteRouter());
    const srv = http.createServer(app);
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
        const home = await (await fetch(`http://127.0.0.1:${srv.address().port}/`)).text();
        const rot = home.match(/<h1>Small tools that <span class="hm-rot" id="tool-headline">(.*?)<\/span><\/h1>/s);
        assert.ok(rot, 'the headline ends in the rotating phrases');
        const links = Array.from(rot[1].matchAll(/<a class="hm-ph( is-on)?" href="([^"]+)"([^>]*)>([^<]+)<\/a>/g));
        assert.ok(links.length >= 2 && links.length <= 6, `two to six phrases (${links.length})`);
        assert.strictEqual(links.filter((m) => m[1]).length, 1, 'one phrase shows');
        assert.ok(links[0][1], 'and it is the first: the page is whole without script');
        links.forEach((m, i) => {
            assert.match(m[2], /^(https:\/\/[a-z0-9.-]+\/|\/tool\/[a-z0-9-]+)/, `phrase ${i} links to a tool`);
            assert.match(m[4], /^[a-z][^<]{3,48}\.$/, `phrase ${i} reads as the end of the sentence: "${m[4]}"`);
            assert.ok(!/^help with /.test(m[4]), 'no form-letter fallback');
            // "Small tools that one reputation report for a domain or IP." (the owner, 2026-11-10): a phrase is a doing, never a thing.
            assert.ok(!/^(one|a|an|the|your|every|all)\b/.test(m[4]) && !/[?!]\.$/.test(m[4]), `phrase ${i} starts with a doing word: "${m[4]}"`);
            if (i) assert.ok(/aria-hidden="true"/.test(m[3]) && /tabindex="-1"/.test(m[3]), 'a phrase that is not showing is out of the tab order and unread');
        });
        assert.strictEqual(new Set(links.map((m) => m[2])).size, links.length, 'each phrase is a different tool');
        assert.ok(!home.includes('data-phrases='), 'the phrases are links in the page, not a data attribute');

        // The swap is CSS on shared timing, played under Calm and held only with motion off; the script goes once through, then rests.
        assert.match(home, /\.hm-rot\{display:grid\}\.hm-ph\{grid-area:1\/1;/, 'the phrases share one cell, so nothing below moves');
        assert.match(home, /html\[data-ov-motion=off\] \.hm-ph\{transform:none\}/);
        const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'site.js'), 'utf8');
        assert.ok(js.includes("getAttribute('data-ov-motion') === 'off'"), 'only motion off holds the first phrase');
        assert.ok(js.includes('if (next === 0) { rested = true;'), 'once through, then it rests');
        assert.ok(js.includes("el.matches(':hover') || el.contains(document.activeElement)"), 'it never changes under a pointer or the focus');
        console.log(`home-headline: ${links.length} phrases, each a link to its tool; one shows; once through, then still`);
    } finally {
        srv.close();
    }
})().catch((e) => { console.error(e); process.exit(1); });
