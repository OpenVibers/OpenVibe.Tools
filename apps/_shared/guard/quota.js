'use strict';
// ═══════════════════════════════════════════════════════════════
// Tiered quotas: a token bucket per (key, class) in memory, and a UTC-day allowance per (key, class)
// in guard.db. A run takes its descriptor's `cost` from both, all or nothing.
//
// Who is charged (keys come from the caller resolver, addresses already hashed):
//   anonymous   its address (IPv6: its /64) at the anonymous tier
//   session     the session at the session tier, AND every session from that address together at
//               SESSION_IP_SHARE × the session tier — so dropping the cookie never resets anything
//   user        the person; service / sandbox: the principal
//
// check() → { ok, limit, remaining, reset, retryAfter, scope, binding }: `limit`/`remaining`/`reset`
// describe whichever allowance is closest to running out (the RateLimit-* headers), `retryAfter` the
// seconds until this run would fit. With { report: true } a refused run is still counted (the work
// happens), which keeps report mode's numbers honest.
// ═══════════════════════════════════════════════════════════════

const { SESSION_IP_SHARE } = require('./limits');
const { dayOf, DAY_MS } = require('./store');

/**
 * @param {object} o
 * @param {object} o.store            guard store (dayUsed, dayAdd)
 * @param {() => object} o.quotas     the QUOTAS table (limits.quotas())
 * @param {() => number} [o.now]
 * @param {number} [o.maxBuckets]
 */
function createQuotas(o) {
    const now = o.now || Date.now;
    const buckets = new Map();      // `${cls}|${key}` → { tokens, at }
    const maxBuckets = o.maxBuckets || 200_000;
    let lastSweep = now();

    function sweep(t) {
        // Buckets that are full again carry no information: drop them.
        if (t - lastSweep < 60_000 && buckets.size < maxBuckets) return;
        lastSweep = t;
        for (const [k, b] of buckets) if (t - b.at > 10 * 60_000) buckets.delete(k);
    }

    /** A bucket's tokens right now (refilled since it was last touched). */
    function level(id, lim, t) {
        const b = buckets.get(id);
        if (!b) return lim.burst;
        const rate = lim.perMinute / 60_000;
        return Math.min(lim.burst, b.tokens + (t - b.at) * rate);
    }

    function chargesFor(caller, cls, table) {
        const tiers = table[cls];
        if (!tiers) return [];
        const tier = tiers[caller.tier] || tiers.anonymous;
        if (caller.tier === 'anonymous') return [{ key: caller.ipKey, lim: tier, scope: 'address' }];
        if (caller.tier === 'session') {
            const share = { perMinute: tier.perMinute * SESSION_IP_SHARE, burst: tier.burst * SESSION_IP_SHARE, perDay: tier.perDay * SESSION_IP_SHARE };
            return [{ key: caller.key, lim: tier, scope: 'session' }, { key: `sessions@${caller.ipKey}`, lim: share, scope: 'address' }];
        }
        return [{ key: caller.key, lim: tier, scope: caller.tier }];
    }

    /**
     * @param {object} caller      { tier, key, ipKey }
     * @param {object} q           { quotaClass, cost }
     * @param {object} [opt]       { report: charge even when refused }
     */
    function check(caller, { quotaClass, cost = 1 }, opt = {}) {
        const t = now();
        sweep(t);
        const table = o.quotas();
        const charges = chargesFor(caller, quotaClass, table);
        if (!charges.length) return { ok: true, limit: null, remaining: null, reset: null, retryAfter: 0 };
        const day = dayOf(t);
        const nextDay = Math.ceil((Math.floor(t / DAY_MS) + 1) * DAY_MS / 1000) - Math.floor(t / 1000);
        let ok = true, retryAfter = 0, binding = null, scope = null;
        const views = [];
        for (const c of charges) {
            const { lim } = c;
            if (!(lim.burst > 0) || !(lim.perMinute > 0)) continue;
            const need = Math.min(cost, lim.burst);          // one run never costs more than a full bucket
            const tokens = level(`${quotaClass}|${c.key}`, lim, t);
            const rate = lim.perMinute / 60_000;
            const minuteOk = tokens >= need;
            const used = lim.perDay > 0 ? o.store.dayUsed(day, c.key, quotaClass) : 0;
            const dayOk = !(lim.perDay > 0) || used + cost <= lim.perDay;
            const after = Math.max(0, tokens - need);
            views.push({
                c, need, tokens, rate, dayUsed: used,
                minute: { limit: lim.burst, remaining: Math.floor(after), reset: Math.ceil((lim.burst - after) / rate / 1000) },
                day: lim.perDay > 0 ? { limit: lim.perDay, remaining: Math.max(0, Math.floor(lim.perDay - used - cost)), reset: nextDay } : null,
            });
            if (!minuteOk) {
                ok = false;
                const wait = Math.ceil((need - tokens) / rate / 1000);
                if (wait > retryAfter) { retryAfter = wait; binding = 'minute'; scope = c.scope; }
            }
            if (!dayOk) {
                ok = false;
                if (nextDay > retryAfter) { retryAfter = nextDay; binding = 'day'; scope = c.scope; }
            }
        }
        if (ok || opt.report) {
            for (const v of views) {
                buckets.set(`${quotaClass}|${v.c.key}`, { tokens: Math.max(0, v.tokens - v.need), at: t });
                if (v.c.lim.perDay > 0) o.store.dayAdd(day, v.c.key, quotaClass, cost);
            }
        }
        // The headers describe the allowance closest to running out, in units of this run's cost.
        let head = null;
        for (const v of views) {
            for (const w of [v.minute, v.day]) {
                if (!w) continue;
                const runsLeft = w.remaining / Math.max(1, cost);
                if (!head || runsLeft < head.runsLeft) head = { ...w, runsLeft };
            }
        }
        return {
            ok, retryAfter: ok ? 0 : Math.max(1, retryAfter), binding, scope,
            limit: head ? head.limit : null, remaining: head ? (ok ? head.remaining : 0) : null, reset: head ? head.reset : null,
        };
    }

    /** Give tokens back (a run that turned out to cost less than was taken up front). Day units stay counted. */
    function refund(caller, { quotaClass, cost }) {
        if (!(cost > 0)) return;
        const t = now();
        for (const c of chargesFor(caller, quotaClass, o.quotas())) {
            const id = `${quotaClass}|${c.key}`;
            if (buckets.has(id)) buckets.set(id, { tokens: Math.min(c.lim.burst, level(id, c.lim, t) + cost), at: t });
        }
    }

    return { check, refund, size: () => buckets.size };
}

/** RateLimit-* headers (IETF draft) from a check() answer. */
function setHeaders(res, r) {
    if (!r || r.limit == null || res.headersSent) return;
    res.setHeader('RateLimit-Limit', String(r.limit));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, r.remaining)));
    res.setHeader('RateLimit-Reset', String(Math.max(0, r.reset)));
}

module.exports = { createQuotas, setHeaders };
