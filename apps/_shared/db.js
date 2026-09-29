'use strict';
// ═══════════════════════════════════════════════════════════════
// The one `tools` database (plan T8, decisions 3 and 6): all eight apps serve from a single
// PostgreSQL database, DATABASE_URL through PgBouncer in production. Migrations live in the
// repository's migrations/ and run as the owner (DATABASE_DIRECT_URL), or on the embedded handle in
// development. Without a DATABASE_URL outside production an embedded PGlite database serves the app,
// so what the tests run is what production runs (ADR-035).
//
// Like the rest of apps/_shared there are no dependencies of its own: the app passes its
// require('openvibe-sdk/db').createDb and require('openvibe-sdk/valkey').createValkey.
//
// openToolsDb returns { db, ready }: `db` is usable at once (its statements queue), `ready` resolves
// when the schema is applied — mount it in /api/ready and never block the boot on it.
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const MIGRATIONS = path.resolve(__dirname, '..', '..', 'migrations');

/**
 * Await `ready` before every statement, so a caller need not hold the schema promise: the guard writes
 * guard_abuse on the first refusal, and a request must never race the migrations. `tx`/`prepare` are
 * gated too; the rest of the handle (sql, stats, store, _adapter) passes through.
 */
function gate(db, ready) {
    const wait = () => ready;
    const wrapStmt = (s) => ({
        get: async (...a) => { await wait(); return s.get(...a); },
        all: async (...a) => { await wait(); return s.all(...a); },
        run: async (...a) => { await wait(); return s.run(...a); },
    });
    const out = Object.create(db);
    for (const m of ['query', 'many', 'maybe', 'one', 'value', 'exec']) out[m] = async (...a) => { await wait(); return db[m](...a); };
    out.tx = async (fn, opts) => { await wait(); return db.tx(fn, opts); };
    out.prepare = (text) => wrapStmt(db.prepare(text));
    out.ready = async () => { await wait(); return db.ready(); };
    out.afterCommit = (fn) => db.afterCommit(fn);
    out.inTransaction = () => db.inTransaction();
    out.detached = (fn) => db.detached(fn);
    out.close = () => db.close();
    return out;
}

/**
 * @param {object} o
 * @param {Function} o.createDb     require('openvibe-sdk/db').createDb
 * @param {string} [o.service]      application_name and metric label ('tools-img', 'tools-gateway', …)
 * @param {object} [o.log]
 * @param {object} [o.registry]     openvibe-shared/metrics registry (db_query_seconds, pool gauges)
 * @param {string} [o.pgliteDir]    development database directory (default data/pglite/<service>)
 * @param {string} [o.migrationsDir]
 */
function openToolsDb({ createDb, service = 'tools', log = console, registry, pgliteDir, migrationsDir = MIGRATIONS } = {}) {
    if (typeof createDb !== 'function') throw new TypeError('openToolsDb needs createDb (require(\'openvibe-sdk/db\').createDb)');
    const url = String(process.env.DATABASE_URL || '').trim();
    if (!url) {
        if (String(process.env.NODE_ENV || '') === 'production') throw new Error('DATABASE_URL is not set: Tools serves from PostgreSQL (plan T8)');
        // A directory keeps development data across restarts; without one (tests) the database is in memory,
        // so every run starts from the empty, migrated schema.
        const dir = pgliteDir || process.env.TOOLS_PGLITE_DIR || '';
        if (dir) fs.mkdirSync(dir, { recursive: true });
        const db = createDb({ pglite: dir || true, service, log, registry });
        log.warn(`[DB] ${service}: DATABASE_URL unset, ${dir ? `embedded PGlite database in ${dir}` : 'in-memory PGlite database'} (development only)`);
        const ready = db.migrate({ dir: migrationsDir, log });
        return { db: gate(db, ready), ready };
    }
    const db = createDb({ url, service, log, registry });
    const direct = String(process.env.DATABASE_DIRECT_URL || '').trim();
    let ready = Promise.resolve();
    if (direct) {
        const owner = createDb({ url: direct, service: `${service}-migrate`, max: 1, log });
        ready = owner.migrate({ dir: migrationsDir, log }).finally(() => owner.close().catch(() => {}));
    }
    return { db: gate(db, ready), ready };
}

/**
 * The shared Valkey connection (plan T8, decision 4), confined to `ov:tools:*`. Without VALKEY_URL it
 * is null and the guard keeps its counters and salt in this process, as it did before (ADR-007 rule 4:
 * Valkey is a throttle, never authoritative).
 *
 * @param {object} o
 * @param {Function} o.createValkey  require('openvibe-sdk/valkey').createValkey
 */
function openToolsValkey({ createValkey, log = console, prefix = process.env.VALKEY_PREFIX || 'ov:tools:' } = {}) {
    if (typeof createValkey !== 'function') return null;
    return createValkey({ url: process.env.VALKEY_URL, prefix, log });
}

module.exports = { openToolsDb, openToolsValkey, MIGRATIONS };
