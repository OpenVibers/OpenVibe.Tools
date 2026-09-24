'use strict';
// ═══════════════════════════════════════════════════════════════
// Egress bounds (hard limits: they apply in report mode too).
//
// Per-target throttle: one bucket per target host or address, across every caller and every tool.
// It holds one minute of work; a run of a tool costs 1 / its descriptor's limits.perTargetPerMinute of
// it, so headers (10 a minute) and SMTP (3 a minute) against one host share one budget, and nobody
// can point the network tools at a host faster than the strictest of them allows.
//
// Port-scan cap: the port checker takes at most `perRequest` ports a request, and one caller at most
// `perCaller` ports and `targetsPerCaller` distinct targets in a rolling window, so it can check a
// server's own ports but cannot sweep a range.
// ═══════════════════════════════════════════════════════════════

const { ipBucket } = require('./ip');

/** 'https://Example.COM:8443/x' → 'example.com'; an IPv6 address → its /64. '' when there is nothing. */
function normalizeTarget(raw) {
    let t = String(raw || '').trim().toLowerCase();
    if (!t) return '';
    t = t.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
    t = t.replace(/^[^@/]*@/, '');                // user:pass@
    const bracket = /^\[([0-9a-f:.]+)\]/.exec(t);
    if (bracket) t = bracket[1];
    else {
        t = t.replace(/[/?#].*$/, '');
        if ((t.match(/:/g) || []).length === 1) t = t.replace(/:\d*$/, '');
    }
    t = t.replace(/\.+$/, '');
    return ipBucket(t) || t.slice(0, 253);
}

function createTargetThrottle({ now = Date.now } = {}) {
    const buckets = new Map();   // target → { units, at }
    const FULL = 1;              // one minute of work

    function take(target, perMinute) {
        const key = normalizeTarget(target);
        if (!key || !(perMinute > 0)) return { ok: true, retryAfter: 0, target: key };
        const t = now();
        if (buckets.size > 50_000) for (const [k, b] of buckets) if (t - b.at > 60_000) buckets.delete(k);
        const b = buckets.get(key);
        const units = b ? Math.min(FULL, b.units + (t - b.at) / 60_000) : FULL;
        const cost = 1 / perMinute;
        if (units + 1e-9 < cost) return { ok: false, retryAfter: Math.max(1, Math.ceil((cost - units) * 60)), target: key };
        buckets.set(key, { units: units - cost, at: t });
        return { ok: true, retryAfter: 0, target: key };
    }

    return { take, size: () => buckets.size };
}

function createPortScanCap({ perRequest = 20, windowMs = 10 * 60_000, perCaller = 100, targetsPerCaller = 10, now = Date.now } = {}) {
    const callers = new Map();   // caller key → [{ at, target, ports }]

    /** → { ok, reason?, detail?, retryAfter? }; records the probe when it is allowed. */
    function take(callerKey, target, ports) {
        const n = Array.isArray(ports) ? ports.length : Number(ports) || 0;
        if (n > perRequest) return { ok: false, reason: 'ports.per_request', detail: `At most ${perRequest} ports per check` };
        const t = now();
        const key = normalizeTarget(target);
        const list = (callers.get(callerKey) || []).filter(e => t - e.at < windowMs);
        const used = list.reduce((s, e) => s + e.ports, 0);
        const targets = new Set(list.map(e => e.target));
        const retryAfter = list.length ? Math.max(1, Math.ceil((list[0].at + windowMs - t) / 1000)) : 1;
        if (used + n > perCaller) {
            callers.set(callerKey, list);
            return { ok: false, reason: 'ports.per_caller', detail: `At most ${perCaller} ports every ${Math.round(windowMs / 60_000)} minutes`, retryAfter };
        }
        if (!targets.has(key) && targets.size >= targetsPerCaller) {
            callers.set(callerKey, list);
            return { ok: false, reason: 'ports.targets', detail: `At most ${targetsPerCaller} different hosts every ${Math.round(windowMs / 60_000)} minutes`, retryAfter };
        }
        list.push({ at: t, target: key, ports: n });
        callers.set(callerKey, list);
        if (callers.size > 50_000) for (const [k, l] of callers) if (!l.length || t - l[l.length - 1].at > windowMs) callers.delete(k);
        return { ok: true };
    }

    return { take, perRequest };
}

module.exports = { normalizeTarget, createTargetThrottle, createPortScanCap };
