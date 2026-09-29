'use strict';
// ═══════════════════════════════════════════════════════════════
// The guard's own state (plan T8, decision 4):
//
//   guard_abuse   PostgreSQL (migrations/0001_tools.sql): the 30-day audit trail, one row per
//                 minute/address/principal/tool/reason/enforced, `count` incremented on repeat. Every
//                 app writes it with its own `app`. Writes are off the request path (a failed write is
//                 logged, never thrown), and the process keeps a bounded in-memory tail for /metrics,
//                 the admin endpoint and the tests.
//   guard_salt    Valkey, key guard_salt:<day>, two-day TTL, SETNX race — all processes agree on the
//                 same HMAC salt without sharing a file. Memoised, loaded in the background (warm()).
//   guard_day     Valkey hash guard_day:<day>, field <key>|<class> → used, TTL past midnight UTC.
//                 A daily *throttle*: worthless a day later, so it belongs in Valkey, not PostgreSQL.
//
// Without a database or Valkey (tests, or a Valkey outage) every counter and the salt stay in this
// process, exactly what the guard did before: a throttle that never fails open for money or accounts
// and never fails every request.
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');

const DAY_MS = 24 * 60 * 60 * 1000;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const SALT_TTL_S = 2 * DAY_MS / 1000;
const MAX_ABUSE = 10000;

/** Seconds until just after the next UTC midnight (a day counter's TTL). */
function dayTtl(t) { return Math.ceil((Math.floor(t / DAY_MS) + 1) * DAY_MS / 1000) - Math.floor(t / 1000) + 3600; }
/** The guard_day hash of one UTC day, and one allowance's field in it (quota.js charges the same ones). */
const dayKey = (valkey, day) => valkey.key('guard_day', day);
const dayField = (key, cls) => `${key}|${cls}`;

// Check every allowance in one day hash and, when they all fit (or `force`, report mode), add to each:
// all or nothing, atomically. KEYS[1] the day hash. ARGV: ttl (s), commit (1: charge when it fits,
// 0: only look), force (1: charge even when it does not fit), then per allowance: field, n, limit
// (0 = none). Returns "<1|0>:<used before, comma-separated>".
const DAY_CHARGE = `
local ttl = tonumber(ARGV[1])
local commit = ARGV[2] == '1'
local force = ARGV[3] == '1'
local m = (#ARGV - 3) / 3
local ok = true
local used = {}
for i = 1, m do
  local b = 3 + (i - 1) * 3
  local u = tonumber(redis.call('HGET', KEYS[1], ARGV[b + 1]) or '0')
  used[i] = tostring(u)
  local lim = tonumber(ARGV[b + 3])
  if lim > 0 and u + tonumber(ARGV[b + 2]) > lim then ok = false end
end
if (ok and commit) or force then
  for i = 1, m do
    local b = 3 + (i - 1) * 3
    if tonumber(ARGV[b + 2]) > 0 then redis.call('HINCRBYFLOAT', KEYS[1], ARGV[b + 1], ARGV[b + 2]) end
  end
  redis.call('EXPIRE', KEYS[1], ttl)
end
return (ok and '1' or '0') .. ':' .. table.concat(used, ',')`;

/**
 * @param {object} o
 * @param {object} [o.db]        openvibe-sdk/db handle (guard_abuse); absent → process-only
 * @param {object} [o.valkey]    openvibe-sdk/valkey connection; absent → counters and salt in-process
 * @param {string} [o.app]       the owning app, written in every guard_abuse row
 * @param {() => number} [o.now]
 * @param {object} [o.log]
 */
function createGuardStore(o = {}) {
    const now = o.now || Date.now;
    const log = o.log || console;
    const app = o.app || '';
    const db = o.db || null;
    const valkey = o.valkey || null;
    const salts = new Map();     // day → salt
    const days = new Map();      // `${day}|${key}|${cls}` → used (process view and fallback)
    const abuse = [];            // this process's bounded tail of the audit log
    let cacheDay = null;
    let saltUp = !!valkey;       // flipped off for the process on a Valkey error
    let dayUp = !!valkey;

    // ── guard_salt (Valkey) ──────────────────────────────────
    function salt(day = dayOf(now())) {
        const hit = salts.get(day);
        if (hit) return hit;
        const local = crypto.randomBytes(32).toString('hex');   // used until Valkey answers
        salts.set(day, local);
        if (saltUp) void loadSalt(day);
        return local;
    }
    async function loadSalt(day) {
        try {
            const key = valkey.key('guard_salt', day);
            let v = await valkey.client.get(key);
            if (!v) {
                await valkey.client.set(key, crypto.randomBytes(32).toString('hex'), 'NX', 'EX', SALT_TTL_S);
                v = await valkey.client.get(key);
            }
            if (v) {
                salts.set(day, v);   // replaces the process-local stand-in: salt() answers the shared one from now on
                for (const k of salts.keys()) if (k !== day) salts.delete(k);
            }
        } catch (err) {
            saltUp = false;
            log.warn(`[Guard] ${app}: Valkey salt unavailable (${err.message}); this process keeps its own`);
        }
    }
    /** Load (or create) today's shared salt; called once at boot. */
    async function warm() { if (valkey) await loadSalt(dayOf(now())); }

    // ── guard_day (Valkey) ───────────────────────────────────
    // One run charges one or more day allowances (a session and its address) all or nothing, and the
    // check and the increment are one Lua call: two requests can never both see room for the last unit.
    function dayCharge(day, entries, opt = {}) {
        if (cacheDay !== day) { days.clear(); cacheDay = day; }
        if (dayUp) {
            return valkeyDayCharge(day, entries, opt).catch((err) => {
                dayUp = false;
                log.warn(`[Guard] ${app}: Valkey day counters unavailable (${err.message}); counting in this process`);
                return localDayCharge(day, entries, opt);
            });
        }
        return Promise.resolve(localDayCharge(day, entries, opt));
    }
    /** In-process: synchronous, so nothing interleaves between the check and the increment. */
    function localDayCharge(day, entries, { commit = true, force = false } = {}) {
        const used = entries.map((e) => days.get(`${day}|${e.key}|${e.cls}`) || 0);
        const ok = entries.every((e, i) => !(e.limit > 0) || used[i] + e.n <= e.limit);
        if ((ok && commit) || force) {
            entries.forEach((e, i) => { if (e.n > 0) days.set(`${day}|${e.key}|${e.cls}`, used[i] + e.n); });
        }
        return { ok, used };
    }
    async function valkeyDayCharge(day, entries, { commit = true, force = false } = {}) {
        const c = valkey.client;
        if (typeof c.ovGuardDayCharge !== 'function') c.defineCommand('ovGuardDayCharge', { lua: DAY_CHARGE });
        const args = [String(dayTtl(now())), commit ? '1' : '0', force ? '1' : '0'];
        for (const e of entries) args.push(dayField(e.key, e.cls), String(e.n), String(e.limit > 0 ? e.limit : 0));
        const [ok, list] = String(await c.ovGuardDayCharge(1, dayKey(valkey, day), ...args)).split(':');
        const used = list ? list.split(',').map(Number) : [];
        entries.forEach((e, i) => days.set(`${day}|${e.key}|${e.cls}`, used[i] + ((ok === '1' && commit) || force ? e.n : 0)));
        return { ok: ok === '1', used };
    }

    // ── guard_abuse (PostgreSQL) ─────────────────────────────
    function logAbuse(r) {
        const at = r.at || now();
        const row = { at, minute: Math.floor(at / 60_000), ip_hash: r.ipHash || '', principal: r.principal || '', tool: r.tool || '', reason: String(r.reason), enforced: r.enforced ? 1 : 0, count: 1 };
        const same = abuse.find((x) => x.minute === row.minute && x.ip_hash === row.ip_hash && x.principal === row.principal && x.tool === row.tool && x.reason === row.reason && x.enforced === row.enforced);
        if (same) { same.count++; same.at = at; } else { abuse.push(row); if (abuse.length > MAX_ABUSE) abuse.shift(); }
        if (db) void insertAbuse(row).catch((err) => log.error(`[Guard] ${app}: abuse log write failed: ${err.message}`));
    }
    async function insertAbuse(row) {
        await db.query(
            `INSERT INTO guard_abuse (app, at, minute, ip_hash, principal, tool, reason, enforced) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (app, minute, ip_hash, principal, tool, reason, enforced) DO UPDATE SET count = guard_abuse.count + 1, at = excluded.at`,
            [app, row.at, row.minute, row.ip_hash, row.principal, row.tool, row.reason, row.enforced]);
    }
    /** This process's tail of the log (sync: tests and the debug endpoint). */
    function abuseRows() { return abuse.map(({ minute, ...r }) => r); }

    async function pruneAbuse(beforeMs) {
        for (let i = abuse.length - 1; i >= 0; i--) if (abuse[i].at < beforeMs) abuse.splice(i, 1);
        if (!db) return 0;
        const n = await db.exec('DELETE FROM guard_abuse WHERE app = $1 AND at < $2', [app, beforeMs]);   // this app's rows only: the table is shared
        return n || 0;
    }
    // guard_day rows live in Valkey and expire on their own.
    async function pruneDays() { return 0; }

    async function close() { /* the app owns db and valkey */ }

    return { kind: db ? 'postgres' : 'memory', app, db, valkey, salt, warm, dayCharge, logAbuse, abuseRows, pruneAbuse, pruneDays, close };
}

module.exports = { createGuardStore, dayOf, dayTtl, dayKey, dayField, DAY_MS };
