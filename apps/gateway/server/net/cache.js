'use strict';

// ═══════════════════════════════════════════════════════════════
// Net.OpenVibe — a small in-memory TTL cache for upstream lookups (ip-api / ipinfo, RDAP,
// DNS-over-HTTPS, DNSBL answers). Least recently used entries go first once `max` is reached;
// concurrent asks for the same key share one upstream call.
// ═══════════════════════════════════════════════════════════════

function createCache({ max = 1000, ttlMs = 10 * 60_000, now = Date.now } = {}) {
    const map = new Map();        // key → { value, expires }, oldest first
    const inflight = new Map();   // key → Promise

    function get(key) {
        const e = map.get(key);
        if (!e) return undefined;
        if (e.expires <= now()) { map.delete(key); return undefined; }
        map.delete(key); map.set(key, e);   // most recently used last
        return e.value;
    }

    function set(key, value, ttl = ttlMs) {
        map.delete(key);
        if (!(ttl > 0)) return;
        map.set(key, { value, expires: now() + ttl });
        while (map.size > max) map.delete(map.keys().next().value);
    }

    /**
     * The cached value, or fn()'s — kept for `ttl` ms (a number, or a function of the value; 0 = do
     * not keep it, e.g. an upstream error). A rejected fn() is not cached.
     */
    function wrap(key, fn, ttl = ttlMs) {
        const hit = get(key);
        if (hit !== undefined) return Promise.resolve(hit);
        if (inflight.has(key)) return inflight.get(key);
        const p = (async () => {
            try {
                const value = await fn();
                set(key, value, typeof ttl === 'function' ? ttl(value) : ttl);
                return value;
            } finally {
                inflight.delete(key);
            }
        })();
        inflight.set(key, p);
        return p;
    }

    return { get, set, wrap, size: () => map.size, clear: () => { map.clear(); inflight.clear(); } };
}

module.exports = { createCache };
