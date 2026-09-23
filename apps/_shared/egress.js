'use strict';
/**
 * SSRF guard for every tool that connects to a host or URL a visitor chose (Net.OpenVibe port
 * check, ping, SSL, headers, redirects, lookup; Dev.OpenVibe Open Graph; the DNS tool's custom
 * server). Adapted from OpenVibe.Events server/egress.js.
 *
 *   - every address the hostname resolves to must be public: no loopback, RFC 1918, link-local
 *     (cloud metadata 169.254.169.254 included), CGNAT, 0.0.0.0/8, multicast, documentation,
 *     benchmarking, reserved, unique-local or site-local IPv6, and no IPv6 form that wraps one of
 *     those (v4-mapped, NAT64, 6to4, Teredo)
 *   - the check runs AFTER DNS resolution, and the connection goes to the checked address: raw
 *     sockets connect to the IP literal (SNI set to the hostname), HTTP requests get a `lookup`
 *     that only ever answers with the addresses already checked, so a second DNS answer (rebinding)
 *     is never consulted
 *   - redirects are not followed by `request`; `follow` re-runs the whole check on every hop
 *   - localhost, *.localhost, *.local, *.internal and single-label names are refused before DNS
 *
 * createEgress({ lookup, … }) takes the resolver and transports as options so tests run without
 * a network. A refusal throws TargetRefused (status 403, code tools.net.target_not_public).
 */
const dns = require('dns');
const net = require('net');
const tls = require('tls');
const http = require('http');
const https = require('https');

const blocked = new net.BlockList();
for (const [addr, prefix] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
    ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
    ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
    ['::', 128], ['::1', 128], ['::', 96], ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10],
    ['fec0::', 10], ['ff00::', 8], ['3fff::', 20], ['5f00::', 16],
]) blocked.addSubnet(addr, prefix, 'ipv6');

function expandV6(ip) {
    let s = String(ip).toLowerCase();
    const pct = s.indexOf('%');
    if (pct >= 0) s = s.slice(0, pct);
    if (!net.isIPv6(s)) return null;
    // Trailing dotted quad -> two words.
    const dq = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (dq) {
        const p = dq[1].split('.').map(Number);
        s = s.slice(0, -dq[1].length) + `${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
    }
    const [head, tail] = s.split('::');
    const h = head ? head.split(':') : [];
    const t = tail !== undefined ? (tail ? tail.split(':') : []) : null;
    const words = t === null ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
    if (words.length !== 8) return null;
    return words.map(w => parseInt(w || '0', 16));
}

/** The IPv4 address an IPv6 address carries (v4-mapped, NAT64, 6to4, Teredo), or null. */
function embeddedV4(ip) {
    const words = expandV6(ip);
    if (!words) return null;
    const v4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    if (words.slice(0, 5).every(w => w === 0) && words[5] === 0xffff) return v4(words[6], words[7]);            // ::ffff:a.b.c.d
    if (words[0] === 0x64 && words[1] === 0xff9b) return v4(words[6], words[7]);                                // 64:ff9b::/96 (and /48)
    if (words[0] === 0x2002) return v4(words[1], words[2]);                                                      // 6to4
    if (words[0] === 0x2001 && words[1] === 0) return v4(words[6] ^ 0xffff, words[7] ^ 0xffff);                 // Teredo client
    return null;
}

/** True only for a globally routable unicast address. */
function isPublicAddress(ip) {
    const s = String(ip || '');
    const family = net.isIP(s);
    if (family === 4) return !blocked.check(s, 'ipv4');
    if (family === 6) {
        const bare = s.split('%')[0];
        if (blocked.check(bare, 'ipv6')) return false;
        const v4 = embeddedV4(bare);
        if (v4 !== null) return !blocked.check(v4, 'ipv4');
        return true;
    }
    return false;
}

class TargetRefused extends Error {
    constructor(message) {
        super(message);
        this.name = 'TargetRefused';
        this.code = 'tools.net.target_not_public';
        this.status = 403;
    }
}

/** Lower-case, drop [brackets] and trailing dots. */
function normalizeHost(host) {
    let h = String(host || '').trim().toLowerCase();
    if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
    return h.replace(/\.+$/, '');
}

/** Names refused before any DNS: they can only mean this machine or a private network. */
function isInternalName(host) {
    return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')
        || host.endsWith('.home.arpa') || !host.includes('.');
}

const refusedMessage = (what) => `${what} is not a public internet address; the network tools only reach public hosts`;

function createEgress({
    lookup = dns.lookup, isAllowed = isPublicAddress,
    httpRequest = http.request, httpsRequest = https.request, tcpConnect = net.connect, tlsConnect = tls.connect,
} = {}) {

    /**
     * Resolve `host` and check every address. → { host, literal, address, family, addresses }.
     * Throws TargetRefused, or an Error with status 400 when the name does not resolve.
     * `prefer: 4` picks an IPv4 address first when there is one (every address is still checked).
     */
    function resolve(rawHost, { prefer = 0 } = {}) {
        const host = normalizeHost(rawHost);
        if (!host) return Promise.reject(Object.assign(new Error('Please provide a host'), { status: 400 }));
        const family = net.isIP(host);
        if (family) {
            if (!isAllowed(host)) return Promise.reject(new TargetRefused(refusedMessage(host)));
            return Promise.resolve({ host, literal: true, address: host, family, addresses: [{ address: host, family }] });
        }
        if (isInternalName(host)) return Promise.reject(new TargetRefused(refusedMessage(host)));
        return new Promise((ok, fail) => {
            lookup(host, { all: true, verbatim: true }, (err, addresses) => {
                if (err) return fail(Object.assign(new Error(`Cannot resolve ${host}`), { status: 400, cause: err }));
                const list = (Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIP(addresses) }])
                    .map(a => ({ address: a.address, family: a.family || net.isIP(a.address) }));
                if (!list.length) return fail(Object.assign(new Error(`Cannot resolve ${host}`), { status: 400 }));
                if (list.some(a => !isAllowed(a.address))) return fail(new TargetRefused(refusedMessage(`${host} resolves to an address that`)));
                const pick = (prefer && list.find(a => a.family === prefer)) || list[0];
                ok({ host, literal: false, address: pick.address, family: pick.family, addresses: list });
            });
        });
    }

    /** A socket `lookup` that only answers with addresses that were already checked. */
    function pinnedLookup(addresses) {
        return (hostname, opts, cb) => {
            if (typeof opts === 'function') { cb = opts; opts = {}; }
            const fam = (opts && opts.family) || 0;
            const list = addresses.filter(a => !fam || a.family === fam);
            if (!list.length) return cb(Object.assign(new Error(`${hostname} has no IPv${fam} address`), { code: 'ENOTFOUND' }));
            if (opts && opts.all) return cb(null, list.map(a => ({ address: a.address, family: a.family })));
            return cb(null, list[0].address, list[0].family);
        };
    }

    function assertChecked(address) {
        if (!net.isIP(address) || !isAllowed(address)) throw new TargetRefused(refusedMessage(address));
    }

    /**
     * TCP connect to a checked address. → Promise<{ status: 'open'|'closed'|'filtered', ms, error? }>.
     */
    function tcpProbe(address, port, { timeoutMs = 5000 } = {}) {
        assertChecked(address);
        return new Promise((resolveProbe) => {
            const start = Date.now();
            let settled = false;
            const done = (r, socket) => { if (settled) return; settled = true; socket.destroy(); resolveProbe(r); };
            const socket = tcpConnect({ host: address, port });
            socket.setTimeout(timeoutMs);
            socket.on('connect', () => done({ status: 'open', ms: Date.now() - start }, socket));
            socket.on('timeout', () => done({ status: 'filtered', ms: timeoutMs, error: 'timeout' }, socket));
            socket.on('error', (err) => done({ status: err.code === 'ECONNREFUSED' ? 'closed' : 'filtered', ms: Date.now() - start, error: err.code || err.message }, socket));
        });
    }

    /**
     * TLS handshake with a checked address, SNI = the hostname. → Promise<{ cert, protocol, cipher }>.
     * `target` is the result of resolve().
     */
    function tlsHandshake(target, port, { timeoutMs = 10000, detailed = true } = {}) {
        assertChecked(target.address);
        return new Promise((ok, fail) => {
            const socket = tlsConnect({
                host: target.address, port,
                servername: target.literal ? undefined : target.host,
                // Verify against the name the person typed, not the IP we dialled.
                checkServerIdentity: (_h, cert) => tls.checkServerIdentity(target.host, cert),
            }, () => {
                const cert = socket.getPeerCertificate(detailed);
                const protocol = socket.getProtocol();
                const cipher = socket.getCipher();
                socket.end();
                ok({ cert, protocol, cipher });
            });
            socket.on('error', fail);
            socket.setTimeout(timeoutMs, () => socket.destroy(new Error('Timeout')));
        });
    }

    /** Parse and vet a URL (syntax only). → URL. Throws 400 / TargetRefused. */
    function parseUrl(raw) {
        let url;
        try { url = new URL(raw); } catch { throw Object.assign(new Error('Invalid URL'), { status: 400 }); }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw Object.assign(new Error('Only http and https URLs are supported'), { status: 400 });
        if (url.username || url.password) throw Object.assign(new Error('Credentials in the URL are not supported'), { status: 400 });
        return url;
    }

    /**
     * One HTTP(S) request to a user-chosen URL; redirects are NOT followed.
     * → Promise<{ url, status, statusText, headers, body, truncated }>. body is a Buffer ('' for HEAD
     * or when maxBytes is 0).
     */
    async function request(rawUrl, { method = 'GET', headers = {}, timeoutMs = 12000, maxBytes = 0 } = {}) {
        const url = parseUrl(rawUrl);
        const target = await resolve(url.hostname);
        const secure = url.protocol === 'https:';
        return new Promise((ok, fail) => {
            let settled = false;
            let deadline = null;
            const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(deadline); fn(v); } };
            const req = (secure ? httpsRequest : httpRequest)({
                hostname: target.literal ? target.address : target.host,
                port: url.port || (secure ? 443 : 80),
                path: `${url.pathname}${url.search}`,
                method,
                headers,
                agent: false,
                // Only the checked addresses: no second DNS answer is ever used.
                lookup: target.literal ? undefined : pinnedLookup(target.addresses),
                servername: secure && !target.literal ? target.host : undefined,
                timeout: timeoutMs,
            }, (res) => {
                const flat = {};
                for (const [k, v] of Object.entries(res.headers || {})) flat[k] = Array.isArray(v) ? v.join(', ') : v;
                const out = { url: url.href, status: res.statusCode, statusText: res.statusMessage || '', headers: flat, body: Buffer.alloc(0), truncated: false };
                if (method === 'HEAD' || !maxBytes) { res.destroy(); return done(ok, out); }
                const chunks = [];
                let size = 0;
                const finish = (truncated) => {
                    if (settled) return;
                    out.truncated = truncated;
                    out.body = truncated ? Buffer.concat(chunks).subarray(0, maxBytes) : Buffer.concat(chunks);
                    done(ok, out);
                };
                res.on('data', (c) => {
                    chunks.push(c); size += c.length;
                    if (size > maxBytes) { finish(true); res.destroy(); }
                });
                res.on('end', () => finish(false));
                res.on('error', (err) => done(fail, err));
                res.on('close', () => finish(false));
            });
            const timeout = () => req.destroy(Object.assign(new Error('Timeout'), { name: 'TimeoutError' }));
            deadline = setTimeout(timeout, timeoutMs);
            req.on('timeout', timeout);
            req.on('error', (err) => done(fail, err));
            req.end();
        });
    }

    /**
     * request() that follows up to `maxRedirects` redirects, re-checking every hop.
     * → the final response plus `chain` (every hop's url and status). A hop to a non-public address
     * throws TargetRefused before any connection is made to it.
     */
    async function follow(rawUrl, { maxRedirects = 5, ...opts } = {}) {
        let current = rawUrl;
        const chain = [];
        for (let i = 0; ; i++) {
            const r = await request(current, opts);
            chain.push({ url: r.url, status: r.status });
            const loc = r.headers.location;
            if (!(r.status >= 300 && r.status < 400 && loc) || i >= maxRedirects) return { ...r, chain };
            current = new URL(loc, r.url).href;
        }
    }

    return { resolve, pinnedLookup, tcpProbe, tlsHandshake, parseUrl, request, follow, isAllowed };
}

module.exports = { createEgress, isPublicAddress, embeddedV4, normalizeHost, TargetRefused };
