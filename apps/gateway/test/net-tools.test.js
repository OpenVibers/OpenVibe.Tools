'use strict';
// The net tools that had pages but no implementation (robots, sitemap, smtp, blacklist, uptime, DNS
// propagation), myip behind one trusted proxy hop, and the upstream cache (ip-api / ipinfo, RDAP, DoH).
// Resolver, transports and fetch are mocks: nothing here touches a real network.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const express = require('express');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const { createEgress } = require('../../_shared/egress');
const createNetRoutes = require('../server/net/routes');
const { createCache } = require('../server/net/cache');
const { parseRobots, testRobots, analyseSitemap } = require('../server/net/checks');
const { NET_TOOLS } = require('../server/net/config');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const DNS = { 'public.example': ['93.184.216.34'], 'mx.public.example': ['93.184.216.40'], 'site.example': ['93.184.216.50'], 'down.example': ['93.184.216.60'] };
const lookup = (host, _opts, cb) => {
    const a = DNS[host];
    if (!a) return cb(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }));
    cb(null, a.map(address => ({ address, family: 4 })));
};

// ── HTTP: a few sites ──
const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://site.example/</loc><lastmod>2026-09-01</lastmod></url>
  <url><loc>https://site.example/a?x=1&amp;y=2</loc><lastmod>01/09/2026</lastmod></url>
  <url><loc>https://elsewhere.example/b</loc></url>
</urlset>`;
const INDEX = `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://site.example/sitemap-1.xml.gz</loc></sitemap><sitemap><loc>https://site.example/missing.xml</loc></sitemap></sitemapindex>`;
const PAGES = {
    'site.example/robots.txt': [200, 'text/plain', 'User-agent: *\nDisallow: /private/\nAllow: /private/open$\n\nUser-agent: Googlebot\nUser-agent: Bingbot\nDisallow: /*.pdf$\nCrawl-delay: 5\n\nSitemap: https://site.example/sitemap_index.xml\nNoindex: /x\n'],
    'site.example/sitemap_index.xml': [200, 'application/xml', INDEX],
    'site.example/sitemap-1.xml.gz': [200, 'application/gzip', zlib.gzipSync(SITEMAP)],
    'site.example/missing.xml': [404, 'text/html', 'nope'],
    'site.example/': [200, 'text/html', '<html>home</html>'],
    'public.example/robots.txt': [200, 'text/plain', 'User-agent: *\nDisallow: /\n'],
    'public.example/sitemap.xml': [200, 'text/html', '<!doctype html><html><body>not a sitemap</body></html>'],
    'down.example/': [503, 'text/html', 'maintenance'],
};
function fakeHttp(opts, cb) {
    const req = new EventEmitter();
    req.destroy = (err) => { if (err) req.emit('error', err); };
    req.end = () => {
        const key = `${opts.hostname}${opts.path}`;
        const hit = PAGES[key];
        const [status, type, body] = hit || [404, 'text/plain', 'not found'];
        const res = Readable.from([Buffer.from(body)]);
        Object.assign(res, { statusCode: status, statusMessage: status === 200 ? 'OK' : 'Error', headers: { 'content-type': type, server: 'mock' } });
        const answer = () => cb(res);
        if (opts.lookup) opts.lookup(opts.hostname, {}, (err) => (err ? req.emit('error', err) : answer())); else answer();
    };
    return req;
}

// ── SMTP: a fake mail server on mx.public.example:25 ──
function smtpServer(sock, { starttls = true } = {}) {
    let tlsOn = false;
    const say = (s, text) => setImmediate(() => s.emit('data', Buffer.from(text)));
    const handle = (s, line) => {
        const cmd = line.trim().toUpperCase();
        if (cmd.startsWith('EHLO')) say(s, `250-mx.public.example hello\r\n250-SIZE 35882577\r\n${!tlsOn && starttls ? '250-STARTTLS\r\n' : ''}${tlsOn ? '250-AUTH PLAIN LOGIN\r\n' : ''}250 8BITMIME\r\n`);
        else if (cmd === 'STARTTLS') say(s, '220 2.0.0 Ready to start TLS\r\n');
        else if (cmd === 'QUIT') say(s, '221 2.0.0 Bye\r\n');
        else say(s, '502 5.5.2 Error\r\n');
    };
    sock.write = (d) => { String(d).split('\r\n').filter(Boolean).forEach(l => handle(sock, l)); return true; };
    sock.upgrade = () => {
        tlsOn = true;
        const sec = new EventEmitter();
        sec.write = (d) => { String(d).split('\r\n').filter(Boolean).forEach(l => handle(sec, l)); return true; };
        sec.destroy = () => {};
        sec.getProtocol = () => 'TLSv1.3';
        sec.getCipher = () => ({ name: 'TLS_AES_256_GCM_SHA384' });
        sec.authorized = true;
        sec.getPeerCertificate = () => ({ subject: { CN: 'mx.public.example' }, issuer: { O: 'Test CA' }, valid_to: new Date(Date.now() + 40 * 86400000).toUTCString(), subjectaltname: 'DNS:mx.public.example' });
        setImmediate(() => sec.emit('secureConnect'));
        return sec;
    };
    say(sock, '220 mx.public.example ESMTP ready\r\n');
}
const sockets = [];
function tcpConnect({ host, port }) {
    const s = new EventEmitter();
    s.setTimeout = () => {}; s.destroy = () => {}; s.end = () => {};
    sockets.push({ host, port });
    if (host === '93.184.216.40' && (port === 25 || port === 587)) {
        process.nextTick(() => { s.emit('connect'); smtpServer(s, { starttls: port === 587 || port === 25 }); });
    } else if (host === '93.184.216.34' && port === 25) {
        process.nextTick(() => s.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })));
    } else {
        process.nextTick(() => s.emit('connect'));
    }
    return s;
}
const tlsUpgrade = ({ socket }) => socket.upgrade();

// ── DNS: DNSBLs, MX, and ten "public resolvers" ──
const ANSWERS = {
    '34.216.184.93.zen.spamhaus.org': ['127.0.0.4'],
    '34.216.184.93.psbl.surriel.com': 'ETIMEOUT',
    'public.example.dbl.spamhaus.org': ['127.255.255.254'],
    'public.example.multi.uribl.com': ['127.0.0.2'],
};
const TXT = { '34.216.184.93.zen.spamhaus.org': [['Listed by XBL, see https://check.spamhaus.org/']] };
const fail = (code) => Promise.reject(Object.assign(new Error(code), { code }));
function resolverFor(servers) {
    const server = servers && servers[0];
    return {
        resolve4: (q) => { const a = ANSWERS[q] || (DNS[q] && !servers ? DNS[q] : null); return typeof a === 'string' ? fail(a) : a ? Promise.resolve(a) : fail('ENOTFOUND'); },
        resolveTxt: (q) => (TXT[q] ? Promise.resolve(TXT[q]) : fail('ENODATA')),
        resolveMx: (q) => (q === 'public.example' ? Promise.resolve([{ exchange: 'mx.public.example', priority: 10 }]) : fail('ENODATA')),
        resolve: (name, type) => {
            if (server === '223.5.5.5') return fail('ENOTFOUND');
            if (server === '4.2.2.1') return fail('ETIMEOUT');
            if (type === 'MX') return Promise.resolve([{ exchange: 'mx.site.example', priority: 10 }]);
            return Promise.resolve(server === '9.9.9.9' ? ['93.184.216.99'] : ['93.184.216.50']);
        },
    };
}

// ── fetch: ip-api / ipinfo / RDAP / DoH, counted ──
const fetched = [];
async function fakeFetch(url) {
    fetched.push(url);
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (url.startsWith('http://ip-api.com/json/')) return json({ status: 'success', query: '8.8.8.8', country: 'United States', countryCode: 'US', city: 'Mountain View', isp: 'Google LLC', as: 'AS15169 Google LLC' });
    if (url.startsWith('https://ipinfo.io/')) return json({ ip: '8.8.4.4', city: 'Mountain View', region: 'California', country: 'US', loc: '37.4,-122.1', org: 'AS15169 Google LLC', timezone: 'America/Los_Angeles', hostname: 'dns.google' });
    if (url.startsWith('https://rdap.org/domain/')) return json({ ldhName: 'example.com', status: ['active'], events: [] });
    if (url.startsWith('https://dns.google/resolve')) return json({ Answer: [{ name: 'example.com.', type: 1, TTL: 120, data: '93.184.216.34' }] });
    return json({}, 404);
}

(async () => {
    // ── The cache itself ──
    {
        let t = 0;
        const c = createCache({ max: 2, ttlMs: 1000, now: () => t });
        let calls = 0;
        const slow = () => new Promise(r => setTimeout(() => r(++calls), 10));
        const [a, b] = await Promise.all([c.wrap('k', slow), c.wrap('k', slow)]);
        assert.deepStrictEqual([a, b, calls], [1, 1, 1], 'concurrent asks share one call');
        assert.strictEqual(await c.wrap('k', slow), 1, 'cached');
        t = 1001;
        assert.strictEqual(await c.wrap('k', slow), 2, 'expired');
        await c.wrap('zero', async () => 'x', 0);
        assert.strictEqual(c.get('zero'), undefined, 'ttl 0 is not kept');
        await assert.rejects(c.wrap('boom', async () => { throw new Error('upstream'); }));
        assert.strictEqual(await c.wrap('boom', async () => 'ok'), 'ok', 'a failure is not cached');
        c.set('x', 1); c.set('y', 2); c.set('z', 3);
        assert.strictEqual(c.size(), 2, 'least recently used goes first');
    }

    // ── robots.txt parsing and matching (RFC 9309) ──
    {
        const p = parseRobots('User-agent: *\nDisallow: /private/\nAllow: /private/open$\nDisallow: /*.pdf$\n\nUser-agent: Googlebot\nDisallow: /nogoogle\nDisallow:\n');
        assert.strictEqual(p.groups.length, 2);
        assert.deepStrictEqual(testRobots(p, '/private/x').allowed, false);
        assert.deepStrictEqual(testRobots(p, '/private/open').allowed, true, 'longer Allow wins');
        assert.deepStrictEqual(testRobots(p, '/private/open/more').allowed, false, '$ anchors the end');
        assert.deepStrictEqual(testRobots(p, '/files/report.pdf').allowed, false, '* matches anything');
        assert.deepStrictEqual(testRobots(p, '/private/x', 'Googlebot').allowed, true, 'a specific group replaces *');
        assert.deepStrictEqual(testRobots(p, '/nogoogle/a', 'Googlebot/2.1').allowed, false);
        assert.deepStrictEqual(testRobots(p, '/robots.txt').allowed, true);
        assert.match(parseRobots('User-agent: *\nDisallow: /\n').warnings[0].text, /whole site/);
    }
    // ── sitemap analysis ──
    {
        const a = analyseSitemap(SITEMAP, 'https://site.example/sitemap.xml');
        assert.deepStrictEqual([a.kind, a.count, a.valid], ['urlset', 3, false]);
        assert.deepStrictEqual(a.issues.map(i => i.code).sort(), ['bad-lastmod', 'other-host']);
        assert.strictEqual(a.sample[1].loc, 'https://site.example/a?x=1&y=2', 'entities decoded');
        const amp = analyseSitemap('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://s.example/?a=1&b=2</loc></url></urlset>', 'https://s.example/');
        assert.ok(amp.issues.some(i => i.code === 'unescaped-ampersand'));
        assert.strictEqual(analyseSitemap('<html></html>', 'https://s.example/').issues[0].code, 'not-a-sitemap');
    }

    // ── Through the routes ──
    const egress = createEgress({ lookup, tcpConnect, tlsConnect: () => { throw new Error('unused'); }, httpRequest: fakeHttp, httpsRequest: fakeHttp });
    const app = express();
    app.set('trust proxy', 1);   // what the gateway sets: the host's nginx is the one hop
    app.use('/api/net', createNetRoutes(null, null, { egress, resolverFor, tlsUpgrade, fetch: fakeFetch }));
    const srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${srv.address().port}`;
    const get = async (p, headers) => { const r = await fetch(base + p, { headers }); return { status: r.status, body: await r.json() }; };
    const q = encodeURIComponent;
    try {
        // myip: the address nginx put last; the client's own first entry is ignored.
        let r = await get('/api/net/myip', { 'X-Forwarded-For': '6.6.6.6, 203.0.113.9' });
        assert.strictEqual(r.body.ip, '203.0.113.9', 'a forged first X-Forwarded-For entry is not believed');
        r = await get('/api/net/myip', { 'X-Forwarded-For': '198.51.100.7' });
        assert.strictEqual(r.body.ip, '198.51.100.7');
        r = await get('/api/net/myip');
        assert.strictEqual(r.body.ip, '127.0.0.1');
        const gatewaySrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
        assert.match(gatewaySrc, /app\.set\('trust proxy', 1\)/, 'the gateway trusts exactly one proxy hop');

        // Upstream cache: ip-api once per IP, RDAP and DoH once per question.
        fetched.length = 0;
        r = await get('/api/net/ip?target=8.8.8.8');
        assert.strictEqual(r.body.geo.city, 'Mountain View');
        await get('/api/net/ip?target=8.8.8.8');
        await get('/api/net/ipv4?target=8.8.8.8');
        assert.strictEqual(fetched.filter(u => u.includes('ip-api.com')).length, 1, 'ip-api asked once');
        await get('/api/net/rdap?target=example.com'); await get('/api/net/whois?target=example.com');
        assert.strictEqual(fetched.filter(u => u.includes('rdap.org')).length, 1, 'RDAP asked once');
        await get('/api/net/dns?target=example.com&types=A&doh=1'); await get('/api/net/dns?target=example.com&types=A&doh=1');
        assert.strictEqual(fetched.filter(u => u.includes('dns.google')).length, 1, 'DoH asked once');
        // With an ipinfo token (from the environment: the gateway has no database), HTTPS ipinfo is used.
        process.env.NET_IPINFO_TOKEN = 'tok_test';
        r = await get('/api/net/ip?target=8.8.4.4');
        delete process.env.NET_IPINFO_TOKEN;
        assert.ok(fetched.some(u => u.startsWith('https://ipinfo.io/8.8.4.4/json?token=tok_test')), 'ipinfo over HTTPS with the token');
        assert.deepStrictEqual([r.body.geo.city, r.body.network.isp, r.body.network.as, r.body.reverse], ['Mountain View', 'Google LLC', 'AS15169 Google LLC', 'dns.google']);

        // robots
        r = await get(`/api/net/robots?target=${q('https://site.example/some/page')}&path=${q('/private/x')}`);
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(r.body.found, true);
        assert.strictEqual(r.body.groups.length, 2);
        assert.deepStrictEqual(r.body.groups[1].agents, ['Googlebot', 'Bingbot']);
        assert.strictEqual(r.body.groups[1].crawlDelay, '5');
        assert.deepStrictEqual(r.body.sitemaps, ['https://site.example/sitemap_index.xml']);
        assert.ok(r.body.warnings.some(w => /Noindex/.test(w.text)), 'unknown directives are pointed out');
        assert.deepStrictEqual([r.body.test.allowed, r.body.test.rule.path], [false, '/private/']);
        r = await get(`/api/net/robots?target=site.example&path=${q('/doc.pdf')}&ua=Googlebot`);
        assert.strictEqual(r.body.test.allowed, false);
        r = await get('/api/net/robots?target=public.example');
        assert.match(r.body.warnings[0].text, /whole site/);
        r = await get('/api/net/robots?target=down.example');
        assert.strictEqual(r.body.found, false);
        assert.match(r.body.verdict, /may crawl everything/);

        // sitemap: a bare domain uses robots.txt's Sitemap line; the index is followed to its children.
        r = await get('/api/net/sitemap?target=site.example');
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.deepStrictEqual([r.body.source, r.body.kind, r.body.count, r.body.childrenTotal], ['robots.txt', 'index', 2, 2]);
        assert.deepStrictEqual(r.body.childResults.map(c => [c.count, c.valid]), [[3, false], [0, false]], 'gzip child read; missing child reported');
        r = await get(`/api/net/sitemap?target=${q('https://public.example/sitemap.xml')}`);
        assert.strictEqual(r.body.valid, false);
        assert.strictEqual(r.body.issues[0].code, 'not-a-sitemap');

        // uptime
        r = await get('/api/net/uptime?target=site.example');
        assert.deepStrictEqual([r.body.state, r.body.status], ['up', 200]);
        r = await get('/api/net/uptime?target=down.example');
        assert.deepStrictEqual([r.body.state, r.body.status], ['down', 503]);
        r = await get('/api/net/uptime?target=nowhere.example');
        assert.deepStrictEqual([r.body.state, r.body.error], ['down', 'The name does not resolve (DNS)']);

        // smtp: the domain's MX, greeting, EHLO, STARTTLS with the certificate, AUTH after TLS; never MAIL.
        sockets.length = 0;
        r = await get('/api/net/smtp?target=public.example&port=587');
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.deepStrictEqual([r.body.host, r.body.ip, r.body.port, r.body.connected], ['mx.public.example', '93.184.216.40', 587, true]);
        assert.strictEqual(r.body.banner.code, 220);
        assert.ok(r.body.ehlo.extensions.includes('STARTTLS'));
        assert.strictEqual(r.body.starttls.ok, true);
        assert.strictEqual(r.body.starttls.protocol, 'TLSv1.3');
        assert.deepStrictEqual([r.body.starttls.certificate.subject, r.body.starttls.certificate.hostnameMatch, r.body.starttls.certificate.trusted], ['mx.public.example', true, true]);
        assert.deepStrictEqual(r.body.auth, ['PLAIN', 'LOGIN'], 'AUTH advertised after STARTTLS');
        assert.ok(!r.body.error, r.body.error);
        assert.deepStrictEqual(sockets, [{ host: '93.184.216.40', port: 587 }], 'dialled the checked MX address only');
        r = await get('/api/net/smtp?target=93.184.216.34');
        assert.deepStrictEqual([r.body.connected, r.body.error], [false, 'Connection refused']);
        r = await get('/api/net/smtp?target=public.example&port=2525');
        assert.strictEqual(r.status, 400, 'only 25 and 587');

        // blacklist: an IP on the IP lists; a domain on the domain lists and its address on the IP lists.
        r = await get('/api/net/blacklist?target=93.184.216.34');
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        const zen = r.body.lists.find(l => l.zone === 'zen.spamhaus.org');
        assert.deepStrictEqual([zen.listed, zen.codes, zen.reason], [true, ['127.0.0.4'], 'Listed by XBL, see https://check.spamhaus.org/']);
        assert.strictEqual(r.body.lists.find(l => l.zone === 'psbl.surriel.com').listed, null, 'a timeout is unknown, not clean');
        assert.strictEqual(r.body.lists.find(l => l.zone === 'bl.spamcop.net').listed, false);
        assert.strictEqual(r.body.listedCount, 1);
        r = await get('/api/net/blacklist?target=public.example');
        assert.deepStrictEqual([r.body.kind, r.body.ip], ['domain', '93.184.216.34']);
        const dbl = r.body.lists.find(l => l.zone === 'dbl.spamhaus.org');
        assert.deepStrictEqual([dbl.listed, /refused/.test(dbl.error)], [null, true], 'a refused query is not a listing');
        assert.strictEqual(r.body.lists.find(l => l.zone === 'multi.uribl.com').listed, true);
        assert.strictEqual(r.body.lists.length, 10);
        assert.strictEqual((await get('/api/net/blacklist?target=10.0.0.1')).status, 400, 'private addresses are not looked up');
        assert.strictEqual((await get(`/api/net/blacklist?target=${q('2001:db8::1')}`)).status, 400, 'IPv6 is said to be unsupported');

        // DNS propagation: ten resolvers, the odd one out flagged, failures not voting.
        r = await get('/api/net/dnsprop?target=site.example&type=A');
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        assert.strictEqual(r.body.resolvers.length, 10);
        assert.strictEqual(r.body.agree, false);
        assert.deepStrictEqual(r.body.resolvers.filter(x => x.differs).map(x => x.id).sort(), ['alibaba', 'quad9']);
        assert.strictEqual(r.body.resolvers.find(x => x.id === 'level3').status, 'error');
        assert.deepStrictEqual(r.body.majority, { answer: ['93.184.216.50'], count: 7 });
        r = await get('/api/net/dnsprop?target=site.example&type=MX');
        assert.deepStrictEqual(r.body.resolvers[0].answers, ['10 mx.site.example']);
        assert.strictEqual((await get('/api/net/dnsprop?target=site.example&type=PTR')).status, 400);

        // Every net tool the catalogue lists either has a route here or says it is unavailable.
        r = await get('/api/net/tools');
        for (const t of r.body.tools.filter(x => !x.hub)) {
            if (t.status === 'unavailable') { assert.ok(t.unavailable, `${t.id} says why`); continue; }
            const probe = await fetch(`${base}/api/net${t.endpoint}?target=`);
            assert.notStrictEqual(probe.status, 404, `${t.id} → ${t.endpoint} exists`);
        }
        assert.deepStrictEqual(NET_TOOLS.filter(t => t.status === 'unavailable').map(t => t.id), ['traceroute', 'mtr', 'reputation']);
    } finally {
        srv.closeAllConnections(); srv.close();
    }
    await sleep(0);
    console.log('net tools (robots, sitemap, smtp, blacklist, uptime, propagation, myip, cache): all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
