'use strict';
// ═══════════════════════════════════════════════════════════════
// Tiered quotas: a token bucket per (key, class) and a UTC-day allowance per (key, class). A run takes
// its descriptor's `cost` from both, all or nothing.
//
// The day allowance and the minute/burst buckets are shared across processes in Valkey (plan T8
// decision 4) when a connection is passed: ONE Lua call refills every bucket a run touches, checks
// every bucket and every day allowance, and charges them all only when all of them fit — so two hosts
// enforce one quota, and a refused run (say, on the day leg) never spends a bucket token. Without Valkey
// (or on an outage) the buckets are this process's and the day allowances go through the guard store's
// own atomic check-and-charge — a throttle that never fails open and never fails every request.
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
const { dayOf, dayTtl, dayKey, dayField, DAY_MS } = require('./store');

// The whole quota decision for one run, atomically: refill each bucket (tokens + elapsed × rate, capped
// at burst), read each day allowance, and only when every bucket holds its `need` and every allowance
// has room for `cost` — or in report mode (the work happens anyway) — take them all. A refused run
// changes nothing. KEYS[1..n] the buckets, KEYS[n+1] the day hash (guard_day, shared with the store).
// ARGV: n, now (ms), bucket ttl (s), day ttl (s), report (1/0), then per charge: burst, rate
// (tokens/ms), need, perDay (0 = none), cost, day field. Returns per charge "tokens,used,minuteOk,dayOk"
// (tokens and used before this run), joined with ";".
const CHARGE = `
local n = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local bttl = tonumber(ARGV[3])
local dttl = tonumber(ARGV[4])
local report = ARGV[5] == '1'
local day = KEYS[n + 1]
local ok = true
local st = {}
local out = {}
for i = 1, n do
  local b = 5 + (i - 1) * 6
  local burst = tonumber(ARGV[b + 1])
  local rate = tonumber(ARGV[b + 2])
  local need = tonumber(ARGV[b + 3])
  local perDay = tonumber(ARGV[b + 4])
  local cost = tonumber(ARGV[b + 5])
  local field = ARGV[b + 6]
  local d = redis.call('HMGET', KEYS[i], 'tokens', 'at')
  local tokens = (d[1] and tonumber(d[1])) or burst
  local at = (d[2] and tonumber(d[2])) or now
  tokens = math.min(burst, tokens + math.max(0, now - at) * rate)
  local used = 0
  if perDay > 0 then used = tonumber(redis.call('HGET', day, field) or '0') end
  local minuteOk = tokens >= need
  local dayOk = perDay <= 0 or used + cost <= perDay
  if not (minuteOk and dayOk) then ok = false end
  st[i] = { tokens, need, perDay, cost, field }
  out[i] = tostring(tokens) .. ',' .. tostring(used) .. ',' .. (minuteOk and '1' or '0') .. ',' .. (dayOk and '1' or '0')
end
if ok or report then
  local days = false
  for i = 1, n do
    local c = st[i]
    redis.call('HSET', KEYS[i], 'tokens', tostring(math.max(0, c[1] - c[2])), 'at', tostring(now))
    redis.call('EXPIRE', KEYS[i], bttl)
    if c[3] > 0 then redis.call('HINCRBYFLOAT', day, c[5], c[4]); days = true end
  end
  if days then redis.call('EXPIRE', day, dttl) end
end
return table.concat(out, ';')`;
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
    if (typeof c.ovQuotaCharge !== 'function') c.defineCommand('ovQuotaCharge', { lua: CHARGE });
    if (typeof c.ovBucketRefund !== 'function') c.defineCommand('ovBucketRefund', { lua: REFUND });
    let up = true;
    return {
        get down() { return !up; },
        /**
         * Decide and charge a run in one call. charges: [{ id, lim, need, cost, field }].
         * → [{ tokens, used, minuteOk, dayOk }] (before this run); null: Valkey is down.
         */
        async charge(charges, day, t, report) {
            try {
                const args = [String(charges.length), String(t), '600', String(dayTtl(t)), report ? '1' : '0'];
                for (const x of charges) {
                    args.push(String(x.lim.burst), String(x.lim.perMinute / 60_000), String(x.need), String(x.lim.perDay > 0 ? x.lim.perDay : 0), String(x.cost), x.field);
                }
                const keys = charges.map((x) => valkey.key('bucket', x.id)).concat(dayKey(valkey, day));
                const r = String(await c.ovQuotaCharge(keys.length, ...keys, ...args));
                return r.split(';').map((row) => {
                    const [tokens, used, m, d] = row.split(',');
                    return { tokens: Number(tokens), used: Number(used), minuteOk: m === '1', dayOk: d === '1' };
                });
            } catch (err) { up = false; log.warn(`[Quota] Valkey buckets unavailable (${err.message}); counting in this process`); return null; }
        },
        async refund(id, lim, need, t) {
            try { await c.ovBucketRefund(1, valkey.key('bucket', id), String(lim.burst), String(lim.perMinute / 60_000), String(need), String(t), String(600)); } catch { /* fallback ignores */ }
        },
    };
}

/**
 * @param {object} o
 * @param {object} o.store            guard store (async dayCharge: the day allowances without Valkey)
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
        const charges = chargesFor(caller, quotaClass, table)
            .filter((c) => c.lim.burst > 0 && c.lim.perMinute > 0)
            .map((c) => ({
                ...c, cost, id: `${quotaClass}|${c.key}`, field: dayField(c.key, quotaClass),
                need: Math.min(cost, c.lim.burst),          // one run never costs more than a full bucket
            }));
        if (!charges.length) return { ok: true, limit: null, remaining: null, reset: null, retryAfter: 0 };
        const day = dayOf(t);
        const nextDay = Math.ceil((Math.floor(t / DAY_MS) + 1) * DAY_MS / 1000) - Math.floor(t / 1000);

        // Shared (Valkey): the whole decision and the charge in one atomic call. Otherwise (no Valkey, or
        // an outage) this process's buckets, and the store's atomic day charge — committed only when the
        // buckets fit too, so a refused run takes nothing from either leg.
        let states = shared && !shared.down ? await shared.charge(charges, day, t, !!opt.report) : null;
        if (!states) {
            const levels = charges.map((c) => level(c.id, c.lim, t));
            const minuteOk = charges.map((c, i) => levels[i] >= c.need);
            const allMinute = minuteOk.every(Boolean);
            const withDay = charges.filter((c) => c.lim.perDay > 0);
            const d = withDay.length
                ? await o.store.dayCharge(day, withDay.map((c) => ({ key: c.key, cls: quotaClass, n: cost, limit: c.lim.perDay })), { commit: allMinute, force: !!opt.report })
                : { ok: true, used: [] };
            const usedOf = new Map(withDay.map((c, i) => [c, d.used[i] || 0]));
            states = charges.map((c, i) => {
                const used = usedOf.get(c) || 0;
                return { tokens: levels[i], used, minuteOk: minuteOk[i], dayOk: !(c.lim.perDay > 0) || used + cost <= c.lim.perDay };
            });
            if ((allMinute && d.ok) || opt.report) {
                for (const c of charges) spendLocal(c.id, c.lim, c.need, t);
            }
        }

        let ok = true, retryAfter = 0, binding = null, scope = null;
        const views = charges.map((c, i) => {
            const { lim, need } = c;
            const { tokens, used, minuteOk, dayOk } = states[i];
            const rate = lim.perMinute / 60_000;
            if (!minuteOk) {
                ok = false;
                const wait = Math.ceil((need - tokens) / rate / 1000);
                if (wait > retryAfter) { retryAfter = wait; binding = 'minute'; scope = c.scope; }
            }
            if (!dayOk) {
                ok = false;
                if (nextDay > retryAfter) { retryAfter = nextDay; binding = 'day'; scope = c.scope; }
            }
            const after = Math.max(0, tokens - need);
            return {
                minute: { limit: lim.burst, remaining: Math.floor(after), reset: Math.ceil((lim.burst - after) / rate / 1000) },
                day: lim.perDay > 0 ? { limit: lim.perDay, remaining: Math.max(0, Math.floor(lim.perDay - used - cost)), reset: nextDay } : null,
            };
        });
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

    /** Take `need` from this process's bucket, refilled to now (re-read: another run may have spent since). */
    function spendLocal(id, lim, need, t) {
        buckets.set(id, { tokens: Math.max(0, level(id, lim, t) - need), at: t });
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
