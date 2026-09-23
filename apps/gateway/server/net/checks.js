'use strict';

// ═══════════════════════════════════════════════════════════════
// Net.OpenVibe — the checks that had catalogue pages but no implementation:
//   robots   fetch + parse robots.txt (RFC 9309), test a path against it
//   sitemap  fetch + check a sitemap or sitemap index (size-capped, gzip aware)
//   smtp     greeting, EHLO, STARTTLS (TLS version + certificate) on port 25 or 587; never sends mail
//   blacklist  DNSBL lookups for an IPv4 address or a domain
//   uptime   is a site up right now, from this server (status, redirects, time)
//   dnsprop  the same record from ten public resolvers, compared
// Everything that connects to a visitor's target (robots, sitemap, smtp, uptime) goes through the SSRF
// guard (_shared/egress): public addresses only, checked after DNS, dialled as checked, redirects
// re-checked. blacklist and dnsprop only ask DNS servers questions; the target is never contacted.
// ═══════════════════════════════════════════════════════════════

const dns = require('dns');
const net = require('net');
const tls = require('tls');
const zlib = require('zlib');
const { TargetRefused } = require('../../../_shared/egress');
const { createCache } = require('./cache');

const UA = 'Mozilla/5.0 (compatible; Net.OpenVibe/1.0; +https://net.openvibe.tools)';
const FROM = 'the OpenVibe server (one location)';
const ROBOTS_MAX_BYTES = 512 * 1024;             // Google reads the first 500 KiB
const SITEMAP_MAX_BYTES = 10 * 1024 * 1024;      // downloaded
const SITEMAP_MAX_XML = 20 * 1024 * 1024;        // after gunzip
const SITEMAP_CHILDREN = 3;                      // index files: the first N children are checked too
const SMTP_PORTS = [25, 587];

const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const upstream = (what, err) => Object.assign(new Error(`${what}: ${(err && (err.code || err.message)) || 'failed'}`), { status: 502 });

/** A domain or URL typed by a person → URL (https unless they said http). */
function toUrl(egress, input) {
    const raw = String(input || '').trim();
    if (!raw) throw bad('Please provide a URL or domain');
    return egress.parseUrl(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
}

function defaultResolver(servers, { timeout = 3000, tries = 2 } = {}) {
    const r = new dns.promises.Resolver({ timeout, tries });
    if (servers) r.setServers(servers);
    return r;
}

// ── robots.txt (RFC 9309) ────────────────────────────────────

function parseRobots(text) {
    const groups = [], sitemaps = [], warnings = [];
    let current = null, lastWasAgent = false;
    text.split(/\r\n|\r|\n/).forEach((raw, i) => {
        const line = raw.replace(/#.*$/, '').trim();
        if (!line) return;
        const m = /^([A-Za-z][A-Za-z-]*)\s*:\s*(.*)$/.exec(line);
        if (!m) { warnings.push({ line: i + 1, text: `Not a rule: ${raw.trim().slice(0, 80)}` }); return; }
        const key = m[1].toLowerCase(), value = m[2].trim();
        if (key === 'user-agent') {
            if (!current || !lastWasAgent) { current = { agents: [], rules: [], crawlDelay: null, line: i + 1 }; groups.push(current); }
            current.agents.push(value);
            lastWasAgent = true;
            return;
        }
        lastWasAgent = false;
        if (key === 'sitemap') { sitemaps.push(value); return; }
        if (key === 'allow' || key === 'disallow') {
            if (!current) { warnings.push({ line: i + 1, text: `${m[1]} before any User-agent line is ignored by crawlers` }); return; }
            current.rules.push({ type: key, path: value, line: i + 1 });
            return;
        }
        if (key === 'crawl-delay') { if (current) current.crawlDelay = value; return; }
        warnings.push({ line: i + 1, text: `"${m[1]}" is not a robots.txt rule most crawlers read` });
    });
    for (const g of groups) {
        if (g.agents.includes('*') && g.rules.some(r => r.type === 'disallow' && r.path === '/') && !g.rules.some(r => r.type === 'allow' && r.path && r.path !== '/')) {
            warnings.unshift({ line: g.line, text: 'Every crawler is blocked from the whole site (User-agent: * with Disallow: /)' });
        }
    }
    return { groups, sitemaps, warnings };
}

function ruleRegex(pattern) {
    const anchored = pattern.endsWith('$');
    const body = (anchored ? pattern.slice(0, -1) : pattern).split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

/** Would `ua` be allowed to fetch `path`? The most specific group, the longest matching rule; Allow wins ties. */
function testRobots(parsed, path, ua = '*') {
    if (path === '/robots.txt') return { allowed: true, rule: null, agents: [] };
    const token = String(ua || '*').toLowerCase().split('/')[0].trim();
    let matched = parsed.groups.filter(g => g.agents.some(a => a.toLowerCase() === token && token !== '*'));
    if (!matched.length) matched = parsed.groups.filter(g => g.agents.includes('*'));
    let best = null;
    for (const g of matched) for (const r of g.rules) {
        if (!r.path) continue;   // an empty Disallow allows everything
        if (!ruleRegex(r.path).test(path)) continue;
        if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.type === 'allow')) best = r;
    }
    return { allowed: !best || best.type === 'allow', rule: best, agents: [...new Set(matched.flatMap(g => g.agents))] };
}

// ── sitemap ──────────────────────────────────────────────────

const W3C_DATE = /^\d{4}(-\d{2}(-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?)?)?$/;
const FREQS = new Set(['always', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'never']);
const decodeXml = (s) => s.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function analyseSitemap(xml, baseUrl) {
    const issues = new Map();
    const issue = (level, code, message, example) => {
        let e = issues.get(code);
        if (!e) issues.set(code, e = { level, code, message, count: 0, examples: [] });
        e.count++;
        if (example != null && e.examples.length < 5) e.examples.push(String(example).slice(0, 200));
    };
    const kind = /<urlset[\s>]/.test(xml) ? 'urlset' : /<sitemapindex[\s>]/.test(xml) ? 'index' : null;
    if (!kind) {
        issue('error', 'not-a-sitemap', /<html[\s>]/i.test(xml) ? 'This is an HTML page, not a sitemap' : 'No <urlset> or <sitemapindex> root element');
        return { kind: null, count: 0, sample: [], children: [], issues: [...issues.values()], valid: false };
    }
    if (!/xmlns\s*=\s*["']https?:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9["']/.test(xml)) issue('warning', 'namespace', 'The sitemaps.org namespace (xmlns="http://www.sitemaps.org/schemas/sitemap/0.9") is missing');
    const host = new URL(baseUrl).hostname;
    const re = kind === 'urlset' ? /<url(?:\s[^>]*)?>([\s\S]*?)<\/url>/g : /<sitemap(?:\s[^>]*)?>([\s\S]*?)<\/sitemap>/g;
    const sample = [], children = [];
    let count = 0, m;
    while ((m = re.exec(xml))) {
        count++;
        const body = m[1];
        const locRaw = (/<loc>\s*([\s\S]*?)\s*<\/loc>/i.exec(body) || [])[1];
        if (locRaw == null) { issue('error', 'missing-loc', 'An entry has no <loc>'); continue; }
        if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(locRaw) && !/^<!\[CDATA\[/.test(locRaw)) issue('error', 'unescaped-ampersand', 'A <loc> has an unescaped & (must be &amp;): the file is not valid XML', locRaw);
        const loc = decodeXml(locRaw);
        let u = null;
        try { u = new URL(loc); } catch { /* below */ }
        if (!u || !/^https?:$/.test(u.protocol)) issue('error', 'bad-loc', '<loc> must be an absolute http(s) URL', loc);
        else if (u.hostname !== host) issue('warning', 'other-host', `<loc> on another host than the sitemap (${host}): search engines ignore those unless the other site is verified`, loc);
        if (loc.length > 2048) issue('error', 'long-loc', '<loc> is longer than 2,048 characters', loc.slice(0, 80) + '…');
        const lastmod = (/<lastmod>\s*([^<]*?)\s*<\/lastmod>/i.exec(body) || [])[1];
        if (lastmod != null && !W3C_DATE.test(lastmod)) issue('error', 'bad-lastmod', '<lastmod> is not a W3C date (e.g. 2026-09-23 or 2026-09-23T10:00:00+00:00)', lastmod);
        const freq = (/<changefreq>\s*([^<]*?)\s*<\/changefreq>/i.exec(body) || [])[1];
        if (freq != null && !FREQS.has(freq.toLowerCase())) issue('warning', 'bad-changefreq', '<changefreq> is not one of always, hourly, daily, weekly, monthly, yearly, never', freq);
        const pri = (/<priority>\s*([^<]*?)\s*<\/priority>/i.exec(body) || [])[1];
        if (pri != null && !(/^(0(\.\d+)?|1(\.0+)?)$/.test(pri))) issue('warning', 'bad-priority', '<priority> must be between 0.0 and 1.0', pri);
        if (sample.length < 10) sample.push({ loc, ...(lastmod != null && { lastmod }) });
        if (kind === 'index' && u) children.push(loc);
    }
    if (!count) issue('warning', 'empty', kind === 'index' ? 'The sitemap index lists no sitemaps' : 'The sitemap lists no URLs');
    if (count > 50000) issue('error', 'too-many', `${count.toLocaleString('en-US')} entries: one sitemap may hold at most 50,000`);
    const list = [...issues.values()];
    return { kind, count, sample, children, issues: list, valid: !list.some(i => i.level === 'error') };
}

// ── SMTP ─────────────────────────────────────────────────────

/** Reads SMTP replies (multi-line: "250-…" continues, "250 …" ends) from a socket. */
function smtpReader(sock) {
    let buf = '', ended = null;
    const waiters = [];
    const take = () => {
        const lines = [];
        let at = 0;
        for (;;) {
            const nl = buf.indexOf('\n', at);
            if (nl < 0) return null;
            const line = buf.slice(at, nl).replace(/\r$/, '');
            at = nl + 1;
            lines.push(line);
            if (!/^\d{3}-/.test(line)) {
                buf = buf.slice(at);
                return { code: parseInt(line.slice(0, 3), 10) || 0, lines: lines.map(l => l.slice(4)) };
            }
        }
    };
    const pump = () => { while (waiters.length) { const r = take(); if (!r) return; waiters.shift().ok(r); } };
    const fail = (e) => { if (!ended) ended = e; while (waiters.length) waiters.shift().no(ended); };
    const onData = (d) => { buf += d.toString('latin1'); if (buf.length > 64 * 1024) fail(new Error('The server sent too much')); else pump(); };
    const onError = (e) => fail(e);
    const onClose = () => fail(new Error('The server closed the connection'));
    sock.on('data', onData); sock.on('error', onError); sock.on('close', onClose);
    return {
        read(timeoutMs = 10_000) {
            const r = take();
            if (r) return Promise.resolve(r);
            if (ended) return Promise.reject(ended);
            return new Promise((ok, no) => {
                const w = { ok: (v) => { clearTimeout(t); ok(v); }, no: (e) => { clearTimeout(t); no(e); } };
                const t = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); no(Object.assign(new Error('The server did not answer in time'), { code: 'ETIMEDOUT' })); }, timeoutMs);
                waiters.push(w);
            });
        },
        send(line) { sock.write(`${line}\r\n`); },
        detach() { sock.removeListener('data', onData); sock.removeListener('error', onError); sock.removeListener('close', onClose); },
    };
}

function certSummary(cert, host, authorized, authorizationError) {
    if (!cert || !cert.subject) return null;
    const validTo = cert.valid_to ? new Date(cert.valid_to) : null;
    let hostnameMatch = null;
    if (host && !net.isIP(host)) { try { hostnameMatch = !tls.checkServerIdentity(host, cert); } catch { hostnameMatch = false; } }
    return {
        subject: cert.subject.CN || null,
        issuer: (cert.issuer && (cert.issuer.O || cert.issuer.CN)) || null,
        validTo: cert.valid_to || null,
        daysLeft: validTo ? Math.ceil((validTo - Date.now()) / 86400000) : null,
        sans: cert.subjectaltname ? cert.subjectaltname.split(', ').map(s => s.replace(/^DNS:/, '')).slice(0, 20) : [],
        trusted: !!authorized,
        hostnameMatch,
        ...(authorizationError && { error: String(authorizationError) }),
    };
}

// ── DNSBL ────────────────────────────────────────────────────

const IP_LISTS = [
    { zone: 'zen.spamhaus.org', name: 'Spamhaus ZEN', delist: 'https://check.spamhaus.org/', refused: ['127.255.255.252', '127.255.255.254', '127.255.255.255'] },
    { zone: 'bl.spamcop.net', name: 'SpamCop', delist: 'https://www.spamcop.net/bl.shtml' },
    { zone: 'psbl.surriel.com', name: 'PSBL', delist: 'https://psbl.org/' },
    { zone: 'bl.mailspike.net', name: 'Mailspike', delist: 'https://mailspike.org/iplookup.html' },
    { zone: 'dnsbl.dronebl.org', name: 'DroneBL', delist: 'https://dronebl.org/lookup' },
    { zone: 'all.s5h.net', name: 's5h.net', delist: 'https://www.usenix.org.uk/content/rbl.html' },
    { zone: 'dnsbl-1.uceprotect.net', name: 'UCEPROTECT Level 1', delist: 'https://www.uceprotect.net/en/rblcheck.php' },
];
const DOMAIN_LISTS = [
    { zone: 'dbl.spamhaus.org', name: 'Spamhaus DBL', delist: 'https://check.spamhaus.org/', refused: ['127.255.255.252', '127.255.255.254', '127.255.255.255'] },
    { zone: 'multi.surbl.org', name: 'SURBL', delist: 'https://surbl.org/surbl-analysis', refused: ['127.0.0.1'] },
    { zone: 'multi.uribl.com', name: 'URIBL', delist: 'https://admin.uribl.com/', refused: ['127.0.0.1'] },
];

// ── DNS propagation ──────────────────────────────────────────

const RESOLVERS = [
    { id: 'google', name: 'Google', ip: '8.8.8.8' },
    { id: 'cloudflare', name: 'Cloudflare', ip: '1.1.1.1' },
    { id: 'quad9', name: 'Quad9', ip: '9.9.9.9' },
    { id: 'opendns', name: 'OpenDNS (Cisco)', ip: '208.67.222.222' },
    { id: 'adguard', name: 'AdGuard (unfiltered)', ip: '94.140.14.140' },
    { id: 'controld', name: 'Control D (unfiltered)', ip: '76.76.2.0' },
    { id: 'dnssb', name: 'DNS.SB', ip: '185.222.222.222' },
    { id: 'he', name: 'Hurricane Electric', ip: '74.82.42.42' },
    { id: 'level3', name: 'Lumen (Level 3)', ip: '4.2.2.1' },
    { id: 'alibaba', name: 'Alibaba (China)', ip: '223.5.5.5' },
];
const PROP_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT'];

function normalizeAnswers(type, answers) {
    const list = (answers || []).map((a) => {
        if (type === 'MX') return `${a.priority} ${a.exchange}`;
        if (type === 'TXT') return Array.isArray(a) ? a.join('') : String(a);
        return String(a);
    });
    return list.sort();
}

// ─────────────────────────────────────────────────────────────

/**
 * @param {object} o
 * @param {object} o.egress       the SSRF guard (createEgress())
 * @param {(servers?: string[], opts?) => dns.promises.Resolver} [o.resolverFor]  DNS resolvers (tests pass mocks)
 * @param {Function} [o.tlsUpgrade] tls.connect (tests pass a mock)
 */
function createChecks({ egress, resolverFor = defaultResolver, tlsUpgrade = tls.connect, cache = createCache({ max: 2000 }) }) {
    const system = () => resolverFor(null, { timeout: 3000, tries: 2 });

    // ── robots ──
    async function robots(target, { path: testPath, ua } = {}) {
        const base = toUrl(egress, target);
        const url = `${base.origin}/robots.txt`;
        let r;
        try {
            r = await egress.follow(url, { method: 'GET', headers: { 'User-Agent': UA }, timeoutMs: 10_000, maxBytes: ROBOTS_MAX_BYTES, maxRedirects: 5 });
        } catch (err) {
            if (err instanceof TargetRefused || (err.status >= 400 && err.status < 500)) throw err;
            throw upstream('Could not fetch robots.txt', err);
        }
        const out = { url, finalUrl: r.url, status: r.status, found: r.status >= 200 && r.status < 300, size: r.body.length, truncated: r.truncated, checkedFrom: FROM };
        if (!out.found) {
            out.verdict = r.status >= 500
                ? `robots.txt answered HTTP ${r.status}: Google treats the whole site as disallowed until it answers again.`
                : `No robots.txt (HTTP ${r.status}): crawlers may crawl everything.`;
            out.groups = []; out.sitemaps = []; out.warnings = [];
        } else {
            const ct = String(r.headers['content-type'] || '');
            const parsed = parseRobots(r.body.toString('utf8'));
            Object.assign(out, parsed);
            if (/text\/html/i.test(ct)) out.warnings.unshift({ line: null, text: 'robots.txt is served as text/html: this looks like a web page, not a robots file' });
            if (r.truncated) out.warnings.unshift({ line: null, text: 'robots.txt is larger than 500 KiB: crawlers ignore everything after that' });
            out.verdict = parsed.groups.length ? `${parsed.groups.length} group${parsed.groups.length === 1 ? '' : 's'} of rules` : 'No rules: crawlers may crawl everything.';
        }
        if (testPath) {
            let p = String(testPath).trim();
            if (/^https?:\/\//i.test(p)) { try { const u = new URL(p); p = u.pathname + u.search; } catch { throw bad('The path to test is not a valid URL'); } }
            if (!p.startsWith('/')) p = `/${p}`;
            const agent = String(ua || '*').slice(0, 100);
            const verdict = out.found ? testRobots(out, p, agent) : { allowed: r.status < 500, rule: null, agents: [] };
            out.test = { path: p, ua: agent, allowed: verdict.allowed, rule: verdict.rule, matchedAgents: verdict.agents };
        }
        return out;
    }

    // ── sitemap ──
    async function fetchSitemap(href) {
        let r;
        try {
            r = await egress.follow(href, { method: 'GET', headers: { 'User-Agent': UA, Accept: 'application/xml,text/xml,*/*' }, timeoutMs: 15_000, maxBytes: SITEMAP_MAX_BYTES, maxRedirects: 5 });
        } catch (err) {
            if (err instanceof TargetRefused || (err.status >= 400 && err.status < 500)) throw err;
            throw upstream('Could not fetch the sitemap', err);
        }
        const out = { url: href, finalUrl: r.url, status: r.status, bytes: r.body.length, truncated: r.truncated };
        if (r.status < 200 || r.status >= 300) return { ...out, kind: null, count: 0, issues: [{ level: 'error', code: 'http', message: `The sitemap answered HTTP ${r.status}`, count: 1, examples: [] }], valid: false };
        let body = r.body;
        if (body[0] === 0x1f && body[1] === 0x8b) {
            try { body = zlib.gunzipSync(body, { maxOutputLength: SITEMAP_MAX_XML }); out.gzip = true; } catch (err) {
                const big = err instanceof RangeError || err.code === 'ERR_BUFFER_TOO_LARGE';
                return { ...out, kind: null, count: 0, issues: [{ level: 'error', code: big ? 'too-large' : 'gzip', message: big ? `Larger than ${SITEMAP_MAX_XML / 1024 / 1024} MB uncompressed: only smaller sitemaps are checked here` : 'The gzip data is damaged', count: 1, examples: [] }], valid: false };
            }
        }
        const a = analyseSitemap(body.toString('utf8').replace(/^﻿/, ''), r.url);
        if (r.truncated) a.issues.unshift({ level: 'warning', code: 'truncated', message: `Larger than ${SITEMAP_MAX_BYTES / 1024 / 1024} MB: only the first ${SITEMAP_MAX_BYTES / 1024 / 1024} MB were checked`, count: 1, examples: [] });
        return { ...out, ...a };
    }

    async function sitemap(target) {
        let url = toUrl(egress, target);
        let source = 'given';
        if (url.pathname === '/' && !url.search) {
            // A bare site: the Sitemap line of its robots.txt, else /sitemap.xml.
            try {
                const rb = await egress.follow(`${url.origin}/robots.txt`, { method: 'GET', headers: { 'User-Agent': UA }, timeoutMs: 8000, maxBytes: ROBOTS_MAX_BYTES, maxRedirects: 3 });
                const first = rb.status >= 200 && rb.status < 300 ? parseRobots(rb.body.toString('utf8')).sitemaps[0] : null;
                if (first) { url = egress.parseUrl(new URL(first, url.origin).href); source = 'robots.txt'; }
            } catch (err) { if (err instanceof TargetRefused) throw err; }
            if (source === 'given') { url = new URL('/sitemap.xml', url.origin); source = 'default'; }
        }
        const main = await fetchSitemap(url.href);
        const result = { ...main, source, checkedFrom: FROM };
        if (main.kind === 'index') {
            result.childResults = [];
            for (const child of (main.children || []).slice(0, SITEMAP_CHILDREN)) {
                try {
                    const c = await fetchSitemap(child);
                    result.childResults.push({ url: child, status: c.status, kind: c.kind, count: c.count, valid: c.valid, issues: c.issues });
                } catch (err) {
                    result.childResults.push({ url: child, error: err instanceof TargetRefused ? err.message : (err.message || 'failed') });
                }
            }
            result.childrenTotal = (main.children || []).length;
        }
        delete result.children;
        return result;
    }

    // ── smtp ──
    async function smtp(target, { port } = {}) {
        const p = parseInt(port, 10) || 25;
        if (!SMTP_PORTS.includes(p)) throw bad('The SMTP test uses port 25 or 587');
        let host = target, mx = null;
        if (!net.isIP(target)) {
            try {
                const records = await system().resolveMx(target);
                if (records && records.length) {
                    mx = records.sort((a, b) => a.priority - b.priority).map(r => ({ exchange: r.exchange, priority: r.priority })).slice(0, 10);
                    if (mx[0].exchange) host = mx[0].exchange;
                }
            } catch { /* no MX: the name itself is the mail server */ }
        }
        const dest = await egress.resolve(host, { prefer: 4 });
        const out = { target, host, ...(mx && { mx }), ip: dest.address, port: p, checkedFrom: FROM };
        const t0 = Date.now();
        let sock;
        try {
            sock = await egress.connect(dest.address, p, { timeoutMs: 10_000 });
        } catch (err) {
            return { ...out, connected: false, error: err.code === 'ECONNREFUSED' ? 'Connection refused' : err.code === 'ETIMEDOUT' ? 'No answer (timed out): the port is filtered, or outbound mail ports are blocked on the way' : (err.code || err.message) };
        }
        out.connected = true;
        out.connectMs = Date.now() - t0;
        let secure = null;
        try {
            let rd = smtpReader(sock);
            const greet = await rd.read();
            out.banner = { code: greet.code, text: greet.lines.join('\n').slice(0, 500) };
            if (greet.code !== 220) { out.error = `The server greeted with ${greet.code} instead of 220`; return out; }
            rd.send('EHLO net.openvibe.tools');
            const ehlo = await rd.read();
            const ext = ehlo.code === 250 ? ehlo.lines.slice(1).map(l => l.trim()).filter(Boolean).slice(0, 40) : [];
            out.ehlo = { code: ehlo.code, greeting: (ehlo.lines[0] || '').slice(0, 200), extensions: ext };
            const has = (name) => ext.some(e => e.toUpperCase().split(/[\s=]/)[0] === name);
            const authOf = (list) => { const a = list.find(e => /^AUTH[\s=]/i.test(e)); return a ? a.slice(5).trim().split(/\s+/) : []; };
            out.auth = authOf(ext);
            out.starttls = { offered: has('STARTTLS') };
            if (out.starttls.offered) {
                rd.send('STARTTLS');
                const go = await rd.read();
                if (go.code !== 220) { out.starttls.error = `STARTTLS answered ${go.code}`; } else {
                    rd.detach();
                    secure = await new Promise((ok, no) => {
                        const s = tlsUpgrade({ socket: sock, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false });
                        const timer = setTimeout(() => { s.destroy(); no(Object.assign(new Error('TLS handshake timed out'), { code: 'ETIMEDOUT' })); }, 10_000);
                        s.once('secureConnect', () => { clearTimeout(timer); ok(s); });
                        s.once('error', (e) => { clearTimeout(timer); no(e); });
                    });
                    const cipher = secure.getCipher && secure.getCipher();
                    Object.assign(out.starttls, {
                        ok: true,
                        protocol: secure.getProtocol ? secure.getProtocol() : null,
                        cipher: cipher ? cipher.name : null,
                        certificate: certSummary(secure.getPeerCertificate && secure.getPeerCertificate(), host, secure.authorized, secure.authorizationError),
                    });
                    rd = smtpReader(secure);
                    rd.send('EHLO net.openvibe.tools');
                    const again = await rd.read();
                    if (again.code === 250) {
                        const ext2 = again.lines.slice(1).map(l => l.trim()).filter(Boolean).slice(0, 40);
                        out.starttls.extensions = ext2;
                        out.auth = authOf(ext2);
                    }
                }
            }
            rd.send('QUIT');
            await rd.read(3000).catch(() => {});
        } catch (err) {
            out.error = err.code === 'ETIMEDOUT' ? err.message : `The conversation stopped: ${(err.message || err.code || 'error').slice(0, 160)}`;
            if (out.starttls && out.starttls.offered && out.starttls.ok === undefined && /TLS|SSL|handshake/i.test(String(err.message))) out.starttls.error = String(err.message).slice(0, 160);
        } finally {
            out.ms = Date.now() - t0;
            try { (secure || sock).destroy(); } catch { /* gone */ }
            try { sock.destroy(); } catch { /* gone */ }
        }
        return out;
    }

    // ── blacklist ──
    async function queryList(list, name) {
        const q = `${name}.${list.zone}`;
        const r = system();
        return cache.wrap(`dnsbl:${q}`, async () => {
            let codes;
            try { codes = await r.resolve4(q); } catch (err) {
                if (err.code === 'ENOTFOUND' || err.code === 'ENODATA') return { listed: false, codes: [] };
                return { listed: null, codes: [], error: err.code || err.message };
            }
            const refused = codes.filter(c => (list.refused || []).includes(c));
            if (refused.length === codes.length) return { listed: null, codes, error: 'This list refused the query (it does not answer through our resolver); check it on its own site' };
            const hits = codes.filter(c => c.startsWith('127.') && !(list.refused || []).includes(c));
            if (!hits.length) return { listed: false, codes };
            let reason = null;
            try { reason = (await r.resolveTxt(q)).map(t => t.join('')).join(' ').slice(0, 300) || null; } catch { /* no reason published */ }
            return { listed: true, codes: hits, reason };
        }, (v) => (v.error && v.listed === null && !/refused/.test(v.error) ? 0 : 10 * 60_000));
    }

    async function blacklist(target) {
        let ip = null, domain = null;
        if (net.isIP(target)) {
            if (net.isIPv6(target)) throw bad('Most blacklists list IPv4 addresses only: enter an IPv4 address or a domain');
            if (!egress.isAllowed(target)) throw bad(`${target} is a private or reserved address; those are never on public blacklists`);
            ip = target;
        } else {
            domain = target.replace(/^www\./, '');
            try { ip = (await system().resolve4(target))[0] || null; } catch { ip = null; }
            if (ip && !egress.isAllowed(ip)) ip = null;
        }
        const checks = [];
        if (ip) {
            const rev = ip.split('.').reverse().join('.');
            for (const l of IP_LISTS) checks.push(queryList(l, rev).then(v => ({ zone: l.zone, name: l.name, type: 'ip', query: ip, delist: l.delist, ...v })));
        }
        if (domain) for (const l of DOMAIN_LISTS) checks.push(queryList(l, domain).then(v => ({ zone: l.zone, name: l.name, type: 'domain', query: domain, delist: l.delist, ...v })));
        const lists = await Promise.all(checks);
        return {
            target, kind: domain ? 'domain' : 'ip', ip, ...(domain && { domain }),
            listedCount: lists.filter(l => l.listed === true).length,
            cleanCount: lists.filter(l => l.listed === false).length,
            unknownCount: lists.filter(l => l.listed === null).length,
            lists, checkedFrom: FROM,
        };
    }

    // ── uptime ──
    async function uptime(target) {
        const url = toUrl(egress, target);
        const t0 = Date.now();
        try {
            const r = await egress.follow(url.href, { method: 'GET', headers: { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.8' }, timeoutMs: 15_000, maxRedirects: 5 });
            return {
                url: url.href, state: r.status < 500 ? 'up' : 'down', status: r.status, statusText: r.statusText,
                finalUrl: r.url, redirects: Math.max(0, r.chain.length - 1), chain: r.chain,
                ms: Date.now() - t0, server: r.headers.server || null, checkedFrom: FROM, checkedAt: new Date().toISOString(),
            };
        } catch (err) {
            if (err instanceof TargetRefused) throw err;
            if (err.status === 400 && !err.cause) throw err;   // not a valid URL
            const why = err.cause ? 'The name does not resolve (DNS)'
                : err.name === 'TimeoutError' || /timeout/i.test(err.message) ? 'No answer within 15 seconds'
                    : err.code === 'ECONNREFUSED' ? 'Connection refused'
                        : /certificate|SSL|TLS/i.test(String(err.code) + err.message) ? `TLS problem: ${err.code || err.message}`
                            : (err.code || err.message || 'Could not connect');
            return { url: url.href, state: 'down', status: null, error: why, ms: Date.now() - t0, checkedFrom: FROM, checkedAt: new Date().toISOString() };
        }
    }

    // ── dnsprop ──
    async function dnsprop(target, { type } = {}) {
        if (net.isIP(target)) throw bad('Enter a domain name: propagation is about the records of a name');
        const t = String(type || 'A').toUpperCase();
        if (!PROP_TYPES.includes(t)) throw bad(`Record type must be one of ${PROP_TYPES.join(', ')}`);
        return cache.wrap(`prop:${t}:${target}`, async () => {
            const resolvers = await Promise.all(RESOLVERS.map(async (res) => {
                const t0 = Date.now();
                try {
                    const answers = normalizeAnswers(t, await resolverFor([res.ip], { timeout: 4000, tries: 1 }).resolve(target, t));
                    return { ...res, status: 'ok', answers, ms: Date.now() - t0 };
                } catch (err) {
                    const status = err.code === 'ENOTFOUND' ? 'nxdomain' : err.code === 'ENODATA' ? 'nodata' : 'error';
                    return { ...res, status, answers: [], ms: Date.now() - t0, ...(status === 'error' && { error: err.code || err.message }) };
                }
            }));
            // The majority answer (errors do not vote); everyone else "differs".
            const key = (r) => (r.status === 'ok' ? JSON.stringify(r.answers) : r.status);
            const votes = new Map();
            for (const r of resolvers) if (r.status !== 'error') votes.set(key(r), (votes.get(key(r)) || 0) + 1);
            const majority = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
            for (const r of resolvers) r.differs = r.status !== 'error' && !!majority && key(r) !== majority[0];
            return {
                target, type: t, resolvers,
                agree: votes.size <= 1,
                answered: resolvers.filter(r => r.status !== 'error').length,
                majority: majority ? { answer: majority[0].startsWith('[') ? JSON.parse(majority[0]) : majority[0], count: majority[1] } : null,
                checkedFrom: FROM,
            };
        }, 20_000);
    }

    return { robots, sitemap, smtp, blacklist, uptime, dnsprop };
}

module.exports = { createChecks, parseRobots, testRobots, analyseSitemap, smtpReader, IP_LISTS, DOMAIN_LISTS, RESOLVERS, PROP_TYPES, SMTP_PORTS };
