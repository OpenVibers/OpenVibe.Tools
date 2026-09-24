'use strict';
// ═══════════════════════════════════════════════════════════════
// Client addresses (decision 5).
//
// The host's nginx applies Cloudflare's real IP (real_ip_header CF-Connecting-IP, Cloudflare ranges
// only) and every proxied location sets X-Forwarded-For to $remote_addr. So there is exactly one
// proxy hop, and it is on loopback: `trust proxy` is TRUST_PROXY below in every app, req.ip is the
// only address anyone reads, and a client's own X-Forwarded-For is never believed. A first-party
// process that calls a Tools app on loopback on behalf of a visitor (the gateway's proxy to a
// satellite, food → maps) is that one hop too, and forwards the visitor's address the same way.
// An app listening beyond loopback (maps binds 0.0.0.0 by default) believes nobody else's header.
// ═══════════════════════════════════════════════════════════════

const net = require('net');

/** '::ffff:1.2.3.4' → '1.2.3.4'; zone ids dropped; lower case. */
function normalizeIp(ip) {
    let s = String(ip || '').trim().toLowerCase();
    const pct = s.indexOf('%');
    if (pct >= 0) s = s.slice(0, pct);
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) s = mapped[1];
    return s;
}

function isLoopback(ip) {
    const s = normalizeIp(ip);
    return s === '::1' || /^127\./.test(s);
}

/** An IPv6 address → its eight groups, expanded. */
function expand6(ip) {
    let s = ip;
    const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (v4) {
        const n = v4[1].split('.').reduce((a, o) => a * 256 + Number(o), 0) >>> 0;
        s = s.slice(0, -v4[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
    }
    const [head, tail] = s.split('::');
    const left = head ? head.split(':') : [];
    const right = tail !== undefined && tail ? tail.split(':') : [];
    const groups = tail !== undefined ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
    return groups.map(g => g.padStart(4, '0'));
}

/**
 * The unit an address is counted as: an IPv4 address itself, an IPv6 address by its /64 (one
 * customer's network: a host can pick any of its 2^64 addresses). Not an IP → '' (never throws).
 */
function ipBucket(ip) {
    const s = normalizeIp(ip);
    const v = net.isIP(s);
    if (v === 4) return s;
    if (v === 6) return `${expand6(s).slice(0, 4).join(':')}::/64`;
    return '';
}

/** Express `trust proxy`: exactly one hop, and only when that hop is on loopback. */
function TRUST_PROXY(addr, i) {
    return i === 0 && isLoopback(addr);
}

module.exports = { normalizeIp, isLoopback, ipBucket, expand6, TRUST_PROXY };
