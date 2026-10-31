'use strict';
// The tool frame (openvibe-shared 4.55.0, owner ask 11): every net./dev. tool page has one order — head, box,
// answer slot, family, folds (About, Questions, Use it from code), people also use — with the catalogue's Try
// examples, the current tool marked in the family, and the real run API in the API fold. A ?q= link fills the box
// and runs once. The old centred hero and chip cloud are gone; the title, canonical and structured data stay.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { renderTool } = require('../server/seo/render');
const { CATALOG } = require('../server/seo/catalog');
const { frameFor } = require('../server/seo/frame');

const PUB = path.join(__dirname, '..', 'public');
const net = (sub, q) => renderTool(path.join(PUB, 'net.html'), sub, null, q ? { q } : {});
const dev = (sub, q) => renderTool(path.join(PUB, 'dev.html'), sub, null, q ? { q } : {});

/** The frame's order: each marker appears once, and in this order. */
function inOrder(html, parts) {
    let at = -1;
    for (const p of parts) {
        const i = html.indexOf(p, at + 1);
        assert.ok(i > at, `${p} after ${parts[parts.indexOf(p) - 1] || 'the top'} (${i} > ${at})`);
        at = i;
    }
}

// ── One network tool: whois ─────────────────────────────────
{
    const html = net('whois', 'openvibe.network');
    inOrder(html, ['<header class="ovk-tool-head', '<h1 class="ovk-tool-title">Whois Lookup</h1>', 'class="ovk-tool-card"', 'class="ovk-tool-out"', 'class="ovk-family"', 'class="ovk-tool-folds"', 'People also use']);
    assert.ok(html.includes('<a class="ovk-tool-crumb" href="https://net.openvibe.tools/">Network tools'), 'crumb is the family and its hub');
    assert.ok(html.includes('Look up domain registration details: registrar, creation and expiry dates, nameservers and status codes.'), 'the task is the catalogue\'s one sentence');
    assert.ok(html.includes('value="openvibe.network"'), 'the ?q= value is in the box');
    assert.ok(/<a href="\?q=openvibe\.network"[^>]*data-ovk-try="openvibe\.network"/.test(html), 'an example is a ?q= Try link');
    assert.ok(html.includes('data-ovk-try="wikipedia.org"') && html.includes('data-ovk-try="example.com"'), 'two or three examples');
    assert.ok(html.includes('aria-current="page"') && /aria-current="page"><span class="ovk-family-short">Whois<\/span>/.test(html), 'the family marks the current tool');
    assert.ok(html.includes('All 38'), 'the family links all 38 network tools');
    assert.ok(html.includes('Use it from code') && html.includes('https://openvibe.tools/api/v1/tools/whois/run') && html.includes('<code>target</code>'), 'the API fold has the real call and field');
    assert.ok(html.includes('About Whois Lookup') && html.includes('Questions') && html.includes('Why is the registrant hidden?'), 'the folds carry the about and FAQ copy');
    assert.ok(html.includes('<title>Whois Lookup — Domain Registration &amp; Ownership Checker | OpenVibe</title>'), 'the page title');
    assert.ok(html.includes('<link rel="canonical" href="https://whois.openvibe.tools">'), 'the canonical');
    assert.ok(html.includes('"@type":"SoftwareApplication"') && html.includes('"@type":"BreadcrumbList"') && html.includes('"@type":"FAQPage"'), 'the structured data');
    assert.strictEqual((html.match(/<h1/g) || []).length, 1, 'one h1');
    assert.ok(!html.includes('id="hero"') && !html.includes('id="tool-chips-area"'), 'the old hero and chip cloud are gone');
    assert.ok(html.includes('/shared/kit.css?') && html.includes('/shared/kit-data.css?') && html.includes('/shared/kit-data-web.js?'), 'the kit look and behaviour are loaded');
    assert.ok(html.includes('class="ov-tool-page"') && html.includes('brand'), 'the page is marked for the Tools brand');
}

// ── One code tool: jsonvalidate ─────────────────────────────
{
    const html = dev('jsonvalidate', '{"a":1}');
    inOrder(html, ['<header class="ovk-tool-head', '<h1 class="ovk-tool-title">JSON Validator</h1>', 'textarea class="ovk-tool-editor"', 'class="ovk-tool-out"', 'class="ovk-family"', 'class="ovk-tool-folds"', 'People also use']);
    assert.ok(html.includes('href="https://dev.openvibe.tools/">Code and data'), 'crumb is the code and data family');
    assert.ok(html.includes('data-ovk-try='), 'the code tool has Try examples');
    assert.ok(html.includes('>{&quot;a&quot;:1}</textarea>'), '?q= fills the editor');
    assert.ok(html.includes('aria-current="page"') && /aria-current="page"><span class="ovk-family-short">Validator<\/span>/.test(html), 'the family marks the current tool');
    assert.ok(html.includes('All 39'), 'the family links all 39 code and data tools');
    assert.ok(html.includes('https://openvibe.tools/api/v1/tools/jsonvalidate/run') && html.includes('<code>text</code>'), 'the API fold has the real call and field');
    assert.ok(html.includes('About JSON Validator') && html.includes('Questions'), 'the folds carry the copy');
    assert.ok(html.includes('<title>JSON Validator — JSON Lint Online | OpenVibe</title>'), 'the page title');
    assert.ok(html.includes('<link rel="canonical" href="https://jsonvalidate.openvibe.tools">'), 'the canonical');
    assert.strictEqual((html.match(/<h1/g) || []).length, 1, 'one h1');
    assert.ok(!html.includes('id="hero"'), 'the old hero is gone');
}

// ── ?q= fills the box and runs exactly once (both pages' own functions) ──
{
    const html = fs.readFileSync(path.join(PUB, 'net.html'), 'utf8');
    const from = html.indexOf('function queryValue(');
    const to = html.indexOf('function setupUI()', from);
    assert.ok(from > 0 && to > from, 'net.html keeps queryValue/runFromQuery together');
    const scope = new Function('location', 'document', 'runTool', `'use strict';\n${html.slice(from, to)}\nreturn { queryValue, runFromQuery };`);
    const input = { value: '' };
    let calls = 0;
    const doc = { getElementById: (id) => (id === 'search-input' ? input : null) };
    for (const search of ['?q=openvibe.network', '?target=dns.google', '?domain=example.com', '?ip=1.1.1.1']) {
        input.value = '';
        calls = 0;
        const api = scope({ search }, doc, () => { calls++; });
        assert.strictEqual(api.runFromQuery(), true, `runs for ${search}`);
        assert.strictEqual(calls, 1, `runs once for ${search}`);
        assert.ok(input.value.length > 0, `fills the box for ${search}`);
    }
    assert.strictEqual(scope({ search: '' }, doc, () => { calls++; }).runFromQuery(), false, 'no ?q=, no run');
}
{
    const html = fs.readFileSync(path.join(PUB, 'dev.html'), 'utf8');
    const from = html.indexOf('function devRunFromQuery(');
    const to = html.indexOf('\n}', from) + 2;
    assert.ok(from > 0 && to > from, 'dev.html has devRunFromQuery');
    const input = { value: '' }, second = { value: '' };
    const run = () => { calls++; };
    let calls = 0;
    const scope = new Function('location', '$', 'run', `'use strict';\n${html.slice(from, to)}\nreturn devRunFromQuery;`);
    const got = scope({ search: '?q=%7B%22a%22%3A1%7D&q2=b' }, (id) => (id === 'in1' ? input : id === 'in2' ? second : null), run);
    assert.strictEqual(got(), true, 'dev ?q= runs');
    assert.strictEqual(calls, 1, 'dev ?q= runs once');
    assert.strictEqual(input.value, '{"a":1}', 'dev fills the first box');
    assert.strictEqual(second.value, 'b', 'dev fills the second box');
}

// ── Every framed tool has the pieces; examples exist for every input tool ──
{
    let counted = 0;
    for (const rec of CATALOG.values()) {
        if (rec.hub || (rec.family !== 'net' && rec.family !== 'dev')) continue;
        const html = frameFor(rec);
        for (const needle of ['class="ovk-tool-head"', 'class="ovk-tool-card"', 'class="ovk-tool-out"', 'class="ovk-family"', 'class="ovk-tool-folds"', 'Use it from code']) {
            assert.ok(html.includes(needle), `${rec.sub}: ${needle}`);
        }
        assert.match(html, /aria-current="page"/, `${rec.sub}: the current tool is marked`);
        counted++;
        const inputs = rec.sub !== 'myip' && !['uuid', 'lorem', 'timestamp', 'webhook'].includes(rec.sub);
        if (inputs) assert.ok((rec.examples || []).length >= 2, `${rec.sub}: 2–3 Try examples`);
    }
    assert.strictEqual(counted, 77, 'every network and code and data tool page is framed');
}

console.log('tool frame: whois and jsonvalidate in order, Try links, ?q= once, current family tool, real API call: all checks passed');
