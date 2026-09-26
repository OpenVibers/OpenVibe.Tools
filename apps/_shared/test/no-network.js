'use strict';
// Preload (node -r) for tests that start a satellite whose code calls third-party APIs: every
// connection to anything but loopback fails at once (ECONNREFUSED) and every lookup of a name other
// than localhost fails (ENOTFOUND), so the process's error paths run without touching the internet.
const dns = require('dns');
const net = require('net');

const LOCAL = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);
const isLocal = (h) => h == null || LOCAL.has(String(h).replace(/^\[|\]$/g, '').toLowerCase());
const notFound = (host) => Object.assign(new Error(`getaddrinfo ENOTFOUND ${host} (no network in tests)`), { code: 'ENOTFOUND', hostname: host });

const realLookup = dns.lookup;
dns.lookup = function (host, options, cb) {
    if (typeof options === 'function') { cb = options; options = {}; }
    if (isLocal(host)) return realLookup.call(this, host, options, cb);
    process.nextTick(() => cb(notFound(host)));
    return {};
};
const realPromiseLookup = dns.promises.lookup;
dns.promises.lookup = async function (host, options) {
    if (isLocal(host)) return realPromiseLookup.call(this, host, options);
    throw notFound(host);
};
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
    let o = args[0];
    if (Array.isArray(o)) o = o[0];
    const host = o && typeof o === 'object' ? (o.path != null ? null : o.host) : (typeof args[1] === 'string' ? args[1] : null);
    if (o && typeof o === 'object' && o.path != null) return realConnect.apply(this, args);
    if (!isLocal(host)) {
        const err = Object.assign(new Error(`connect ECONNREFUSED ${host} (no network in tests)`), { code: 'ECONNREFUSED', syscall: 'connect' });
        process.nextTick(() => this.destroy(err));
        return this;
    }
    return realConnect.apply(this, args);
};
if (typeof globalThis.fetch === 'function') {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (url, opts) => {
        let host = null;
        try { host = new URL(String((url && url.url) || url)).hostname; } catch { /* */ }
        if (!isLocal(host)) return Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: notFound(host) }));
        return realFetch(url, opts);
    };
}
