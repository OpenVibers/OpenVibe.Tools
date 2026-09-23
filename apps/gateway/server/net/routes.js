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
// ── IPv4 / IPv6 arithmetic ─────────────────────────────────

const ipv4ToInt = (ip) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0) >>> 0;
const intToIpv4 = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

/** a.b.c.d/prefix → the subnet: network, broadcast, mask, usable range and counts (RFC 3021 for /31). */
function cidr4(ip, prefix) {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    const network = (ipv4ToInt(ip) & mask) >>> 0;
    const broadcast = (network | (~mask >>> 0)) >>> 0;
    const total = 2 ** (32 - prefix);
    const p2p = prefix >= 31;
    return {
        cidr: `${intToIpv4(network)}/${prefix}`, prefix,
        network: intToIpv4(network), broadcast: p2p ? null : intToIpv4(broadcast),
        netmask: intToIpv4(mask), wildcard: intToIpv4(~mask >>> 0),
        firstUsable: intToIpv4(p2p ? network : network + 1), lastUsable: intToIpv4(p2p ? broadcast : broadcast - 1),
        total, usable: p2p ? total : total - 2,
    };
}

const V4_RANGES = [
    ['0.0.0.0/8', 'This network (reserved)'], ['10.0.0.0/8', 'Private (RFC 1918)'], ['100.64.0.0/10', 'Carrier-grade NAT (RFC 6598)'],
    ['127.0.0.0/8', 'Loopback'], ['169.254.0.0/16', 'Link-local'], ['172.16.0.0/12', 'Private (RFC 1918)'],
    ['192.0.0.0/24', 'IETF protocol assignments'], ['192.0.2.0/24', 'Documentation (TEST-NET-1)'], ['192.168.0.0/16', 'Private (RFC 1918)'],
    ['198.18.0.0/15', 'Benchmarking (RFC 2544)'], ['198.51.100.0/24', 'Documentation (TEST-NET-2)'], ['203.0.113.0/24', 'Documentation (TEST-NET-3)'],
    ['224.0.0.0/4', 'Multicast'], ['255.255.255.255/32', 'Broadcast'], ['240.0.0.0/4', 'Reserved (class E)'],
];

function ipv4Info(ip) {
    const first = Number(ip.split('.')[0]);
    const [cls, range] = first < 128 ? ['A', '0.0.0.0 - 127.255.255.255'] : first < 192 ? ['B', '128.0.0.0 - 191.255.255.255']
        : first < 224 ? ['C', '192.0.0.0 - 223.255.255.255'] : first < 240 ? ['D', '224.0.0.0 - 239.255.255.255'] : ['E', '240.0.0.0 - 255.255.255.255'];
    const n = ipv4ToInt(ip);
    const hit = V4_RANGES.find(([block]) => { const [base, p] = block.split('/'); const m = Number(p) === 0 ? 0 : (0xffffffff << (32 - Number(p))) >>> 0; return ((n & m) >>> 0) === ipv4ToInt(base); });
    const type = hit ? hit[1] : 'Public';
    return { class: cls, range, type, isPrivate: /Private|Carrier/.test(type), isLoopback: type === 'Loopback', isLinkLocal: type === 'Link-local', isPublic: type === 'Public' };
}

/** Any IPv6 text form (including an embedded IPv4 tail) → eight 4-digit groups. */
function expand6(ip) {
    let s = ip.toLowerCase().replace(/%.*$/, '');
    const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (v4) { const n = ipv4ToInt(v4[1]); s = s.slice(0, -v4[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`; }
    const [head, tail] = s.split('::');
    const left = head ? head.split(':') : [];
    const right = tail !== undefined && tail ? tail.split(':') : [];
    const groups = tail !== undefined ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
    return groups.map(g => g.padStart(4, '0')).join(':');
}

/** Eight groups → RFC 5952 text: no leading zeros, the longest run of two or more zero groups as ::. */
function compress6(expanded) {
    const groups = expanded.split(':').map(g => g.replace(/^0+(?=.)/, ''));
    let best = [-1, 0];
    for (let i = 0; i < 8;) {
        if (groups[i] !== '0') { i++; continue; }
        let j = i; while (j < 8 && groups[j] === '0') j++;
        if (j - i > best[1] && j - i >= 2) best = [i, j - i];
        i = j;
    }
    if (best[0] < 0) return groups.join(':');
    return `${groups.slice(0, best[0]).join(':')}::${groups.slice(best[0] + best[1]).join(':')}`;
}

const V6_SCOPES = { 1: 'interface-local', 2: 'link-local', 4: 'admin-local', 5: 'site-local', 8: 'organization-local', 14: 'global' };
function ipv6Kind(expanded) {
    const g = expanded.split(':').map(x => parseInt(x, 16));
    const zeroTo = (k) => g.slice(0, k).every(x => x === 0);
    if (zeroTo(8)) return { type: 'Unspecified', scope: null, prefix: '::/128' };
    if (zeroTo(7) && g[7] === 1) return { type: 'Loopback', scope: 'host', prefix: '::1/128' };
    if (zeroTo(5) && g[5] === 0xffff) return { type: 'IPv4-mapped', scope: null, prefix: '::ffff:0:0/96' };
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return { type: 'NAT64 (IPv4-translated)', scope: 'global', prefix: '64:ff9b::/96', global: true };
    if ((g[0] & 0xffc0) === 0xfe80) return { type: 'Link-local', scope: 'link', prefix: 'fe80::/10' };
    if ((g[0] & 0xfe00) === 0xfc00) return { type: 'Unique local (private)', scope: 'site', prefix: 'fc00::/7' };
    if ((g[0] & 0xff00) === 0xff00) return { type: 'Multicast', scope: V6_SCOPES[g[0] & 0xf] || 'reserved', prefix: 'ff00::/8' };
    if (g[0] === 0x2001 && g[1] === 0x0db8) return { type: 'Documentation', scope: null, prefix: '2001:db8::/32' };
    if (g[0] === 0x2001 && g[1] === 0) return { type: 'Teredo', scope: 'global', prefix: '2001::/32', global: true };
    if (g[0] === 0x2002) return { type: '6to4', scope: 'global', prefix: '2002::/16', global: true };
    if ((g[0] & 0xe000) === 0x2000) return { type: 'Global unicast', scope: 'global', prefix: '2000::/3', global: true };
    return { type: 'Reserved', scope: null, prefix: null };
}

module.exports = function createNetRoutes(db, requireAuth, opts = {}) {
    const router = express.Router();
    const egress = opts.egress || createEgress();
    // Upstream answers are cached: ip-api's free tier is rate limited (and plain HTTP), RDAP and DoH
    // answers change slowly. Tests pass their own fetch.
    const fetchImpl = opts.fetch || fetch;
    const cache = opts.cache || createCache({ max: 5000, ttlMs: HOUR });
    const checks = createChecks({ egress, cache, ...(opts.resolverFor && { resolverFor: opts.resolverFor }), ...(opts.tlsUpgrade && { tlsUpgrade: opts.tlsUpgrade }) });
    const reverseDns = opts.reverse || ((ip) => dns.reverse(ip));

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

    // IPv4 Lookup & CIDR calculator: a CIDR block (a.b.c.d/nn) gives the subnet; an address gives its
    // class, what kind of range it is in, and (for public addresses) the owner and location.
    router.get('/ipv4/:target?', async (req, res) => {
        try {
            const rawTarget = String(req.params.target || req.query.target || '').trim();
            const block = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(rawTarget);
            if (block) {
                const prefix = Number(block[2]);
                if (net.isIP(block[1]) !== 4 || prefix > 32) return fail(res, 'Enter a CIDR block like 192.168.1.0/24');
                return ok(res, { ip: block[1], cidr: cidr4(block[1], prefix), ipv4: ipv4Info(block[1]) });
            }
            const target = parseTarget(rawTarget);
            if (!target) return fail(res, 'Please provide a valid IPv4 address, CIDR block or domain');

            let ip = target;
            let hostname = null;
            if (!isIP(target)) {
                const addrs = await dns.resolve4(target).catch(() => []);
                if (!addrs.length) return fail(res, `Cannot resolve ${target} to IPv4`);
                ip = addrs[0];
                hostname = target;
            }
            if (net.isIP(ip) !== 4) return fail(res, `${ip} is not a valid IPv4 address`);

            const out = { ip, hostname, ipv4: ipv4Info(ip), cidr: cidr4(ip, 32) };
            // Private and reserved addresses have no public owner or location.
            if (!egress.isAllowed(ip)) return ok(res, { ...out, note: 'A private or reserved address: it has no public owner or location.' });

            const data = await geoLookup(ip);   // ipinfo with a token, else ip-api.com; cached
            if (data.status === 'fail') return ok(res, { ...out, note: data.message || 'No owner information' });
            ok(res, {
                ...out,
                hostname: hostname || data.reverse || null,
                geo: {
                    country: data.country, countryCode: data.countryCode, region: data.regionName, regionCode: data.region,
                    city: data.city, zip: data.zip, lat: data.lat, lon: data.lon, timezone: data.timezone,
                },
                network: { isp: data.isp, org: data.org, as: data.as, asname: data.asname },
                reverse: data.reverse || null,
            });
        } catch (err) {
            fail(res, err.message || 'IPv4 lookup failed', 500);
        }
    });

    // IPv6 Lookup: full and compressed notation, what kind of address it is, reverse DNS, and the owner
    // of a global address.
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
            if (net.isIP(ip) !== 6) return fail(res, `${ip} is not a valid IPv6 address`);

            const expanded = expand6(ip);
            const kind = ipv6Kind(expanded);
            const hostnames = await reverseDns(ip).catch(() => []);
            const out = {
                ip: compress6(expanded), hostname: hostname || hostnames[0] || null,
                ipv6: { type: kind.type, scope: kind.scope, prefix: kind.prefix, expanded, compressed: compress6(expanded), ptr: hostnames[0] || null },
            };
            if (kind.global && egress.isAllowed(ip)) {
                const data = await geoLookup(ip).catch(() => null);
                if (data && data.status === 'success') {
                    out.network = { isp: data.isp, org: data.org, as: data.as, asname: data.asname };
                    out.geo = { country: data.country, countryCode: data.countryCode, region: data.regionName, city: data.city, timezone: data.timezone };
                }
            }
            ok(res, out);
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

module.exports.helpers = { cidr4, ipv4Info, expand6, compress6, ipv6Kind };
