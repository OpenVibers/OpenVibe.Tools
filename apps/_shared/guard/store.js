'use strict';
// ═══════════════════════════════════════════════════════════════
// guard.db — the guard's own small SQLite file in each app's data directory (better-sqlite3 handle
// class passed in, like the job runtime). Three tables:
//
//   guard_salt   today's random salt (one row; the previous day's is deleted when the day turns). Every
//                address the guard counts or logs is HMAC-SHA256(salt, address) — never the address.
//                Kept on disk so a restart keeps today's counts; gone the next day, so older hashes
//                can no longer be tied to anything (pseudonymous, ADR-021).
//   guard_day    quota units used per UTC day, key and quota class (the day allowances survive restarts;
//                rows older than yesterday are pruned).
//   guard_abuse  the abuse log: time, hashed address, principal or user id, tool, reason, whether it was
//                refused (enforce) or only reported; repeats of the same row within a minute add to
//                `count`. Kept 30 days.
//
// Without a Database class (an app that has none) the same API is kept in memory.
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DAY_MS = 24 * 60 * 60 * 1000;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS guard_salt (
    day   TEXT PRIMARY KEY,
    salt  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS guard_day (
    day    TEXT NOT NULL,
    key    TEXT NOT NULL,
    class  TEXT NOT NULL,
    used   REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (day, key, class)
);
CREATE TABLE IF NOT EXISTS guard_abuse (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    at         INTEGER NOT NULL,
    minute     INTEGER NOT NULL,
    ip_hash    TEXT NOT NULL DEFAULT '',
    principal  TEXT NOT NULL DEFAULT '',
    tool       TEXT NOT NULL DEFAULT '',
    reason     TEXT NOT NULL,
    enforced   INTEGER NOT NULL,
    count      INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS guard_abuse_once ON guard_abuse(minute, ip_hash, principal, tool, reason, enforced);
CREATE INDEX IF NOT EXISTS guard_abuse_at ON guard_abuse(at);
`;

/**
 * @param {object} o
 * @param {Function} [o.Database]  require('better-sqlite3'); omitted → in memory
 * @param {string} [o.dataDir]
 * @param {string} [o.file='guard.db']
 * @param {() => number} [o.now]
 */
function createGuardStore(o = {}) {
    const now = o.now || Date.now;
    if (!o.Database || !o.dataDir) return memoryStore(now);
    try { return sqliteStore(o, now); } catch (err) {
        // An unwritable data directory must not take the app down: quotas and the log stay in memory.
        (o.log || console).error(`[Guard] ${path.join(o.dataDir, o.file || 'guard.db')} cannot be opened (${err.message}); keeping guard state in memory`);
        return memoryStore(now);
    }
}

function sqliteStore(o, now) {
    fs.mkdirSync(o.dataDir, { recursive: true });
    const db = new o.Database(path.join(o.dataDir, o.file || 'guard.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    db.exec(SCHEMA);
    const st = {
        saltGet: db.prepare('SELECT salt FROM guard_salt WHERE day = ?'),
        saltPut: db.prepare('INSERT OR IGNORE INTO guard_salt (day, salt) VALUES (?, ?)'),
        saltDrop: db.prepare('DELETE FROM guard_salt WHERE day <> ?'),
        dayGet: db.prepare('SELECT used FROM guard_day WHERE day = ? AND key = ? AND class = ?'),
        dayAdd: db.prepare('INSERT INTO guard_day (day, key, class, used) VALUES (?, ?, ?, ?) ON CONFLICT(day, key, class) DO UPDATE SET used = used + excluded.used'),
        dayPrune: db.prepare('DELETE FROM guard_day WHERE day < ?'),
        abuse: db.prepare(`INSERT INTO guard_abuse (at, minute, ip_hash, principal, tool, reason, enforced) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(minute, ip_hash, principal, tool, reason, enforced) DO UPDATE SET count = count + 1, at = excluded.at`),
        abusePrune: db.prepare('DELETE FROM guard_abuse WHERE at < ?'),
        abuseAll: db.prepare('SELECT at, ip_hash, principal, tool, reason, enforced, count FROM guard_abuse ORDER BY id'),
    };
    const cache = new Map();    // `${day}|${key}|${cls}` → used (today only)
    let cacheDay = null;
    const saltTx = db.transaction((day) => {
        st.saltPut.run(day, crypto.randomBytes(32).toString('hex'));
        st.saltDrop.run(day);
        return st.saltGet.get(day).salt;
    });
    return {
        kind: 'sqlite',
        db,
        salt(day = dayOf(now())) {
            const row = st.saltGet.get(day);
            return row ? row.salt : saltTx(day);
        },
        dayUsed(day, key, cls) {
            if (cacheDay !== day) { cache.clear(); cacheDay = day; }
            const k = `${day}|${key}|${cls}`;
            if (!cache.has(k)) { const r = st.dayGet.get(day, key, cls); cache.set(k, r ? r.used : 0); }
            return cache.get(k);
        },
        dayAdd(day, key, cls, n) {
            if (!(n > 0)) return;
            const used = this.dayUsed(day, key, cls) + n;
            cache.set(`${day}|${key}|${cls}`, used);
            st.dayAdd.run(day, key, cls, n);
        },
        pruneDays(keepFromDay) { return st.dayPrune.run(keepFromDay).changes; },
        logAbuse(r) {
            const at = r.at || now();
            st.abuse.run(at, Math.floor(at / 60_000), r.ipHash || '', r.principal || '', r.tool || '', String(r.reason), r.enforced ? 1 : 0);
        },
        pruneAbuse(beforeMs) { return st.abusePrune.run(beforeMs).changes; },
        abuseRows() { return st.abuseAll.all(); },
        close() { try { db.close(); } catch { /* already closed */ } },
    };
}

function memoryStore(now) {
    let salt = null;
    const days = new Map();
    const abuse = [];
    return {
        kind: 'memory',
        db: null,
        salt(day = dayOf(now())) {
            if (!salt || salt.day !== day) salt = { day, salt: crypto.randomBytes(32).toString('hex') };
            return salt.salt;
        },
        dayUsed(day, key, cls) { return days.get(`${day}|${key}|${cls}`) || 0; },
        dayAdd(day, key, cls, n) { if (n > 0) days.set(`${day}|${key}|${cls}`, this.dayUsed(day, key, cls) + n); },
        pruneDays(keepFromDay) { let n = 0; for (const k of days.keys()) if (k.slice(0, 10) < keepFromDay) { days.delete(k); n++; } return n; },
        logAbuse(r) {
            const at = r.at || now();
            const row = { at, minute: Math.floor(at / 60_000), ip_hash: r.ipHash || '', principal: r.principal || '', tool: r.tool || '', reason: String(r.reason), enforced: r.enforced ? 1 : 0, count: 1 };
            const same = abuse.find(x => x.minute === row.minute && x.ip_hash === row.ip_hash && x.principal === row.principal && x.tool === row.tool && x.reason === row.reason && x.enforced === row.enforced);
            if (same) { same.count++; same.at = at; } else { abuse.push(row); if (abuse.length > 10000) abuse.shift(); }
        },
        pruneAbuse(beforeMs) { const n = abuse.length; for (let i = abuse.length - 1; i >= 0; i--) if (abuse[i].at < beforeMs) abuse.splice(i, 1); return n - abuse.length; },
        abuseRows() { return abuse.map(({ minute, ...r }) => r); },
        close() {},
    };
}

module.exports = { createGuardStore, dayOf, DAY_MS };
