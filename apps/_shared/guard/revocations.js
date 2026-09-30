'use strict';
// Sign-out everywhere for every Tools app (roadmap WS-B task 4; Contracts 0.39.0
// network.user.token_valid_after). The cutoff lives in PostgreSQL (token_revocations, plan T8
// decision 4): the gateway writes it through openvibe-sdk/auth createPgRevocationStore
// (apps/gateway/server/revocation-events.js), and every app's guard reads it here.
//
// A read happens on the request path (isRevoked), so it stays synchronous against a short in-memory
// cache loaded from PostgreSQL and refreshed at most every `ttlMs`. With a Valkey connection the
// refresh is driven by a shared version counter the writer bumps, so a revocation reaches every
// process as soon as its next refresh (or the ttl elapses). Without a database (tests, or a database
// outage) nothing is revoked, exactly as before the shared store existed — never a hard failure on a
// request.
//
//   const cutoffs = createCutoffReader({ db, valkey });
//   cutoffs.isRevoked(claims)   → boolean (from the cache)
//   await cutoffs.refresh()     → reloads from PostgreSQL now

const DEFAULT_TABLE = 'token_revocations';

/**
 * @param {object} o
 * @param {object} [o.db]            openvibe-sdk/db handle (token_revocations); absent → nothing revoked
 * @param {object} [o.valkey]        openvibe-sdk/valkey connection; a shared refresh version
 * @param {string} [o.table='token_revocations']
 * @param {number} [o.ttlMs=15_000]  how long a loaded cache is trusted before the next read refreshes it
 * @param {() => number} [o.now]
 * @param {object} [o.log]
 */
function createCutoffReader(o = {}) {
    const db = o.db || null;
    const valkey = o.valkey || null;
    const table = o.table || DEFAULT_TABLE;
    const ttlMs = o.ttlMs == null ? 15_000 : o.ttlMs;
    const now = o.now || Date.now;
    const log = o.log || console;
    const cache = new Map();     // subject → cutoff ms
    let loadedAt = 0;
    let version = null;
    let inFlight = null;

    function cutoffFor(subject) {
        if (!subject) return 0;
        if (db && now() - loadedAt > ttlMs) void refresh();   // background; this read uses the cache
        return cache.get(subject) || 0;
    }
    function isRevoked(claims) {
        if (!claims || typeof claims.iat !== 'number' || typeof claims.subject_id !== 'string') return false;
        return claims.iat * 1000 < cutoffFor(claims.subject_id);
    }

    const versionKey = () => valkey.key('token_revocations_version');
    async function refresh() {
        if (!db) return 0;
        if (inFlight) return inFlight;
        inFlight = (async () => {
            try {
                // With Valkey, an unchanged version means no writer moved a cutoff: the cache still holds.
                if (valkey) {
                    const v = await valkey.client.get(versionKey());
                    if (v && v === version && loadedAt) { loadedAt = now(); return cache.size; }
                    version = v || version;
                }
                const rows = await db.prepare(`SELECT subject_id, valid_after_ms FROM ${table}`).all();
                cache.clear();
                for (const r of rows) cache.set(r.subject_id, Number(r.valid_after_ms) || 0);
                loadedAt = now();
                return cache.size;
            } catch (err) {
                log.warn && log.warn(`[Guard] revocations read failed: ${err.message}; keeping the last cutoffs`);
                loadedAt = now();
                return cache.size;
            } finally { inFlight = null; }
        })();
        return inFlight;
    }
    /** Load the cutoffs once at boot (the gateway's writer bumps the shared version on every write). */
    async function warm() { return refresh(); }

    return { isRevoked, cutoffFor, refresh, warm, size: () => cache.size };
}

module.exports = { createCutoffReader, DEFAULT_TABLE };
