'use strict';

// ═══════════════════════════════════════════════════════════════
// Net.OpenVibe — Network Tools API Routes
// Mounted at /api/net/*
// All tools: DNS, GeoIP, Whois/RDAP, Ping, Traceroute, SSL,
// Headers, Redirects, Port checks, and the Supertool Lookup.
// Uses free/keyless APIs by default; optional keys boost limits.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const dns = require('dns').promises;
const { URL } = require('url');
const net = require('net');
const { getNetConfig, NET_TOOLS } = require('./config');
const { createEgress, TargetRefused } = require('../../../_shared/egress');
const { createCache } = require('./cache');
const { createChecks } = require('./checks');

const HOUR = 60 * 60_000;
const IPAPI_FIELDS = 'status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,asname,reverse,query';

/**
 * Every tool here that connects to the target (ssl, headers, redirects, port, ping, lookup, and a
 * custom DNS server) goes through the shared SSRF guard: only public addresses, checked after DNS
 * and dialled as checked. `opts.egress` is for tests (a guard with a mock resolver and transports).
 */
module.exports = function createNetRoutes(db, requireAuth, opts = {}) {
    const router = express.Router();
    const egress = opts.egress || createEgress();
    // Upstream answers are cached: ip-api's free tier is rate limited (and plain HTTP), RDAP and DoH
    // answers change slowly. Tests pass their own fetch.
    const fetchImpl = opts.fetch || fetch;
    const cache = opts.cache || createCache({ max: 5000, ttlMs: HOUR });
    const checks = createChecks({ egress, cache, ...(opts.resolverFor && { resolverFor: opts.resolverFor }), ...(opts.tlsUpgrade && { tlsUpgrade: opts.tlsUpgrade }) });

    // ── Helpers ──────────────────────────────────────────────

    /** Safely extract hostname from user input (domain, IP, or URL) */
    function parseTarget(input) {
        if (!input || typeof input !== 'string') return null;
        let t = input.trim();
        // Strip protocol if URL
        try {
            if (/^https?:\/\//i.test(t)) { t = new URL(t).hostname; }
        } catch {}
        // [IPv6] with or without a port
        const bracketed = /^\[([0-9a-f:.]+)\](?::\d+)?(?:\/.*)?$/i.exec(t);
        if (bracketed) t = bracketed[1];
        // Strip trailing dots, slashes
        t = t.replace(/\/.*$/, '').replace(/\.+$/, '').toLowerCase();
        // Strip port only if it looks like IPv4:port (not IPv6 which has multiple colons)
        if (!t.includes('::') && !t.includes(':')) {
            // IPv4 or domain without port
            t = t.replace(/:\d+$/, '');
        } else if (t.includes(':') && !/:.*:/.test(t)) {
            // Single colon: might be IPv4:port, strip digits after colon
            t = t.replace(/:\d+$/, '');
        }
        // Validate: must be an IP or a domain-like string
        if (/^[a-z0-9._:-]+$/.test(t) && t.length <= 253) return t;
        return null;
    }

    function isIP(str) { return net.isIP(str) !== 0; }

    /** Timed fetch wrapper */
    async function timedFetch(url, opts = {}, timeoutMs = 12000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetchImpl(url, { ...opts, signal: controller.signal });
            return res;
        } finally { clearTimeout(timer); }
    }

    /**
     * Geolocation + network owner of an IP, in ip-api's shape. With NET_IPINFO_TOKEN it comes from
     * ipinfo.io over HTTPS; without, from ip-api.com's free tier (HTTP only). Cached an hour per IP.
     */
    function geoLookup(ip) {
        return cache.wrap(`geo:${ip}`, async () => {
            const c = cfg();
            if (c.ipinfo.token) {
                const r = await timedFetch(`${c.ipinfo.baseUrl}/${encodeURIComponent(ip)}/json?token=${encodeURIComponent(c.ipinfo.token)}`, { headers: { Accept: 'application/json' } });
                const d = await r.json();
                if (!r.ok || d.error) return { status: 'fail', message: (d.error && (d.error.message || d.error.title)) || `ipinfo HTTP ${r.status}` };
                if (d.bogon) return { status: 'fail', message: 'reserved range', query: ip };
                const [lat, lon] = String(d.loc || '').split(',').map(Number);
                const org = d.org || '';
                const asMatch = /^(AS\d+)\s+(.*)$/.exec(org);
                return {
                    status: 'success', query: d.ip || ip, country: d.country, countryCode: d.country, region: d.region, regionName: d.region,
                    city: d.city, zip: d.postal, lat: Number.isFinite(lat) ? lat : undefined, lon: Number.isFinite(lon) ? lon : undefined,
                    timezone: d.timezone, isp: asMatch ? asMatch[2] : org, org: asMatch ? asMatch[2] : org, as: org, asname: asMatch ? asMatch[2] : '', reverse: d.hostname || '',
                };
            }
            const r = await timedFetch(`${c.ipapi.baseUrl}/json/${encodeURIComponent(ip)}?fields=${IPAPI_FIELDS}`);
            return r.json();
        }, (d) => (d && d.status === 'success' ? HOUR : 0));
    }

    /** RDAP for a domain or an IP. → { ok, status, data }. 200s are kept an hour, 404s ten minutes. */
    function rdapLookup(type, target) {
        return cache.wrap(`rdap:${type}:${target}`, async () => {
            const r = await timedFetch(`${cfg().rdap.baseUrl}/${type}/${encodeURIComponent(target)}`, { headers: { Accept: 'application/rdap+json, application/json' } });
            return { ok: r.ok, status: r.status, data: r.ok ? await r.json() : null };
        }, (v) => (v.ok ? HOUR : v.status === 404 ? 10 * 60_000 : 0));
    }

    /** DNS-over-HTTPS (Google JSON API) for one name and type. Kept for the answers' TTL (30 s – 5 min). */
    function dohQuery(name, type) {
        return cache.wrap(`doh:${type}:${name}`, async () => {
            const r = await timedFetch(`${cfg().doh.google}?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`, { headers: { Accept: 'application/dns-json' } });
            const data = await r.json();
            return (data.Answer || []).map(a => ({ name: a.name, type: a.type, TTL: a.TTL, data: a.data }));
        }, (answers) => Math.min(300, Math.max(30, ...answers.map(a => a.TTL || 0))) * 1000);
    }

    function ok(res, data) { return res.json({ ok: true, ...data }); }
    function fail(res, msg, status = 400, code) { return res.status(status).json({ ok: false, error: msg, ...(code ? { code } : {}) }); }

    /** A guard refusal (403) or unresolvable name (400) as itself; anything else as `fallback` / 500. */
    function failFrom(res, err, fallback) {
        if (err instanceof TargetRefused) return fail(res, err.message, 403, err.code);
        if (err && err.status >= 400 && err.status < 500) return fail(res, err.message, err.status);
        return fail(res, (err && err.message) || fallback, 500);
    }

    /** A custom DNS server must be a public IP (optionally with a port). → 'ip' / 'ip:port', or throws. */
    function checkDnsServer(raw) {
        const s = String(raw).trim();
        const m = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/i.exec(s) || (net.isIP(s) ? [s, s, null] : /^([0-9.]+):(\d{1,5})$/.exec(s));
        if (!m || !net.isIP(m[1])) throw Object.assign(new Error('The DNS server must be an IP address'), { status: 400 });
        const port = m[2] ? parseInt(m[2], 10) : null;
        if (port !== null && (port < 1 || port > 65535)) throw Object.assign(new Error('Invalid DNS server port'), { status: 400 });
        if (!egress.isAllowed(m[1])) throw new TargetRefused(`${m[1]} is not a public internet address; the network tools only reach public hosts`);
        if (port === null) return m[1];
        return net.isIPv6(m[1]) ? `[${m[1]}]:${port}` : `${m[1]}:${port}`;
    }

    /** Get config (live — reads DB each time for admin changes) */
    function cfg() { return getNetConfig(db); }

    /** Optional auth — attaches user if token present, but doesn't block.
     *  Verifies the shared ov_token OFFLINE against the Network public key. */
    function optionalAuth(req, res, next) {
        const authHeader = req.headers.authorization;
        const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : req.cookies?.ov_token;
        const auth = req.app.locals.auth;
        if (!token || !auth) return next();
        Promise.resolve(auth.verify(token))
            .then(claims => { if (claims) req.user = claims; next(); })
            .catch(() => next());
    }

    router.use(optionalAuth);

    // ── Tool list endpoint ───────────────────────────────────
    router.get('/tools', (_req, res) => {
        ok(res, { tools: NET_TOOLS, regions: cfg().probeRegions });
    });

    // ═══════════════════════════════════════════════════════════
    // IP Info / GeoIP / ISP / ASN / MyIP
    // ═══════════════════════════════════════════════════════════

    // The address Express resolved through `trust proxy` (one nginx hop, which sets X-Forwarded-For
    // from $remote_addr). The first X-Forwarded-For entry is whatever the client sent: never used.
    router.get('/myip', (req, res) => {
        const ip = String(req.ip || req.socket.remoteAddress || '').replace(/^::ffff:(?=\d+\.)/, '');
        ok(res, { ip, version: net.isIP(ip) || null });
    });

    router.get('/ip/:target?', async (req, res) => {
        try {
            const target = parseTarget(req.params.target || req.query.target);
            if (!target) return fail(res, 'Please provide a valid domain or IP');

            // Resolve domain → IP if needed (try IPv4 first, then IPv6)
            let ip = target;
            let hostname = null;
            if (!isIP(target)) {
                let addrs = await dns.resolve4(target).catch(() => []);
                if (!addrs.length) {
                    addrs = await dns.resolve6(target).catch(() => []);
                }
                if (!addrs.length) return fail(res, `Cannot resolve ${target}`);
                ip = addrs[0];
                hostname = target;
            }

            // GeoIP (ipinfo with a token, else ip-api.com; cached)
            const data = await geoLookup(ip);

            if (data.status === 'fail') return fail(res, data.message || 'Lookup failed');

            ok(res, {
                ip: data.query || ip,
                hostname: hostname || data.reverse || null,
                geo: {
                    country: data.country,
                    countryCode: data.countryCode,
                    region: data.regionName,
                    regionCode: data.region,
                    city: data.city,
                    zip: data.zip,
                    lat: data.lat,
                    lon: data.lon,
                    timezone: data.timezone,
                },
                network: {
                    isp: data.isp,
                    org: data.org,
                    as: data.as,
                    asname: data.asname,
                },
                reverse: data.reverse || null,
            });
        } catch (err) {
            fail(res, err.message || 'IP lookup failed', 500);
        }
    });

    // IPv4 Lookup — IPv4-specific info
    router.get('/ipv4/:target?', async (req, res) => {
        try {
            const target = parseTarget(req.params.target || req.query.target);
            if (!target) return fail(res, 'Please provide a valid IPv4 address or domain');

            let ip = target;
            let hostname = null;
            if (!isIP(target)) {
                const addrs = await dns.resolve4(target).catch(() => []);
                if (!addrs.length) return fail(res, `Cannot resolve ${target} to IPv4`);
                ip = addrs[0];
                hostname = target;
            }

            // Validate it's IPv4
            if (net.isIP(ip) !== 4) return fail(res, `${ip} is not a valid IPv4 address`);

            // Determine IP class
            const parts = ip.split('.').map(Number);
            let ipClass, range;
            if (parts[0] < 128) { ipClass = 'A'; range = '1.0.0.0 - 126.255.255.255'; }
            else if (parts[0] < 192) { ipClass = 'B'; range = '128.0.0.0 - 191.255.255.255'; }
            else if (parts[0] < 224) { ipClass = 'C'; range = '192.0.0.0 - 223.255.255.255'; }
            else if (parts[0] < 240) { ipClass = 'D'; range = '224.0.0.0 - 239.255.255.255'; }
            else { ipClass = 'E'; range = '240.0.0.0 - 255.255.255.255'; }

            // Check if private
            const isPrivate = /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/.test(ip);
            const isLoopback = ip.startsWith('127.');
            const isLinkLocal = ip.startsWith('169.254.');

            // GeoIP (ipinfo with a token, else ip-api.com; cached)
            const data = await geoLookup(ip);

            if (data.status === 'fail') return fail(res, data.message || 'Lookup failed');

            ok(res, {
                ip: data.query || ip,
                hostname: hostname || data.reverse || null,
                ipv4: {
                    class: ipClass,
                    range: range,
                    isPrivate: isPrivate,
                    isLoopback: isLoopback,
                    isLinkLocal: isLinkLocal,
                },
                geo: {
                    country: data.country,
                    countryCode: data.countryCode,
                    region: data.regionName,
                    regionCode: data.region,
                    city: data.city,
                    zip: data.zip,
                    lat: data.lat,
                    lon: data.lon,
                    timezone: data.timezone,
                },
                network: {
                    isp: data.isp,
                    org: data.org,
                    as: data.as,
                    asname: data.asname,
                },
                reverse: data.reverse || null,
            });
        } catch (err) {
            fail(res, err.message || 'IPv4 lookup failed', 500);
        }
    });

    // IPv6 Lookup — IPv6-specific info
    router.get('/ipv6/:target?', async (req, res) => {
        try {
            const target = parseTarget(req.params.target || req.query.target);
            if (!target) return fail(res, 'Please provide a valid IPv6 address or domain');

            let ip = target;
            let hostname = null;
            if (!isIP(target)) {
                const addrs = await dns.resolve6(target).catch(() => []);
                if (!addrs.length) return fail(res, `Cannot resolve ${target} to IPv6`);
                ip = addrs[0];
                hostname = target;
            }

            // Validate it's IPv6
            if (net.isIP(ip) !== 6) return fail(res, `${ip} is not a valid IPv6 address`);

            // Determine IPv6 type
            let ipv6Type = 'Global Unicast';
            if (ip.startsWith('::1')) ipv6Type = 'Loopback';
            else if (ip.startsWith('::')) ipv6Type = 'Loopback/Unspecified';
            else if (ip.startsWith('fe80:')) ipv6Type = 'Link-Local';
            else if (ip.startsWith('ff')) ipv6Type = 'Multicast';
            else if (ip.startsWith('fc') || ip.startsWith('fd')) ipv6Type = 'Unique Local (Private)';
            else if (ip.startsWith('2001:db8:')) ipv6Type = 'Documentation';

            // Reverse DNS lookup
            const hostnames = await dns.reverse(ip).catch(() => []);

            ok(res, {
                ip: ip,
                hostname: hostname || hostnames[0] || null,
                ipv6: {
                    type: ipv6Type,
                    compressed: ip,
                    ptr: hostnames[0] || null,
                },
                note: 'Most public IPv6 addresses do not have geolocation data available through standard APIs.',
            });
        } catch (err) {
            fail(res, err.message || 'IPv6 lookup failed', 500);
        }
    });

    // ═══════════════════════════════════════════════════════════
    // DNS Lookup
    // ═══════════════════════════════════════════════════════════

    router.get('/dns/:target?', async (req, res) => {
        try {
            const target = parseTarget(req.params.target || req.query.target);
            if (!target) return fail(res, 'Please provide a domain');
            const types = (req.query.types || 'A,AAAA,MX,TXT,CNAME,NS,SOA').split(',').map(t => t.trim().toUpperCase());
            const c = cfg();
            const validTypes = types.filter(t => c.dnsTypes.includes(t));
            if (!validTypes.length) return fail(res, 'No valid record types specified');

            let server = null; // custom DNS server — public IPs only
            if (req.query.server) {
                try { server = checkDnsServer(req.query.server); } catch (err) { return failFrom(res, err, 'Invalid DNS server'); }
            }
            const results = {};

            // Optionally try DNS-over-HTTPS for cleaner results
            const useDoh = req.query.doh === '1' || req.query.doh === 'true';

            for (const type of validTypes) {
                try {
                    if (useDoh) {
                        results[type] = await dohQuery(target, type);
                    } else {
                        const resolver = new dns.Resolver();
                        if (server) resolver.setServers([server]);
                        const methodMap = {
                            A: 'resolve4', AAAA: 'resolve6', MX: 'resolveMx', TXT: 'resolveTxt',
                            CNAME: 'resolveCname', NS: 'resolveNs', SOA: 'resolveSoa', PTR: 'resolvePtr',
                            CAA: 'resolveCaa', SRV: 'resolveSrv', NAPTR: 'resolveNaptr',
                        };
                        const method = methodMap[type];
                        if (method && typeof resolver[method] === 'function') {
                            results[type] = await resolver[method](target);
                        } else {
                            // Fallback to DoH for unsupported types
                            results[type] = await dohQuery(target, type);
                        }
                    }
                } catch (err) {
                    results[type] = { error: err.code || err.message };
                }
            }

            ok(res, { target, server: server || 'system', records: results });
        } catch (err) {
            fail(res, err.message || 'DNS lookup failed', 500);
        }
    });

    // ═══════════════════════════════════════════════════════════
    // Reverse DNS
    // ═══════════════════════════════════════════════════════════

    router.get('/rdns/:target?', async (req, res) => {
        try {
            const target = parseTarget(req.params.target || req.query.target);
            if (!target) return fail(res, 'Please provide an IP or domain');

            let ip = target;
            if (!isIP(target)) {
                // Try both A (IPv4) and AAAA (IPv6) records
                let addrs = await dns.resolve4(target).catch(() => []);
                if (!addrs.length) {
                    addrs = await dns.resolve6(target).catch(() => []);
                }
                if (!addrs.length) return fail(res, `Cannot resolve ${target}`);
                ip = addrs[0];
            }

            // dns.reverse() works for both IPv4 and IPv6
            const hostnames = await dns.reverse(ip).catch(() => []);
            ok(res, { ip, hostnames, ptr: hostnames[0] || null });
        } catch (err) {
            fail(res, err.message || 'Reverse DNS failed', 500);
        }
    });

    // ═══════════════════════════════════════════════════════════
    // RDAP (modern Whois replacement)
    // ═══════════════════════════════════════════════════════════

    router.get('/rdap/:target?', async (req, res) => {
        try {
            const target = parseTarget(req.params.target || req.query.target);
            if (!target) return fail(res, 'Please provide a domain or IP');
            // RDAP queries: domain → /domain/, IP → /ip/ (cached)
            const rdapType = isIP(target) ? 'ip' : 'domain';
            const r = await rdapLookup(rdapType, target);

            if (!r.ok) return fail(res, `RDAP lookup failed (${r.status})`, r.status >= 500 ? 502 : 404);
            const data = r.data;

            // Extract key fields from RDAP response
            const summary = {
                handle: data.handle || null,
                name: data.name || data.ldhName || target,
                status: data.status || [],
                events: (data.events || []).map(e => ({ action: e.eventAction, date: e.eventDate })),
                entities: (data.entities || []).map(e => ({
                    handle: e.handle,
                    roles: e.roles || [],
                    name: e.vcardArray?.[1]?.find(v => v[0] === 'fn')?.[3] || null,
                })),
                nameservers: (data.nameservers || []).map(ns => ns.ldhName || ns.unicodeName),
                port43: data.port43 || null,
                links: (data.links || []).filter(l => l.rel === 'self' || l.rel === 'related').map(l => l.href),
            };

            ok(res, { target, type: rdapType, summary, raw: data });
        } catch (err) {
            fail(res, err.message || 'RDAP lookup failed', 500);
        }
    });

    // Whois alias — uses RDAP under the hood
    router.get('/whois/:target?', async (req, res) => {
        // Rewrite to RDAP
        req.params.target = req.params.target || req.query.target;
        req.url = `/rdap/${req.params.target || ''}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
        router.handle(req, res);
    });

    // ═══════════════════════════════════════════════════════════
    // SSL / TLS Certificate Check
    // ═══════════════════════════════════════════════════════════

    router.get('/ssl/:target?', async (req, res) => {
        try {
            const target = parseTarget(req.params.target || req.query.target);
            if (!target) return fail(res, 'Please provide a domain');
            const port = parseInt(req.query.port) || 443;
            if (port < 1 || port > 65535) return fail(res, 'Invalid port');

            // Resolve + check, then handshake with the checked address (SNI = the name).
            const dest = await egress.resolve(target, { prefer: 4 });
            const ip = dest.address;
            const cert = await egress.tlsHandshake(dest, port, { timeoutMs: 10000 });

            const c = cert.cert;
            const now = Date.now();
            const validFrom = new Date(c.valid_from);
            const validTo = new Date(c.valid_to);
            const daysLeft = Math.ceil((validTo - now) / 86400000);

            // Extract SAN list
            const sans = c.subjectaltname ? c.subjectaltname.split(', ').map(s => s.replace('DNS:', '')) : [];

            // Build chain
            const chain = [];
            let current = c;
            const seen = new Set();
            while (current && !seen.has(current.fingerprint256)) {
                seen.add(current.fingerprint256);
                chain.push({
                    subject: current.subject?.CN || '',
                    issuer: current.issuer?.CN || '',
                    serialNumber: current.serialNumber,
                    fingerprint: current.fingerprint256,
                    validFrom: current.valid_from,
                    validTo: current.valid_to,
                });
                current = current.issuerCertificate;
            }

            ok(res, {
                target,
                ip,
                port,
                protocol: cert.protocol,
                cipher: cert.cipher ? { name: cert.cipher.name, version: cert.cipher.version } : null,
                certificate: {
                    subject: c.subject,
                    issuer: c.issuer,
                    serialNumber: c.serialNumber,
                    validFrom: c.valid_from,
                    validTo: c.valid_to,
                    daysLeft,
                    isExpired: daysLeft < 0,
                    isExpiringSoon: daysLeft >= 0 && daysLeft <= 30,
                    sans,
                    fingerprint: c.fingerprint256,
                },
                chain,
            });
        } catch (err) {
            failFrom(res, err, 'SSL check failed');
        }
    });

    // ═══════════════════════════════════════════════════════════
    // HTTP Headers
    // ═══════════════════════════════════════════════════════════

    router.get('/headers/:target?', async (req, res) => {
        try {
            let target = (req.params.target || req.query.target || '').trim();
            if (!target) return fail(res, 'Please provide a URL or domain');
            if (!/^https?:\/\//.test(target)) target = `https://${target}`;

            const ua = String(req.query.ua || 'Mozilla/5.0 (compatible; Net.OpenVibe/1.0)').replace(/[\r\n]/g, ' ').slice(0, 300);
            const start = Date.now();
            // One hop, not followed (the Redirects tool shows the chain).
            const r = await egress.request(target, { method: 'HEAD', headers: { 'User-Agent': ua }, timeoutMs: 12000 });
            const elapsed = Date.now() - start;

            const headers = r.headers;

            // Security header analysis
            const security = {
                hasHSTS: !!headers['strict-transport-security'],
                hasCSP: !!headers['content-security-policy'],
                hasXCTO: !!headers['x-content-type-options'],
                hasXFO: !!headers['x-frame-options'],
                hasRP: !!headers['referrer-policy'],
                hasPermissions: !!headers['permissions-policy'],
            };
            const securityScore = Object.values(security).filter(Boolean).length;

            ok(res, {
                url: target,
                status: r.status,
                statusText: r.statusText,
                headers,
                timing: { ms: elapsed },
                security,
                securityScore: `${securityScore}/6`,
                server: headers['server'] || null,
                poweredBy: headers['x-powered-by'] || null,
                contentType: headers['content-type'] || null,
            });
        } catch (err) {
            failFrom(res, err, 'Headers check failed');
        }
    });

    // ═══════════════════════════════════════════════════════════
    // Redirect Chain
    // ═══════════════════════════════════════════════════════════

    router.get('/redirects/:target?', async (req, res) => {
        try {
            let target = (req.params.target || req.query.target || '').trim();
            if (!target) return fail(res, 'Please provide a URL or domain');
            if (!/^https?:\/\//.test(target)) target = `https://${target}`;

            const chain = [];
            let current = target;
            const maxHops = 15;

            let refused = null;
            for (let i = 0; i < maxHops; i++) {
                const start = Date.now();
                let r;
                try {
                    // Every hop goes through the guard again: a public site redirecting to an
                    // internal address stops here, before anything connects to it.
                    r = await egress.request(current, {
                        method: 'HEAD',
                        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Net.OpenVibe/1.0)' },
                        timeoutMs: 12000,
                    });
                } catch (err) {
                    if (i === 0) throw err;
                    if (!(err instanceof TargetRefused) && !(err && err.status === 400)) throw err;
                    if (err instanceof TargetRefused) refused = err.message;
                    chain.push({ url: current, status: null, refused: err instanceof TargetRefused, error: err.message, ms: Date.now() - start });
                    break;
                }
                const elapsed = Date.now() - start;

                chain.push({
                    url: current,
                    status: r.status,
                    statusText: r.statusText,
                    location: r.headers.location || null,
                    server: r.headers.server || null,
                    ms: elapsed,
                });

                if (r.status >= 300 && r.status < 400 && r.headers.location) {
                    current = new URL(r.headers.location, current).href;
                } else {
                    break;
                }
            }

            ok(res, {
                originalUrl: target,
                finalUrl: chain[chain.length - 1]?.url || target,
                hops: chain.length,
                chain,
                ...(refused ? { stopped: refused } : {}),
            });
        } catch (err) {
            failFrom(res, err, 'Redirect check failed');
        }
    });

    // ═══════════════════════════════════════════════════════════
    // Port Check
    // ═══════════════════════════════════════════════════════════

    router.get('/port/:target?', async (req, res) => {
        try {
            const target = parseTarget(req.params.target || req.query.target);
            if (!target) return fail(res, 'Please provide a host');

            const portsStr = req.query.ports || '80,443,22,21,25,53,3306,5432,8080,8443';
            const ports = portsStr.split(',').map(p => parseInt(p.trim())).filter(p => p > 0 && p <= 65535).slice(0, 20);
            if (!ports.length) return fail(res, 'No valid ports specified');

            // Resolve + check; every probe dials the checked address.
            const dest = await egress.resolve(target, { prefer: 4 });
            const ip = dest.address;

            const results = await Promise.all(ports.map(port =>
                egress.tcpProbe(ip, port, { timeoutMs: 5000 }).then(r => ({ port, status: r.status, ms: r.ms }))));

            ok(res, { target, ip, ports: results });
        } catch (err) {
            failFrom(res, err, 'Port check failed');
        }
    });

    // ═══════════════════════════════════════════════════════════
    // Ping (from this server)
    // ═══════════════════════════════════════════════════════════

    router.get('/ping/:target?', async (req, res) => {
        try {
            const target = parseTarget(req.params.target || req.query.target);
            if (!target) return fail(res, 'Please provide a host');
            const count = Math.min(parseInt(req.query.count) || 4, 10);

            // Resolve + check; every ping dials the checked address.
            const dest = await egress.resolve(target, { prefer: 4 });
            const ip = dest.address;

            // TCP ping (more reliable than ICMP from Node.js + doesn't require root)
            const results = [];
            for (let i = 0; i < count; i++) {
                const r = await egress.tcpProbe(ip, 443, { timeoutMs: 5000 });
                results.push({ seq: i + 1, ms: r.ms, status: r.status === 'open' ? 'ok' : (r.error || r.status) });
                // Small delay between pings
                if (i < count - 1) await new Promise(r => setTimeout(r, 200));
            }

            const successful = results.filter(r => r.status === 'ok');
            const stats = successful.length > 0 ? {
                min: Math.min(...successful.map(r => r.ms)),
                max: Math.max(...successful.map(r => r.ms)),
                avg: Math.round(successful.reduce((s, r) => s + r.ms, 0) / successful.length),
                loss: Math.round((1 - successful.length / results.length) * 100),
            } : { min: 0, max: 0, avg: 0, loss: 100 };

            ok(res, { target, ip, count, results, stats });
        } catch (err) {
            failFrom(res, err, 'Ping failed');
        }
    });

    // ═══════════════════════════════════════════════════════════
    // Supertool Lookup (combines multiple tools)
    // ═══════════════════════════════════════════════════════════

    router.get('/lookup/:target?', async (req, res) => {
        try {
            const target = parseTarget(req.params.target || req.query.target);
            if (!target) return fail(res, 'Please provide a domain, IP, or URL');

            // Internal targets are refused outright; a name that does not resolve still gets DNS/RDAP.
            try { await egress.resolve(target); } catch (err) { if (err instanceof TargetRefused) return failFrom(res, err); }

            // Run multiple lookups in parallel
            const [ipResult, dnsResult, rdapResult, sslResult, headersResult, rdnsResult] = await Promise.allSettled([
                // IP/Geo
                (async () => {
                    let ip = target;
                    if (!isIP(target)) {
                        const addrs = await dns.resolve4(target).catch(() => []);
                        if (addrs.length) ip = addrs[0]; else return null;
                    }
                    const data = await geoLookup(ip);
                    if (data.status === 'fail') return null;
                    return data;
                })(),
                // DNS
                (async () => {
                    if (isIP(target)) return null;
                    const records = {};
                    for (const type of ['A', 'AAAA', 'MX', 'TXT', 'NS', 'CNAME']) {
                        try {
                            const resolver = new dns.Resolver();
                            const methodMap = { A: 'resolve4', AAAA: 'resolve6', MX: 'resolveMx', TXT: 'resolveTxt', NS: 'resolveNs', CNAME: 'resolveCname' };
                            records[type] = await resolver[methodMap[type]](target);
                        } catch { records[type] = []; }
                    }
                    return records;
                })(),
                // RDAP
                (async () => {
                    const r = await rdapLookup(isIP(target) ? 'ip' : 'domain', target);
                    return r.ok ? r.data : null;
                })(),
                // SSL (domain only)
                (async () => {
                    if (isIP(target)) return null;
                    try {
                        const dest = await egress.resolve(target, { prefer: 4 });
                        const { cert: c, protocol: proto } = await egress.tlsHandshake(dest, 443, { timeoutMs: 8000, detailed: false });
                        const validTo = new Date(c.valid_to);
                        return {
                            subject: c.subject?.CN,
                            issuer: c.issuer?.CN || c.issuer?.O,
                            validFrom: c.valid_from,
                            validTo: c.valid_to,
                            daysLeft: Math.ceil((validTo - Date.now()) / 86400000),
                            protocol: proto,
                            sans: c.subjectaltname ? c.subjectaltname.split(', ').map(s => s.replace('DNS:', '')).slice(0, 10) : [],
                        };
                    } catch { return null; }
                })(),
                // Headers (redirects followed, each hop re-checked)
                (async () => {
                    if (isIP(target)) return null;
                    const url = `https://${target}`;
                    const start = Date.now();
                    const r = await egress.follow(url, { method: 'HEAD', headers: { 'User-Agent': 'Net.OpenVibe/1.0' }, timeoutMs: 12000, maxRedirects: 5 });
                    const ms = Date.now() - start;
                    const headers = r.headers;
                    return { status: r.status, ms, headers, server: headers['server'] || null };
                })(),
                // Reverse DNS
                (async () => {
                    let ip = target;
                    if (!isIP(target)) {
                        const addrs = await dns.resolve4(target).catch(() => []);
                        if (addrs.length) ip = addrs[0]; else return null;
                    }
                    const hostnames = await dns.reverse(ip).catch(() => []);
                    return { ip, hostnames };
                })(),
            ]);

            // Build summary
            const ipData = ipResult.status === 'fulfilled' ? ipResult.value : null;
            const dnsData = dnsResult.status === 'fulfilled' ? dnsResult.value : null;
            const rdapData = rdapResult.status === 'fulfilled' ? rdapResult.value : null;
            const sslData = sslResult.status === 'fulfilled' ? sslResult.value : null;
            const headersData = headersResult.status === 'fulfilled' ? headersResult.value : null;
            const rdnsData = rdnsResult.status === 'fulfilled' ? rdnsResult.value : null;

            // Quick status badges
            const badges = [];
            if (ipData) badges.push(`📍 ${ipData.city || ipData.country || 'Unknown location'}`);
            if (ipData?.isp) badges.push(`🏢 ${ipData.isp}`);
            if (sslData) {
                if (sslData.daysLeft < 0) badges.push('🔴 SSL expired');
                else if (sslData.daysLeft <= 30) badges.push(`🟡 SSL expires in ${sslData.daysLeft}d`);
                else badges.push(`🟢 SSL ok (${sslData.daysLeft}d left)`);
            }
            if (headersData) badges.push(`${headersData.status < 400 ? '🟢' : '🔴'} HTTP ${headersData.status}`);
            if (dnsData?.MX?.length) badges.push('✉️ MX present');
            if (rdnsData?.hostnames?.length) badges.push(`🔄 PTR: ${rdnsData.hostnames[0]}`);

            ok(res, {
                target,
                badges,
                ip: ipData ? {
                    address: ipData.query,
                    country: ipData.country,
                    countryCode: ipData.countryCode,
                    region: ipData.regionName,
                    city: ipData.city,
                    lat: ipData.lat,
                    lon: ipData.lon,
                    timezone: ipData.timezone,
                    isp: ipData.isp,
                    org: ipData.org,
                    as: ipData.as,
                    asname: ipData.asname,
                } : null,
                dns: dnsData,
                rdap: rdapData ? {
                    name: rdapData.name || rdapData.ldhName,
                    status: rdapData.status,
                    events: (rdapData.events || []).map(e => ({ action: e.eventAction, date: e.eventDate })),
                    nameservers: (rdapData.nameservers || []).map(ns => ns.ldhName),
                    entities: (rdapData.entities || []).slice(0, 5).map(e => ({
                        roles: e.roles, handle: e.handle,
                    })),
                } : null,
                ssl: sslData,
                headers: headersData,
                reverseDns: rdnsData,
            });
        } catch (err) {
            fail(res, err.message || 'Lookup failed', 500);
        }
    });

    // ═══════════════════════════════════════════════════════════
    // Website, mail and DNS checks (server/net/checks.js)
    // ═══════════════════════════════════════════════════════════

    const raw = (req) => String(req.params.target || req.query.target || '').trim();
    const host = (req) => { const t = parseTarget(raw(req)); if (!t) throw Object.assign(new Error('Please provide a domain or IP'), { status: 400 }); return t; };
    const run = (label, fn) => async (req, res) => {
        try { ok(res, await fn(req)); } catch (err) { failFrom(res, err, `${label} failed`); }
    };

    router.get('/robots/:target?', run('robots.txt check', (req) => checks.robots(raw(req), { path: req.query.path, ua: req.query.ua })));
    router.get('/sitemap/:target?', run('Sitemap check', (req) => checks.sitemap(raw(req))));
    router.get('/uptime/:target?', run('Uptime check', (req) => checks.uptime(raw(req))));
    router.get('/smtp/:target?', run('SMTP test', (req) => checks.smtp(host(req), { port: req.query.port })));
    router.get('/blacklist/:target?', run('Blacklist check', (req) => checks.blacklist(host(req))));
    router.get('/dnsprop/:target?', run('DNS propagation check', (req) => checks.dnsprop(host(req), { type: req.query.type })));

    return router;
};
