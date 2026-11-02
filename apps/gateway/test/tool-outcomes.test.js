'use strict';
// The tool page's outcome lines (market outcomes 1, 2, 3, 5 and 7):
//   • limits, where the work happens and the price are stated before the button
//   • "Similar tools" links the same family, at most six
//   • "People also call this" says what the tool is for and, when the catalogue's FAQ has one, what trips people up
// The numbers are read from each tool's descriptor and the guard's quota table, never copied into this test:
// the assertions name the measured values so a change in configuration fails here until the page follows it.
const assert = require('assert');
const registry = require('../server/registry');
const site = require('../server/pages/site');

const tools = registry.get().tools;
const byId = new Map(tools.map((t) => [t.id, t]));
const page = (id) => { const t = byId.get(id); assert.ok(t, `catalogue has ${id}`); return site.pageTool(t); };
const facts = (html) => (html.match(/<ul class="facts"[\s\S]*?<\/ul>/) || [''])[0];
const similar = (html) => (html.match(/<h2>Similar tools<\/h2>[\s\S]*?<\/section>/) || [''])[0];

// 1. A browser tool: no upload, no daily cap, free; no catalogue FAQ, so no invented "what trips people up".
{
    const html = page('fancy');
    const f = facts(html);
    assert.match(f, /<b>Limits<\/b> No daily limit on the page/, 'browser tools have no daily cap');
    assert.match(f, /<b>Where it runs<\/b> Runs in your browser; nothing is uploaded\./, 'browser work is stated');
    assert.match(f, /<b>Cost<\/b> Free, with the limits above\. No account needed\./, 'cost line');
    assert.doesNotMatch(f, /<details|hidden|display:\s*none/, 'the facts are never hidden');
    assert.match(html, /<p class="sec-p"><b>What it's for:<\/b> Stylish Unicode fonts to copy and paste\.<\/p>/, 'catalogue tagline as the purpose');
    assert.doesNotMatch(html, /What trips people up:/, 'no FAQ means no pitfall line');
    assert.match(html, /<h2>Similar tools<\/h2>/, 'similar tools heading');
    assert.doesNotMatch(html, /<h2>Related tools<\/h2>/, 'the old heading is gone');
}

// 2. A job tool: the descriptor's file/page limits, the job TTLs and the session-tier daily allowance.
{
    const html = page('mergepdf');
    const f = facts(html);
    assert.match(f, /100 MB per file/, 'descriptor maxBytes');
    assert.match(f, /2 to 50 files/, 'descriptor files.min/max');
    assert.match(f, /Up to 500 pages/, 'descriptor maxPages');
    assert.match(f, /Up to 375 runs a day/, 'session tools-job perDay 3000 / cost 8');
    assert.match(f, /Your file goes to our server and is deleted with the result after 1 hour, or after 24 hours when signed in\./, 'job TTLs');
}

// 3. An inline lookup: the address-tier allowance, the server statement and the catalogue's pitfall.
{
    const html = page('dns');
    const f = facts(html);
    assert.match(f, /No file upload/, 'no upload for a lookup');
    assert.match(f, /Up to 2,000 runs a day/, 'anonymous tools-fetch perDay 2000 / cost 1');
    assert.match(f, /Runs on our server; no file is uploaded\./, 'server-side lookup is stated');
    assert.match(html, /What it's for:<\/b> Look up DNS records for any domain/, 'catalogue description as the purpose');
    assert.match(html, /What trips people up:<\/b> <strong>Why do I still see the old DNS record\?<\/strong>/, 'catalogue FAQ as the pitfall');
}

// 4. Limits that come from the environment-backed config, and tools without a file upload.
{
    const video = facts(page('yt'));
    assert.match(video, /No file upload · Up to 3 hours · Up to 50 runs a day/, 'video download duration and cost-50 quota');
    assert.match(video, /Runs on our server; the result is deleted after 1 hour/, 'no file to call "your file"');
    const hook = facts(page('webhook'));
    assert.match(hook, /Up to 5,000 runs a day/, 'anonymous tools-run perDay');
    assert.match(hook, /Request bins are kept in memory for 1 hour\./, 'the descriptor states the bin retention');
    const img = facts(page('convert'));
    assert.match(img, /50 MB per file · 1 file at a time · Up to 600 runs a day/, 'image descriptor limits and session tools-job perDay 3000 / cost 5');
}

// 5. The leave-out case: a catalogue FAQ that is product information, not a pitfall, keeps the line out.
{
    const csv = page('csv');
    assert.match(csv, /What it's for:<\/b> Convert CSV to JSON/, 'purpose still shown');
    assert.doesNotMatch(csv, /What trips people up:/, 'no invented caveat for CSV');
}

// 6. Similar tools: only the same family, at most six, and left out when there are no siblings.
{
    for (const t of tools) {
        const s = similar(page(t.id));
        const n = (s.match(/class="tool"/g) || []).length;
        assert.ok(n <= 6, `${t.id}: at most six similar tools (${n})`);
        if (n) {
            const hrefs = [...s.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter((h) => h.startsWith('https://'));
            const urls = new Set(tools.filter((x) => x.family === t.family).map((x) => x.url));
            for (const href of hrefs) assert.ok(urls.has(href), `${t.id}: similar card stays in the family (${href})`);
        }
    }
    assert.doesNotMatch(page('yt'), /Similar tools/, 'a family of one tool has no similar block');
    assert.doesNotMatch(page('pastes'), /Similar tools/, 'an external tool with no siblings has no similar block');
}

// 7. Every page states the facts and the purpose; no page hides either.
for (const t of tools) {
    const html = page(t.id);
    assert.match(html, /<ul class="facts" aria-label="Limits, where it runs and cost">/, `${t.id}: facts block`);
    assert.match(html, /<b>Where it runs<\/b>/, `${t.id}: where line`);
    assert.match(html, /<b>Cost<\/b> Free/, `${t.id}: cost line`);
    assert.match(html, /<p class="sec-p"><b>What it's for:<\/b>/, `${t.id}: purpose line`);
}

console.log(`tool outcomes: ${tools.length} pages checked, limits + where + cost, similar tools, purpose and pitfall lines`);
