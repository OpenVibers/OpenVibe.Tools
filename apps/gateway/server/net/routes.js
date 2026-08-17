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
const tls = require('tls');
const net = require('net');
const https = require('https');
const http = require('http');
const { getNetConfig, NET_TOOLS } = require('./config');

const router = express.Router();

module.exports = function createNetRoutes(db, requireAuth) {

    // ── Helpers ──────────────────────────────────────────────

    /** Safely extract hostname from user input (domain, IP, or URL) */
    function parseTarget(input) {
        if (!input || typeof input !== 'string') return null;
        let t = input.trim();
        // Strip protocol if URL
        try {
            if (/^https?:\/\//.test(t)) { t = new URL(t).hostname; }
        } catch {}
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
            const res = await fetch(url, { ...opts, signal: controller.signal });
            return res;
        } finally { clearTimeout(timer); }
    }

    function ok(res, data) { return res.json({ ok: true, ...data }); }
    function fail(res, msg, status = 400) { return res.status(status).json({ ok: false, error: msg }); }

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

    router.get('/myip', (req, res) => {
        const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
                || req.headers['x-real-ip']
                || req.socket.remoteAddress || '';
        ok(res, { ip });
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

            // GeoIP via ip-api.com (free, no key, JSON)
            const c = cfg();
            const ipUrl = `${c.ipapi.baseUrl}/json/${ip}?fields=status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,asname,reverse,query`;
            const r = await timedFetch(ipUrl);
            const data = await r.json();

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

            // GeoIP via ip-api.com
            const c = cfg();
            const ipUrl = `${c.ipapi.baseUrl}/json/${ip}?fields=status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,asname,reverse,query`;
            const r = await timedFetch(ipUrl);
            const data = await r.json();

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

            const server = req.query.server || null; // custom DNS server
            const results = {};

            // Optionally try DNS-over-HTTPS for cleaner results
            const useDoh = req.query.doh === '1' || req.query.doh === 'true';

            for (const type of validTypes) {
                try {
                    if (useDoh) {
                        const r = await timedFetch(`${c.doh.google}?name=${encodeURIComponent(target)}&type=${type}`, {
                            headers: { Accept: 'application/dns-json' },
                        });
                        const data = await r.json();
                        results[type] = (data.Answer || []).map(a => ({
                            name: a.name, type: a.type, TTL: a.TTL, data: a.data,
                        }));
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
                            const r = await timedFetch(`${c.doh.google}?name=${encodeURIComponent(target)}&type=${type}`, {
                                headers: { Accept: 'application/dns-json' },
                            });
                            const data = await r.json();
                            results[type] = (data.Answer || []).map(a => ({ name: a.name, type: a.type, TTL: a.TTL, data: a.data }));
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
            const c = cfg();

            // RDAP queries: domain → /domain/, IP → /ip/
            const rdapType = isIP(target) ? 'ip' : 'domain';
            const url = `${c.rdap.baseUrl}/${rdapType}/${encodeURIComponent(target)}`;
            const r = await timedFetch(url, { headers: { Accept: 'application/rdap+json, application/json' } });

            if (!r.ok) return fail(res, `RDAP lookup failed (${r.status})`, r.status >= 500 ? 502 : 404);
            const data = await r.json();

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

            // Resolve first to include IPs
            let ip = target;
            if (!isIP(target)) {
                const addrs = await dns.resolve4(target).catch(() => []);
                if (addrs.length) ip = addrs[0];
            }

            const cert = await new Promise((resolve, reject) => {
                const socket = tls.connect({ host: target, port, servername: target, timeout: 10000 }, () => {
                    const peerCert = socket.getPeerCertificate(true);
                    const proto = socket.getProtocol();
                    const cipher = socket.getCipher();
                    socket.end();
                    resolve({ cert: peerCert, protocol: proto, cipher });
                });
                socket.on('error', reject);
                socket.setTimeout(10000, () => { socket.destroy(new Error('Timeout')); });
            });

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
            fail(res, err.message || 'SSL check failed', 500);
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

            const ua = req.query.ua || 'Mozilla/5.0 (compatible; Net.OpenVibe/1.0)';
            const start = Date.now();
            const r = await timedFetch(target, {
                method: 'HEAD',
                headers: { 'User-Agent': ua },
                redirect: 'manual',
            });
            const elapsed = Date.now() - start;

            const headers = {};
            r.headers.forEach((v, k) => { headers[k] = v; });

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
            fail(res, err.message || 'Headers check failed', 500);
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

            for (let i = 0; i < maxHops; i++) {
                const start = Date.now();
                const r = await timedFetch(current, {
                    method: 'HEAD',
                    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Net.OpenVibe/1.0)' },
                    redirect: 'manual',
                });
                const elapsed = Date.now() - start;

                chain.push({
                    url: current,
                    status: r.status,
                    statusText: r.statusText,
                    location: r.headers.get('location') || null,
                    server: r.headers.get('server') || null,
                    ms: elapsed,
                });

                if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
                    const loc = r.headers.get('location');
                    current = loc.startsWith('/') ? new URL(loc, current).href : loc;
                } else {
                    break;
                }
            }

            ok(res, {
                originalUrl: target,
                finalUrl: chain[chain.length - 1]?.url || target,
                hops: chain.length,
                chain,
            });
        } catch (err) {
            fail(res, err.message || 'Redirect check failed', 500);
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

            // Resolve domain
            let ip = target;
            if (!isIP(target)) {
                const addrs = await dns.resolve4(target).catch(() => []);
                if (!addrs.length) return fail(res, `Cannot resolve ${target}`);
                ip = addrs[0];
            }

            const results = await Promise.all(ports.map(port => {
                return new Promise(resolve => {
                    const start = Date.now();
                    const socket = new net.Socket();
                    socket.setTimeout(5000);
                    socket.on('connect', () => {
                        const ms = Date.now() - start;
                        socket.destroy();
                        resolve({ port, status: 'open', ms });
                    });
                    socket.on('timeout', () => {
                        socket.destroy();
                        resolve({ port, status: 'filtered', ms: 5000 });
                    });
                    socket.on('error', (err) => {
                        const ms = Date.now() - start;
                        resolve({ port, status: err.code === 'ECONNREFUSED' ? 'closed' : 'filtered', ms });
                    });
                    socket.connect(port, ip);
                });
            }));

            ok(res, { target, ip, ports: results });
        } catch (err) {
            fail(res, err.message || 'Port check failed', 500);
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

            // Resolve domain
            let ip = target;
            if (!isIP(target)) {
                const addrs = await dns.resolve4(target).catch(() => []);
                if (!addrs.length) return fail(res, `Cannot resolve ${target}`);
                ip = addrs[0];
            }

            // TCP ping (more reliable than ICMP from Node.js + doesn't require root)
            const results = [];
            for (let i = 0; i < count; i++) {
                const start = Date.now();
                try {
                    await new Promise((resolve, reject) => {
                        const socket = new net.Socket();
                        socket.setTimeout(5000);
                        socket.on('connect', () => {
                            const ms = Date.now() - start;
                            socket.destroy();
                            resolve(ms);
                        });
                        socket.on('timeout', () => { socket.destroy(); reject(new Error('timeout')); });
                        socket.on('error', reject);
                        socket.connect(443, ip);
                    }).then(ms => results.push({ seq: i + 1, ms, status: 'ok' }));
                } catch (err) {
                    results.push({ seq: i + 1, ms: Date.now() - start, status: err.message });
                }
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
            fail(res, err.message || 'Ping failed', 500);
        }
    });

    // ═══════════════════════════════════════════════════════════
    // Supertool Lookup (combines multiple tools)
    // ═══════════════════════════════════════════════════════════

    router.get('/lookup/:target?', async (req, res) => {
        try {
            const target = parseTarget(req.params.target || req.query.target);
            if (!target) return fail(res, 'Please provide a domain, IP, or URL');

            // Run multiple lookups in parallel
            const [ipResult, dnsResult, rdapResult, sslResult, headersResult, rdnsResult] = await Promise.allSettled([
                // IP/Geo
                (async () => {
                    let ip = target;
                    if (!isIP(target)) {
                        const addrs = await dns.resolve4(target).catch(() => []);
                        if (addrs.length) ip = addrs[0]; else return null;
                    }
                    const c = cfg();
                    const r = await timedFetch(`${c.ipapi.baseUrl}/json/${ip}?fields=status,message,country,countryCode,region,regionName,city,lat,lon,timezone,isp,org,as,asname,reverse,query`);
                    const data = await r.json();
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
                    const c = cfg();
                    const rdapType = isIP(target) ? 'ip' : 'domain';
                    const r = await timedFetch(`${c.rdap.baseUrl}/${rdapType}/${encodeURIComponent(target)}`, {
                        headers: { Accept: 'application/rdap+json, application/json' },
                    });
                    if (!r.ok) return null;
                    return await r.json();
                })(),
                // SSL (domain only)
                (async () => {
                    if (isIP(target)) return null;
                    return new Promise((resolve) => {
                        const socket = tls.connect({ host: target, port: 443, servername: target, timeout: 8000 }, () => {
                            const c = socket.getPeerCertificate();
                            const proto = socket.getProtocol();
                            socket.end();
                            const validTo = new Date(c.valid_to);
                            resolve({
                                subject: c.subject?.CN,
                                issuer: c.issuer?.CN || c.issuer?.O,
                                validFrom: c.valid_from,
                                validTo: c.valid_to,
                                daysLeft: Math.ceil((validTo - Date.now()) / 86400000),
                                protocol: proto,
                                sans: c.subjectaltname ? c.subjectaltname.split(', ').map(s => s.replace('DNS:', '')).slice(0, 10) : [],
                            });
                        });
                        socket.on('error', () => resolve(null));
                        socket.setTimeout(8000, () => { socket.destroy(); resolve(null); });
                    });
                })(),
                // Headers
                (async () => {
                    if (isIP(target)) return null;
                    const url = `https://${target}`;
                    const start = Date.now();
                    const r = await timedFetch(url, { method: 'HEAD', headers: { 'User-Agent': 'Net.OpenVibe/1.0' }, redirect: 'follow' });
                    const ms = Date.now() - start;
                    const headers = {};
                    r.headers.forEach((v, k) => { headers[k] = v; });
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

    return router;
};
