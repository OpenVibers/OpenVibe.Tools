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
const path = require('path');

// The public-address rule is openvibe-shared/egress (the one Live and Events use too). apps/_shared has
// no node_modules of its own: resolve it from the gateway, the only app that loads this file.
const shared = require(require.resolve('openvibe-shared/egress', { paths: [path.join(__dirname, '..', 'gateway')] }));
const { isPublicAddress, embeddedV4, normalizeHost, isInternalName } = shared;

class TargetRefused extends Error {
    constructor(message) {
        super(message);
        this.name = 'TargetRefused';
        this.code = 'tools.net.target_not_public';
        this.status = 403;
    }
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
     * An open TCP socket to a checked address, for tools that talk a protocol themselves (SMTP).
     * → Promise<net.Socket> (connected; the caller owns it and must destroy it).
     */
    function connect(address, port, { timeoutMs = 8000 } = {}) {
        assertChecked(address);
        return new Promise((ok, fail) => {
            const socket = tcpConnect({ host: address, port });
            const timer = setTimeout(() => { socket.destroy(); fail(Object.assign(new Error('Connection timed out'), { code: 'ETIMEDOUT' })); }, timeoutMs);
            socket.once('connect', () => { clearTimeout(timer); ok(socket); });
            socket.once('error', (err) => { clearTimeout(timer); socket.destroy(); fail(err); });
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

    return { resolve, pinnedLookup, tcpProbe, connect, tlsHandshake, parseUrl, request, follow, isAllowed };
}

module.exports = { createEgress, isPublicAddress, embeddedV4, normalizeHost, TargetRefused };
