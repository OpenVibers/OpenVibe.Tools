'use strict';
// Sign-out everywhere for every Tools app (roadmap WS-B task 4; Contracts 0.39.0
// network.user.token_valid_after). The gateway receives the event and keeps each person's cutoff in
// one SQLite file on the host (apps/gateway/server/revocation-events.js); every app's guard reads it
// here and treats a token issued before the cutoff as nobody signed in (Network's rule:
// iat * 1000 < valid_after). Lookups are memoised briefly per subject, so a revocation reaches every
// app within `ttlMs`. Without better-sqlite3 or before the gateway has written the file, nothing is revoked.
const fs = require('fs');
const path = require('path');

// In the gateway's data directory: the one place its unit may write (ReadWritePaths); the other apps only read it.
const DEFAULT_FILE = path.resolve(__dirname, '..', '..', 'gateway', 'data', 'token-revocations.db');

function revocationsFile(env = process.env) { return env.TOOLS_REVOCATIONS_DB || DEFAULT_FILE; }

function createCutoffReader({ Database = null, file = revocationsFile(), ttlMs = 15_000, now = Date.now } = {}) {
    let stmt = null, lastTry = 0;
    const memo = new Map();
    function open() {
        if (stmt || !Database) return stmt;
        if (now() - lastTry < 10_000) return null;
        lastTry = now();
        try {
            if (!fs.existsSync(file)) return null;
            const db = new Database(file, { readonly: true, fileMustExist: true });
            db.pragma('busy_timeout = 1000');
            stmt = db.prepare('SELECT valid_after_ms FROM token_revocations WHERE subject_id = ?');
        } catch { stmt = null; }
        return stmt;
    }
    function cutoffFor(subject) {
        if (!subject) return 0;
        const hit = memo.get(subject);
        if (hit && now() - hit.at < ttlMs) return hit.ms;
        let ms = 0;
        const s = open();
        if (s) { try { const row = s.get(subject); ms = row ? Number(row.valid_after_ms) || 0 : 0; } catch { ms = hit ? hit.ms : 0; } }
        if (memo.size > 20000) memo.clear();
        memo.set(subject, { at: now(), ms });
        return ms;
    }
    function isRevoked(claims) {
        if (!claims || typeof claims.iat !== 'number' || typeof claims.subject_id !== 'string') return false;
        return claims.iat * 1000 < cutoffFor(claims.subject_id);
    }
    return { isRevoked, cutoffFor };
}

module.exports = { createCutoffReader, revocationsFile, DEFAULT_FILE };
