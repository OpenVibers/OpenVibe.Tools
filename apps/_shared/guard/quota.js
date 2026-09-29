'use strict';
// ═══════════════════════════════════════════════════════════════
// Tiered quotas: a token bucket per (key, class) and a UTC-day allowance per (key, class). A run takes
// its descriptor's `cost` from both, all or nothing.
//
// The day allowance is shared across processes through the guard store (Valkey, plan T8 decision 4) and
// so are the minute/burst buckets when a Valkey connection is passed: one Lua call refills and spends
// one bucket atomically, so two hosts enforce one quota. Without Valkey (or on an outage) both legs use
// this process's own counters — a throttle that never fails open and never fails every request.
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

// Refill a bucket (tokens + elapsed × rate, capped at burst) and spend `need`, atomically. It only
// consumes when the bucket holds `need`: a refused run changes nothing. Returns "tokens:ok".
// ARGV: burst, rate (tokens/ms), need, now (ms), ttl (s).
const SPEND = `
local key = KEYS[1]
local burst = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local need = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])
local d = redis.call('HMGET', key, 'tokens', 'at')
local tokens = (d[1] and tonumber(d[1])) or burst
local at = (d[2] and tonumber(d[2])) or now
tokens = math.min(burst, tokens + (now - at) * rate)
if tokens < need then return tostring(tokens)..':0' end
local left = tokens - need
redis.call('HSET', key, 'tokens', tostring(left), 'at', tostring(now))
redis.call('EXPIRE', key, ttl)
return tostring(left)..':1'`;
// Refill and give `need` back (a run that cost less than the up-front charge), capped at burst.
const REFUND = `
local key = KEYS[1]
local burst = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local need = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])
local d = redis.call('HMGET', key, 'tokens', 'at')
local tokens = (d[1] and tonumber(d[1])) or burst
local at = (d[2] and tonumber(d[2])) or now
tokens = math.min(burst, tokens + (now - at) * rate)
local left = math.min(burst, tokens + need)
redis.call('HSET', key, 'tokens', tostring(left), 'at', tostring(now))
redis.call('EXPIRE', key, ttl)
return tostring(left)`;

function createValkeyBuckets(valkey, log) {
    const c = valkey.client;
    if (typeof c.ovBucketSpend !== 'function') c.defineCommand('ovBucketSpend', { lua: SPEND });
    if (typeof c.ovBucketRefund !== 'function') c.defineCommand('ovBucketRefund', { lua: REFUND });
    let up = true;
    return {
        get down() { return !up; },
        /** { left, ok } — ok false means the bucket was short and nothing was taken. null: Valkey is down. */
        async spend(id, lim, need, t) {
            try {
                const r = String(await c.ovBucketSpend(1, valkey.key('bucket', id), String(lim.burst), String(lim.perMinute / 60_000), String(need), String(t), String(600)));
                const [left, ok] = r.split(':');
                return { left: Number(left), ok: ok === '1' };
            } catch (err) { up = false; log.warn(`[Quota] Valkey buckets unavailable (${err.message}); counting in this process`); return null; }
        },
        async refund(id, lim, need, t) {
            try { await c.ovBucketRefund(1, valkey.key('bucket', id), String(lim.burst), String(lim.perMinute / 60_000), String(need), String(t), String(600)); } catch { /* fallback ignores */ }
        },
    };
}

/**
 * @param {object} o
 * @param {object} o.store            guard store (async dayUsed, dayAdd)
 * @param {() => object} o.quotas     the QUOTAS table (limits.quotas())
 * @param {() => number} [o.now]
 * @param {number} [o.maxBuckets]
 * @param {object} [o.valkey]         openvibe-sdk/valkey connection (shared buckets); absent → in-process
 */
function createQuotas(o) {
    const now = o.now || Date.now;
    const buckets = new Map();      // `${cls}|${key}` → { tokens, at }
    const maxBuckets = o.maxBuckets || 200_000;
    const log = o.log || console;
    const shared = o.valkey ? createValkeyBuckets(o.valkey, log) : null;
    let lastSweep = now();

    function sweep(t) {
        // Buckets that are full again carry no information: drop them.
        if (t - lastSweep < 60_000 && buckets.size < maxBuckets) return;
        lastSweep = t;
        for (const [k, b] of buckets) if (t - b.at > 10 * 60_000) buckets.delete(k);
    }

    /** A bucket's tokens right now (refilled since it was last touched), from the process map. */
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
    async function check(caller, { quotaClass, cost = 1 }, opt = {}) {
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
            const id = `${quotaClass}|${c.key}`;
            const rate = lim.perMinute / 60_000;
            // Shared (Valkey): refill and spend in one atomic call, and decide from its answer. Otherwise
            // (no Valkey, or an outage) decide and spend from this process's own map below.
            let tokens, minuteOk, done = false;
            if (shared && !shared.down) {
                const r = await shared.spend(id, lim, need, t);
                if (r) { tokens = r.ok ? r.left + need : r.left; minuteOk = r.ok; done = true; }
            }
            if (!done) { tokens = level(id, lim, t); minuteOk = tokens >= need; }
            const used = lim.perDay > 0 ? await o.store.dayUsed(day, c.key, quotaClass) : 0;
            const dayOk = !(lim.perDay > 0) || used + cost <= lim.perDay;
            const after = Math.max(0, tokens - need);
            views.push({
                c, need, tokens, rate, dayUsed: used, done,
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
                if (!v.done) await spend(`${quotaClass}|${v.c.key}`, v.c.lim, v.need, t, v.tokens);
                if (v.c.lim.perDay > 0) await o.store.dayAdd(day, v.c.key, quotaClass, cost);
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

    /** Take `need` from a bucket: shared (Valkey) when it is up, this process otherwise. */
    async function spend(id, lim, need, t, peekedTokens) {
        if (shared && !shared.down) {
            if (await shared.spend(id, lim, need, t) != null) return;
        }
        const left = Math.max(0, peekedTokens - need);
        buckets.set(id, { tokens: left, at: t });
        if (buckets.size > maxBuckets) buckets.delete(buckets.keys().next().value);
    }

    /** Give tokens back (a run that turned out to cost less than was taken up front). Day units stay counted. */
    async function refund(caller, { quotaClass, cost }) {
        if (!(cost > 0)) return;
        const t = now();
        for (const c of chargesFor(caller, quotaClass, o.quotas())) {
            const id = `${quotaClass}|${c.key}`;
            if (shared && !shared.down) { await shared.refund(id, c.lim, cost, t); continue; }
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
