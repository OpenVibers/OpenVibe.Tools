'use strict';
// The tool frame's terms, verb buttons and field labels (owner review of #155):
//   • one mode is the button's verb, several are the kit's segmented control and the button says the active one;
//     "Run" is never a label;
//   • the field label comes from the tool's descriptor, so MX asks for a Domain and a URL tool for a URL;
//   • facts: Free, where the work happens, the gateway's anonymous limit for the tool's quota class and whether
//     an account is needed. A page-side tool never claims the server, and a server tool never claims the browser.
//   • the catalogue's modes and the page's own processors (dev.html T[..].m) stay equal.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { CATALOG } = require('../server/seo/catalog');
const { frameFor } = require('../server/seo/frame');
const { snapshot } = require('../server/registry/descriptors');

const PUB = path.join(__dirname, '..', 'public');
const framed = [...CATALOG.values()].filter((r) => !r.hub && (r.family === 'net' || r.family === 'dev'));
const descriptors = new Map(snapshot().tools.map((d) => [d.id, d]));
const labelOf = (html) => { const m = /<label class="ovk-tool-label"[^>]*>(.*?)<\/label>/.exec(html); return m ? m[1] : null; };
const factsOf = (html) => {
    const m = /<ul class="ovk-tool-facts">([\s\S]*?)<\/ul>/.exec(html);
    if (!m) return [];
    return m[1].replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<\/li>\s*<li>/g, '\n').replace(/<[^>]+>/g, '').split('\n').map((s) => s.trim()).filter(Boolean);
};
const buttonOf = (html) => {
    const m = /<button[^>]*id="tool-run"[^>]*data-mode="([^"]+)"[^>]*>\s*<span>([^<]+)<\/span>/.exec(html);
    return m ? { mode: m[1], label: m[2] } : null;
};

// ── The field label matches the descriptor ─────────────────
{
    for (const rec of framed.filter((r) => r.family === 'net' && r.sub !== 'myip')) {
        const d = descriptors.get(rec.sub);
        assert.ok(d, `${rec.sub}: descriptor`);
        const desc = String((d.input.properties.target && d.input.properties.target.description) || '');
        const label = labelOf(frameFor(rec));
        assert.ok(label, `${rec.sub}: a field label`);
        assert.notStrictEqual(label, 'Domain, IP address or URL', `${rec.sub}: no generic label`);
        if (/^A domain$/i.test(desc)) assert.strictEqual(label, 'Domain', `${rec.sub}: ${desc} → Domain`);
        else if (/^A domain or an IP address, or a URL/i.test(desc)) assert.strictEqual(label, 'Domain, IP or URL', `${rec.sub}: ${desc}`);
        else if (/^A domain or an IP address/i.test(desc) || /^A domain or a public IP address/i.test(desc) || /^An IPv4 address or a domain/i.test(desc)) assert.strictEqual(label, 'Domain or IP', `${rec.sub}: ${desc}`);
        else if (/^An IPv4 address, a CIDR block/i.test(desc)) assert.strictEqual(label, 'IPv4, CIDR or domain', `${rec.sub}: ${desc}`);
        else if (/^An IPv6 address or a domain/i.test(desc)) assert.strictEqual(label, 'IPv6 or domain', `${rec.sub}: ${desc}`);
        else if (/^A sitemap URL/i.test(desc)) assert.strictEqual(label, 'Sitemap URL or domain', `${rec.sub}: ${desc}`);
        else if (/^A URL,/i.test(desc)) assert.strictEqual(label, 'URL or domain', `${rec.sub}: ${desc}`);
        else if (/^A mail server/i.test(desc)) assert.strictEqual(label, 'Mail server or domain', `${rec.sub}: ${desc}`);
        if (/ip/i.test(desc)) assert.match(label, /IP/i, `${rec.sub}: the label names IP when the input takes one`);
        if (/url/i.test(desc)) assert.match(label, /URL/i, `${rec.sub}: the label names URL when the input takes one`);
    }
    for (const id of ['mx', 'txt', 'spf', 'dkim', 'dmarc', 'dns', 'ns', 'dig', 'nslookup', 'dnspropagation']) {
        assert.strictEqual(labelOf(frameFor(CATALOG.get(id))), 'Domain', `${id}: a domain field`);
    }
    assert.strictEqual(labelOf(frameFor(CATALOG.get('whois'))), 'Domain or IP');
    assert.strictEqual(labelOf(frameFor(CATALOG.get('headers'))), 'URL or domain');
}

// ── One mode is the button; several are the kit segmented control ──
{
    for (const rec of framed.filter((r) => r.family === 'dev')) {
        const html = frameFor(rec);
        const modes = rec.modes || [];
        assert.ok(modes.length >= 1, `${rec.sub}: has a mode`);
        const btn = buttonOf(html);
        assert.ok(btn, `${rec.sub}: a verb button`);
        assert.strictEqual(btn.mode, modes[0], `${rec.sub}: the button's data-mode is the first mode`);
        assert.strictEqual(btn.label, modes[0], `${rec.sub}: the button says the verb`);
        assert.ok(!/<span>Run<\/span>/.test(html), `${rec.sub}: never Run`);
        if (modes.length === 1) {
            assert.ok(!html.includes('class="ovk-seg"'), `${rec.sub}: a single mode has no mode row`);
        } else {
            assert.ok(html.includes('class="ovk-seg"'), `${rec.sub}: the modes use kit.seg`);
            assert.ok(html.includes('<div id="modes" class="ovk-tool-modes">'), `${rec.sub}: the modes sit in the frame row`);
            const radios = [...html.matchAll(/<input type="radio" name="mode" value="([^"]+)"( checked)?>/g)];
            assert.deepStrictEqual(radios.map((r) => r[1]), modes, `${rec.sub}: every mode is an option`);
            assert.ok(radios[0][2], `${rec.sub}: the first mode is checked`);
        }
    }
    for (const rec of framed.filter((r) => r.family === 'net')) {
        const html = frameFor(rec);
        assert.ok(!html.includes('class="ovk-seg"'), `${rec.sub}: network tools have no mode row`);
        assert.ok(!/<span>Run<\/span>/.test(html), `${rec.sub}: never Run`);
    }
    assert.strictEqual(buttonOf(frameFor(CATALOG.get('jsonvalidate'))).label, 'Validate');
    assert.strictEqual(buttonOf(frameFor(CATALOG.get('codediff'))).label, 'Compare');
    assert.strictEqual(buttonOf(frameFor(CATALOG.get('base64'))).label, 'Encode');
    assert.strictEqual(buttonOf(frameFor(CATALOG.get('webhook'))).label, 'Create Bin');
}

// ── The catalogue's modes and dev.html's processors agree ──
{
    const html = fs.readFileSync(path.join(PUB, 'dev.html'), 'utf8');
    const block = html.slice(html.indexOf('const T={'), html.indexOf('const CATS='));
    const T = new Function(`${block}; return T;`)();
    for (const rec of framed.filter((r) => r.family === 'dev')) {
        assert.deepStrictEqual(rec.modes, T[rec.sub] && T[rec.sub].m, `${rec.sub}: dev.html's modes`);
    }
}

// ── Facts: Free, the work's place, the anonymous limit, an account or not ──
{
    const whois = factsOf(frameFor(CATALOG.get('whois')));
    assert.deepStrictEqual(whois.slice(0, 2), ['Free', 'Runs on our server'], 'whois: free, on our server');
    assert.ok(whois.includes('60 lookups a minute without an account'), 'whois: the tools-fetch limit from the guard');
    assert.ok(whois.includes('No sign-up'), 'whois: anonymous');

    const fmt = factsOf(frameFor(CATALOG.get('jsonfmt')));
    assert.deepStrictEqual(fmt.slice(0, 2), ['Free', 'Runs in your browser: nothing is sent'], 'jsonfmt: in the page');
    assert.ok(fmt.includes('No limit: it runs on your device'), 'jsonfmt: no gateway limit on a page-side tool without an API');
    assert.ok(fmt.includes('No sign-up'));

    const validate = factsOf(frameFor(CATALOG.get('jsonvalidate')));
    assert.deepStrictEqual(validate.slice(0, 2), ['Free', 'Runs in your browser: nothing is sent']);
    assert.ok(validate.includes('API: 120 runs a minute without an account'), 'jsonvalidate: its API class limit is named');

    const og = factsOf(frameFor(CATALOG.get('opengraph')));
    assert.ok(og.includes('Runs on our server'), 'opengraph: the page calls the run API');
    assert.ok(!og.includes('Runs in your browser: nothing is sent'));

    for (const id of ['ping', 'port', 'traceroute', 'mtr', 'latency', 'smtp']) {
        const facts = factsOf(frameFor(CATALOG.get(id)));
        assert.ok(facts.includes('Needs a free account'), `${id}: probes and SMTP need an account`);
        assert.ok(!facts.some((f) => /without an account$/.test(f)), `${id}: no anonymous limit claim`);
        assert.ok(!facts.includes('No sign-up'), `${id}: no anonymous claim`);
    }

    for (const rec of framed) {
        const facts = factsOf(frameFor(rec));
        assert.ok(facts.includes('Free'), `${rec.sub}: Free`);
        const browser = facts.includes('Runs in your browser: nothing is sent');
        const server = facts.includes('Runs on our server');
        assert.notStrictEqual(browser, server, `${rec.sub}: exactly one place for the work`);
        const expectedServer = rec.family === 'net' || ['opengraph', 'read', 'webhook'].includes(rec.sub);
        assert.strictEqual(server, expectedServer, `${rec.sub}: the work's place matches the page`);
    }

    const saved = process.env.TOOLS_GUARD_LIMITS;
    try {
        process.env.TOOLS_GUARD_LIMITS = JSON.stringify({ 'tools-fetch': { anonymous: { perMinute: 7 } } });
        assert.ok(factsOf(frameFor(CATALOG.get('whois'))).includes('7 lookups a minute without an account'), 'the limit follows the config');
        process.env.TOOLS_GUARD_LIMITS = JSON.stringify({ 'tools-run': { anonymous: { perMinute: 9 } } });
        assert.ok(factsOf(frameFor(CATALOG.get('base64'))).includes('API: 9 runs a minute without an account'), 'the API limit follows the config');
    } finally {
        if (saved === undefined) delete process.env.TOOLS_GUARD_LIMITS;
        else process.env.TOOLS_GUARD_LIMITS = saved;
    }
}

console.log(`tool frame terms: ${framed.length} pages, labels from descriptors, verb buttons and kit.seg, facts from the guard config: all checks passed`);
