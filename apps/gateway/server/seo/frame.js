'use strict';

// ═══════════════════════════════════════════════════════════════
// The tool frame for net.* and dev.* tool pages (openvibe-shared 4.55.0, owner ask 11).
//
// One order for every tool page: the tool's head, the box you type in, the answer (.ovk-tool-out, drawn by the
// page's own run code), the family, the folds (About, Questions, Use it from code) and "People also use". The
// markup is openvibe-shared/kit's; this module only chooses the copy and the links, from the catalogue, the
// families map and the tool descriptors. Nothing here restyles the kit.
//
// A page's answer is drawn in the browser (a net lookup calls the run API; a dev tool transforms text), so the
// server renders the frame empty and the page fills `.ovk-tool-out` with the same kit.answer builder
// (window.OpenVibeKit.answer). The catalogue's `examples` become the Try links under the box.
// ═══════════════════════════════════════════════════════════════

const kit = require('openvibe-shared/kit');
const serve = require('openvibe-shared/serve');
const { CATALOG, relatedTo } = require('./catalog');
const registry = require('../registry');
const { FAMILY_MAP } = require('../registry/families');
const { quotas } = require('../../../_shared/guard/limits');

const SITE = 'https://openvibe.tools';
const esc = kit.esc;

// The frame's family: the two families this part covers, with the owner's fixed tints (kit.toolHead hue). The
// hub link and the family membership come from the registry's families map; the display names are the frame's.
const hubOf = (id) => { const f = FAMILY_MAP.get(id); return f && f.hub ? `https://${f.hub}.openvibe.tools/` : 'https://openvibe.tools/'; };
const FAMILY = {
    net: { id: 'net', label: 'Network tools', more: 'More network tools', hue: 190, hub: hubOf('net'), icon: 'globe' },
    dev: { id: 'dev', label: 'Code and data', more: 'More code and data tools', hue: 265, hub: hubOf('dev'), icon: 'code' },
};

const HOST = new Map();        // tool id → page host, from the registry (owner overrides included)
function hostOf(id) {
    if (!HOST.size) for (const t of registry.get().tools) HOST.set(t.id, t.hosts.canonical);
    return HOST.get(id) || `${id}.openvibe.tools`;
}

// Short names for the family row on a phone; the full name shows from 1024 px (kit.family).
const SHORT = {
    lookup: 'All-in-one', myip: 'My IP', ip: 'IP', ipv4: 'IPv4/CIDR', ipv6: 'IPv6', geoip: 'GeoIP', hostname: 'Hostname',
    isp: 'ISP', asn: 'ASN', rdns: 'Reverse DNS', whois: 'Whois', rdap: 'RDAP', dns: 'DNS', dig: 'dig', nslookup: 'NSLookup',
    dnspropagation: 'Propagation', mx: 'MX', txt: 'TXT', ns: 'NS', spf: 'SPF', dkim: 'DKIM', dmarc: 'DMARC', ping: 'Ping',
    traceroute: 'Traceroute', mtr: 'MTR', port: 'Ports', headers: 'Headers', redirects: 'Redirects', ssl: 'SSL', curl: 'curl',
    httpstatus: 'Status', latency: 'Latency', blacklist: 'Blacklist', reputation: 'Reputation', smtp: 'SMTP', uptime: 'Uptime',
    robots: 'robots.txt', sitemap: 'Sitemap',
    jsonfmt: 'Formatter', yaml: 'YAML', xml: 'XML', csv: 'CSV', sql: 'SQL', md: 'Markdown', html: 'HTML', base64: 'Base64',
    url: 'URL', jwt: 'JWT', uuid: 'UUID', hash: 'Hash', hex: 'Hex', entities: 'Escape', timestamp: 'Timestamp', cron: 'Cron',
    beautify: 'Beautify', minify: 'Minify', codediff: 'Diff', regex: 'Regex', slugify: 'Slug', lorem: 'Lorem',
    curlconvert: 'curl', webhook: 'Webhook', color: 'Colour', opengraph: 'Open Graph', read: 'Reader', jsminify: 'JS minify',
    jsformat: 'JS format', cssminify: 'CSS minify', cssformat: 'CSS format', htmlminify: 'HTML minify', xmlminify: 'XML minify',
    jsonminify: 'JSON minify', jsonparse: 'JSON parser', jsonvalidate: 'Validator', jsonstringify: 'Stringify',
    html2md: 'HTML→MD', md2html: 'MD→HTML',
};

// The nearest kit icon (kit.ICONS); the family icon is the fallback.
const ICON = {
    lookup: 'search', myip: 'user', ip: 'globe', ipv4: 'grid', ipv6: 'code', geoip: 'map', hostname: 'server', isp: 'cloud',
    asn: 'list', rdns: 'swap', whois: 'book', rdap: 'file', dns: 'list', dig: 'terminal', nslookup: 'terminal',
    dnspropagation: 'globe', mx: 'mail', txt: 'file', ns: 'server', spf: 'shield', dkim: 'key', dmarc: 'shield', ping: 'zap',
    traceroute: 'map', mtr: 'chart', port: 'grid', headers: 'list', redirects: 'swap', ssl: 'lock', curl: 'terminal',
    httpstatus: 'check', latency: 'clock', blacklist: 'ban', reputation: 'star', smtp: 'mail', uptime: 'heart',
    robots: 'robot', sitemap: 'map',
    jsonfmt: 'code', yaml: 'file', xml: 'file', csv: 'grid', sql: 'grid', md: 'book', html: 'code', base64: 'lock',
    url: 'link', jwt: 'key', uuid: 'tag', hash: 'shield', hex: 'terminal', entities: 'code', timestamp: 'clock',
    cron: 'calendar', beautify: 'spark', minify: 'filter', codediff: 'swap', regex: 'search', slugify: 'link', lorem: 'book',
    curlconvert: 'terminal', webhook: 'send', color: 'palette', opengraph: 'eye', read: 'book', jsminify: 'filter',
    jsformat: 'spark', cssminify: 'filter', cssformat: 'spark', htmlminify: 'filter', xmlminify: 'filter',
    jsonminify: 'filter', jsonparse: 'list', jsonvalidate: 'check', jsonstringify: 'code', html2md: 'file', md2html: 'file',
};

const PLACEHOLDER = {
    net: 'example.com or 1.1.1.1',
    dev: 'Paste your input',
};
const DEV_PLACEHOLDER = {
    jsonfmt: 'Paste JSON', jsonvalidate: 'Paste JSON to check', jsonparse: 'Paste JSON', jsonminify: 'Paste JSON',
    jsonstringify: 'Paste JSON, or an escaped string', yaml: 'Paste YAML', xml: 'Paste XML', xmlminify: 'Paste XML',
    csv: 'Paste CSV', sql: 'Paste a SQL query', md: 'Type or paste Markdown', md2html: 'Type or paste Markdown',
    html: 'Paste HTML', html2md: 'Paste HTML', htmlminify: 'Paste HTML', base64: 'Text, or Base64 to decode',
    url: 'A URL or a value to encode', jwt: 'Paste a JSON Web Token', hash: 'Text to hash', hex: 'Text or hex bytes',
    entities: 'A string to escape', cron: 'A cron expression', beautify: 'Paste code', minify: 'Paste code',
    codediff: 'The original text', regex: 'A regular expression', slugify: 'A title', curlconvert: 'Paste a curl command',
    color: '#a78bfa or rgb(167, 139, 250)', opengraph: 'https://example.com', read: 'https://example.com',
    jsminify: 'Paste JavaScript', jsformat: 'Paste JavaScript', cssminify: 'Paste CSS', cssformat: 'Paste CSS',
    uuid: 'A UUID to check (optional)', lorem: 'Words, sentences or paragraphs (optional)', timestamp: 'A Unix time or a date',
};
const URL_TOOLS = new Set(['headers', 'curl', 'httpstatus', 'redirects', 'uptime', 'robots', 'sitemap', 'opengraph', 'read']);
// Where the work happens: every net. tool is a server lookup; in dev., only these three call the server (dev.html's
// P.opengraph, P.read and P.webhook). The rest compute in the page, so they must not claim the server.
const SERVER_DEV = new Set(['opengraph', 'read', 'webhook']);
const serverWork = (rec) => rec.family === 'net' || SERVER_DEV.has(rec.sub);

/** A page that gets the frame: a catalogued net./dev. tool, not the family hub. */
const isFramed = (rec) => !!rec && !rec.hub && (rec.family === 'net' || rec.family === 'dev');

const firstSentence = (s) => {
    const t = String(s || '').trim();
    const i = t.search(/[.!?](\s|$)/);
    return i > 0 ? t.slice(0, i + 1) : t;
};
const sentence = (s) => { const t = firstSentence(s).trim(); return t && !/[.!?]$/.test(t) ? `${t}.` : t; };

/** The one-line task for the head: the catalogue's first sentence. */
const taskOf = (rec) => sentence(rec.desc);

function shortLabel(value) {
    const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return s.length <= 28 ? s : `${s.slice(0, 27).trimEnd()}…`;
}

function placeholderFor(rec) {
    if (rec.family === 'dev') {
        if (DEV_PLACEHOLDER[rec.sub]) return DEV_PLACEHOLDER[rec.sub];
        const ex = (rec.examples || []).find((e) => typeof e === 'string');
        return ex ? shortLabel(ex).replace(/…$/, '') : PLACEHOLDER.dev;
    }
    if (rec.sub === 'whois') return 'example.com or 1.1.1.1';
    if (URL_TOOLS.has(rec.sub)) return 'https://example.com';
    if (['dns', 'dig', 'nslookup', 'mx', 'txt', 'ns', 'spf', 'dkim', 'dmarc', 'dnspropagation'].includes(rec.sub)) return 'example.com';
    if (['ip', 'ipv4', 'ipv6', 'geoip', 'hostname', 'isp', 'asn', 'rdns', 'blacklist', 'reputation'].includes(rec.sub)) return '1.1.1.1 or example.com';
    return PLACEHOLDER.net;
}

// Short labels for values too long to read as a pill (a paste of JSON reads as "One object", not as its first 28 characters).
const TRY_LABELS = {
    jsonfmt: ['One object', 'Nested', 'Broken JSON'], jsonvalidate: ['Valid JSON', 'Trailing comma'],
    jsonparse: ['A user object', 'A list'], jsonminify: ['Pretty JSON', 'One line'], jsonstringify: ['A JSON value', 'An escaped string'],
    base64: ['Text', 'Domain', 'Sentence'], url: ['A long URL', 'A query value', 'A URL'],
    whois: ['openvibe.network', 'wikipedia.org', 'example.com'], dns: ['openvibe.network', 'wikipedia.org', 'example.com'],
    mx: ['openvibe.network', 'gmail.com', 'wikipedia.org'], txt: ['openvibe.network', 'example.com', 'wikipedia.org'],
    headers: ['openvibe.network', 'example.com', 'wikipedia.org'], ssl: ['openvibe.network', 'wikipedia.org', 'example.com'],
};

/** The Try items the kit can draw: one-box tools only (a two-box tool gets its own pair links in the page). */
function tryItems(rec) {
    const labels = TRY_LABELS[rec.sub] || [];
    return (rec.examples || []).filter((e) => typeof e === 'string').slice(0, 3).map((value, i) => ({ value, label: labels[i] || shortLabel(value) }));
}

/** The field's label, from the tool's own descriptor: "A domain" is Domain, "A domain or an IP address" is
 *  Domain or IP, and a URL tool says so. The label must match what the input accepts. */
function fieldLabel(rec) {
    const d = descriptorOf(rec.sub);
    const target = d && d.input && d.input.properties && d.input.properties.target;
    const desc = String((target && target.description) || '');
    if (/^A domain or an IP address, or a URL/i.test(desc)) return 'Domain, IP or URL';
    if (/^An IPv4 address, a CIDR block/i.test(desc)) return 'IPv4, CIDR or domain';
    if (/^An IPv6 address or a domain/i.test(desc)) return 'IPv6 or domain';
    if (/^A domain or a public IP address/i.test(desc)) return 'Domain or IP';
    if (/^A domain or an IP address/i.test(desc)) return 'Domain or IP';
    if (/^An IPv4 address or a domain/i.test(desc)) return 'Domain or IP';
    if (/^A mail server/i.test(desc)) return 'Mail server or domain';
    if (/^A sitemap URL/i.test(desc)) return 'Sitemap URL or domain';
    if (/^A URL,/i.test(desc)) return 'URL or domain';
    if (/^A domain$/i.test(desc)) return 'Domain';
    return 'Domain, IP address or URL';
}

/** The tool's terms, from its real configuration: cost, where the work happens, the gateway's anonymous limit
 *  for its quota class (the same table the API docs show) and whether an account is needed. A page-side tool
 *  says so and, when it has an API, names the API's limit; it never pretends to be a server run. */
function factsFor(rec) {
    const d = descriptorOf(rec.sub);
    const onServer = serverWork(rec);
    const q = d && d.quotaClass && quotas()[d.quotaClass];
    const anonymous = !(d && d.auth && d.auth.anonymous === false);
    const facts = [
        { text: 'Free', icon: 'gift' },
        { text: onServer ? 'Runs on our server' : 'Runs in your browser: nothing is sent', icon: onServer ? 'server' : 'computer' },
    ];
    if (onServer) {
        if (!anonymous) facts.push({ text: 'Needs a free account', icon: 'user' }, { text: 'No sign-up for lookups', icon: 'globe' });
        else {
            if (q) facts.push({ text: `${q.anonymous.perMinute} ${rec.family === 'net' ? 'lookups' : 'runs'} a minute without an account`, icon: 'clock' });
            facts.push({ text: 'No sign-up', icon: 'user' });
        }
    } else {
        if (d && d.api && q) facts.push({ text: `API: ${q.anonymous.perMinute} ${rec.family === 'net' ? 'lookups' : 'runs'} a minute without an account`, icon: 'clock' });
        else facts.push({ text: 'No limit: it runs on your device', icon: 'zap' });
        facts.push({ text: 'No sign-up', icon: 'user' });
    }
    return facts;
}

/** The box: kit.toolInput for a lookup, a kit editor for a text tool. */
function inputFor(rec, value = '') {
    if (rec.family === 'net') {
        if (rec.sub === 'myip') {
            return `<form class="ovk-tool-form" data-ovk-tool-form>`
                + `<button type="submit" class="ovk-btn ovk-btn--primary ovk-tool-go">${kit.icon('globe')}<span>Show my IP</span></button></form>`;
        }
        const input = kit.toolInput({
            name: 'q', id: 'search-input', label: fieldLabel(rec), placeholder: placeholderFor(rec), value,
            button: rec.sub === 'lookup' ? 'Look up all' : 'Look up', icon: 'search',
            inputmode: URL_TOOLS.has(rec.sub) ? 'url' : 'text',
            tries: tryItems(rec).length ? { items: tryItems(rec) } : null,
        });
        return `${input}<div id="options-area" class="ovk-tool-options"></div>`;
    }

    const ex = rec.examples || [];
    const second = typeof ex[1] === 'string' ? ex[1] : '';
    const dual = rec.sub === 'codediff' || rec.sub === 'regex';
    const modes = rec.modes || [];
    const active = modes[0] || 'Go';
    const seg = modes.length > 1 ? `<div id="modes" class="ovk-tool-modes">${kit.seg({ name: 'mode', options: modes.map((m) => [m, m]), value: active })}</div>` : '';
    const tries = tryItems(rec).length
        ? kit.tries({ name: 'q', target: '#in1', items: tryItems(rec) })
        : (dual ? pairTries(rec) : '');
    return `<form class="ovk-tool-form" data-ovk-tool-form data-ov-tool="${esc(rec.sub)}">
<textarea class="ovk-tool-editor" id="in1" name="q" spellcheck="false" placeholder="${esc(placeholderFor(rec))}" aria-label="${esc(rec.name)} input">${esc(value || '')}</textarea>
${dual ? `<textarea class="ovk-tool-editor" id="in2" name="q2" spellcheck="false" aria-label="${esc(rec.name)} second input" placeholder="${esc(second ? shortLabel(second) : 'The second value')}"></textarea>` : ''}
${seg}
<div class="ovk-tool-buttons"><button type="submit" id="tool-run" data-mode="${esc(active)}" class="ovk-btn ovk-btn--primary ovk-tool-go"><span>${esc(active)}</span></button><button type="button" class="ovk-btn ovk-btn--quiet ovk-btn--small" id="tool-clear">${kit.icon('close')}<span>Clear</span></button></div>
${tries}</form>`;
}

/** Two-box tools: a pair fills both boxes and runs (the kit's Try link fills only one). */
function pairTries(rec) {
    const pairs = (rec.examples || []).filter(Array.isArray).slice(0, 3);
    if (!pairs.length) return '';
    return `<p class="ovk-try"><span>Try</span>${pairs.map(([a, b], i) => {
        const href = `?q=${encodeURIComponent(a)}&q2=${encodeURIComponent(b)}`;
        return `<a href="${esc(href)}" data-ov-try-two="${esc(JSON.stringify([a, b]))}">${esc(i === 0 ? 'Example' : `Example ${i + 1}`)}</a>`;
    }).join('')}</p>`;
}

function aboutFold(rec) {
    const bullets = (rec.bullets || []).length ? `<ul>${rec.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : '';
    return kit.fold({ id: 'about-this-tool', title: `About ${rec.name}`, body: `<p>${esc(rec.about || rec.desc || '')}</p>${bullets}` });
}

function questionsFold(rec) {
    const faq = rec.faq || [];
    if (!faq.length) return '';
    const body = faq.map(([q, a]) => `<p><strong>${esc(q)}</strong></p><p>${esc(a)}</p>`).join('');
    return kit.fold({ title: 'Questions', meta: String(faq.length), body });
}

// curl quoting for a value with single quotes (site/pages/site.js's shq).
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function descriptorOf(id) {
    try { return require('../registry/descriptors').snapshot().tools.find((d) => d.id === id) || null; } catch { return null; }
}

/** An input sample for a tool whose descriptor has no example: its real field names and a public value for each. */
function sampleInput(rec, d) {
    const ex = (d.examples || [])[0];
    if (ex && ex.input) return ex.input;
    const props = (d.input && d.input.properties) || {};
    const out = {};
    for (const [k, s] of Object.entries(props)) {
        if (k === 'text') out[k] = typeof rec.examples?.[0] === 'string' ? rec.examples[0] : 'Hello, World!';
        else if (k === 'target') out[k] = typeof rec.examples?.[0] === 'string' ? rec.examples[0] : 'example.com';
        else if (k === 'url') out[k] = 'https://openvibe.network';
        else if (k === 'token') out[k] = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig';
        else if (k === 'command') out[k] = 'curl https://openvibe.network';
        else if (k === 'expression') out[k] = '*/5 * * * *';
        else if (k === 'color') out[k] = '#a78bfa';
        else if (k === 'types') out[k] = ['A'];
        else if (s && s.default !== undefined) out[k] = s.default;
    }
    return out;
}

/** "Use it from code": the real POST /api/v1/tools/<id>/run, its real input fields and the docs. */
function apiFold(rec) {
    const d = descriptorOf(rec.sub);
    const docs = '<a href="https://openvibe.tools/developers">API docs</a>';
    if (!d || !d.api) {
        return kit.fold({ title: 'Use it from code', meta: 'API', body: `<p>${esc(rec.name)} runs in your browser, so there is no server call for it. ${docs} covers the tools you can call from code.</p>` });
    }
    const input = sampleInput(rec, d);
    const fields = Object.keys((d.input && d.input.properties) || {}).join(', ') || 'none';
    const token = !(d.auth && d.auth.anonymous);
    const probe = d.auth && d.auth.capability === 'tools.net.probe';
    const lines = [`curl -X POST ${SITE}${d.run.path}`];
    if (token) lines.push(`-H 'Authorization: Bearer $OPENVIBE_TOKEN'`);
    lines.push(`-H 'Content-Type: application/json'`, `-d ${shq(JSON.stringify({ input }))}`);
    const who = probe ? 'Needs a token with <code>tools.net.probe</code>, granted to partners only; people use the page.'
        : token ? 'Needs a signed-in browser session or a token with <code>tools.tool.run</code>.'
            : 'No account needed within the free limit; a token with <code>tools.tool.run</code> raises it.';
    return kit.fold({
        title: 'Use it from code', meta: 'API',
        body: `<p>Input: <code>${esc(fields)}</code>. ${who}</p>${kit.snippet({ code: lines.join(' \\\n  ') })}<p><a href="${SITE}/api/v1/tools/${esc(rec.sub)}/schema">JSON Schema</a> · <a href="${SITE}/api/v1/openapi.json">OpenAPI</a> · ${docs}</p>`,
    });
}

function familyItems(rec) {
    const items = [];
    for (const [sub, other] of CATALOG) {
        if (other.family !== rec.family || other.hub) continue;
        items.push({ href: `https://${hostOf(sub)}/`, label: other.name, short: SHORT[sub] || other.name, current: sub === rec.sub });
    }
    return items;
}

function relatedRows(rec) {
    return relatedTo(rec.sub, 3).map((r) => kit.row({ href: `https://${hostOf(r.sub)}/`, title: r.name, sub: r.desc }));
}

/**
 * The frame's markup for one catalogue record: kit.tool with its head, box, family, folds and related list.
 * @param {object} rec     a catalogue record (seoFor(sub))
 * @param {object} [opts]  { q } the ?q= already in the address, filled into the box
 * @returns {string} HTML
 */
function frameFor(rec, { q = '' } = {}) {
    const fam = FAMILY[rec.family];
    const count = [...CATALOG.values()].filter((r) => r.family === rec.family && !r.hub).length;
    const items = familyItems(rec);
    const related = relatedRows(rec);
    const tool = kit.tool({
        head: kit.toolHead({
            icon: ICON[rec.sub] || fam.icon, hue: fam.hue, family: rec.family,
            crumb: { href: fam.hub, label: fam.label }, title: rec.name, task: taskOf(rec), facts: factsFor(rec),
        }),
        input: inputFor(rec, q),
        answer: '',
        family: kit.family({ title: fam.more, more: { href: fam.hub, label: `All ${count}` }, items }),
        folds: [aboutFold(rec), questionsFold(rec), apiFold(rec)].filter(Boolean),
        related: related.length ? kit.list(related, { title: 'People also use' }) : '',
    });
    return `<div class="ovk-page ovk-page--wide" data-ov-tool-page="${esc(rec.sub)}">${tool}</div>`;
}

/** The browser files a framed page loads (the kit and its behaviour, from this site's own pin). */
function assets() {
    return {
        css: [serve.url('kit.css'), serve.url('kit-data.css')],
        js: [serve.url('kit.js'), serve.url('kit-web.js'), serve.url('kit-data-web.js')],
    };
}

module.exports = { frameFor, isFramed, assets };
