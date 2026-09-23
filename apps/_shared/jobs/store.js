'use strict';
// ═══════════════════════════════════════════════════════════════
// Job store — the satellite's own SQLite (better-sqlite3 handle passed in).
//
// Three tables, created on first use (idempotent):
//   tool_jobs            one row per job; the durable truth a restart recovers from
//   tool_job_events      the ordered event log per job; its AUTOINCREMENT seq is the SSE event id,
//                        so a reconnect with Last-Event-ID replays exactly what was missed
//   tool_job_references  who still points at a job's result (a paste, a project, …); a referenced
//                        job never expires, so its files and Media objects are not pruned
// ═══════════════════════════════════════════════════════════════

const TERMINAL = ['succeeded', 'failed', 'cancelled'];
const STATES = ['queued', 'running', ...TERMINAL];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tool_jobs (
    id               TEXT PRIMARY KEY,
    type             TEXT NOT NULL,
    type_version     INTEGER NOT NULL DEFAULT 1,
    owner            TEXT NOT NULL,
    state            TEXT NOT NULL CHECK (state IN ('queued','running','succeeded','failed','cancelled')),
    progress         REAL,
    progress_message TEXT,
    input_json       TEXT NOT NULL DEFAULT '{}',
    files_json       TEXT NOT NULL DEFAULT '[]',
    result_json      TEXT,
    error_json       TEXT,
    retryable        INTEGER NOT NULL DEFAULT 0,
    idempotency_key  TEXT,
    request_hash     TEXT,
    attempts         INTEGER NOT NULL DEFAULT 0,
    max_attempts     INTEGER NOT NULL DEFAULT 1,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    ttl_ms           INTEGER NOT NULL DEFAULT 3600000,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    started_at       INTEGER,
    finished_at      INTEGER,
    expires_at       INTEGER,
    env              TEXT NOT NULL DEFAULT 'production' CHECK (env IN ('production','sandbox'))
);
CREATE UNIQUE INDEX IF NOT EXISTS tool_jobs_idem ON tool_jobs(owner, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS tool_jobs_state ON tool_jobs(state, id);
CREATE INDEX IF NOT EXISTS tool_jobs_expiry ON tool_jobs(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS tool_jobs_owner ON tool_jobs(owner, state);
CREATE TABLE IF NOT EXISTS tool_job_events (
    seq     INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id  TEXT NOT NULL,
    event   TEXT NOT NULL,
    data    TEXT NOT NULL,
    at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tool_job_events_job ON tool_job_events(job_id, seq);
CREATE TABLE IF NOT EXISTS tool_job_references (
    job_id     TEXT NOT NULL,
    ref        TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (job_id, ref)
);
`;

// Columns added after the first release, each added when missing (idempotent).
const ADDED_COLUMNS = [
    ['env', "TEXT NOT NULL DEFAULT 'production' CHECK (env IN ('production','sandbox'))"],   // developer-app sandboxes
    ['retry_of', 'TEXT'],       // the failed job this one retries
    ['retried_by', 'TEXT'],     // set on a failed job once it has been retried: the retry's id
];

const parse = (s, fallback) => { if (s == null) return fallback; try { return JSON.parse(s); } catch { return fallback; } };

function createStore(db) {
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.exec(SCHEMA);
    const have = new Set(db.prepare('PRAGMA table_info(tool_jobs)').all().map((c) => c.name));
    for (const [name, decl] of ADDED_COLUMNS) if (!have.has(name)) db.exec(`ALTER TABLE tool_jobs ADD COLUMN ${name} ${decl}`);

    const q = {
        insert: db.prepare(`INSERT INTO tool_jobs (id, type, type_version, owner, state, input_json, files_json, idempotency_key, request_hash, max_attempts, ttl_ms, created_at, updated_at, env, retry_of)
            VALUES (@id, @type, @type_version, @owner, 'queued', @input_json, @files_json, @idempotency_key, @request_hash, @max_attempts, @ttl_ms, @now, @now, @env, @retry_of)`),
        markRetried: db.prepare("UPDATE tool_jobs SET retried_by = @next, updated_at = @now WHERE id = @id AND state = 'failed' AND retried_by IS NULL"),
        get: db.prepare('SELECT * FROM tool_jobs WHERE id = ?'),
        byIdem: db.prepare('SELECT * FROM tool_jobs WHERE owner = ? AND idempotency_key = ?'),
        nextQueued: db.prepare("SELECT * FROM tool_jobs WHERE state = 'queued' ORDER BY id LIMIT ?"),
        claim: db.prepare("UPDATE tool_jobs SET state = 'running', attempts = attempts + 1, started_at = @now, updated_at = @now, progress = NULL, progress_message = NULL WHERE id = @id AND state = 'queued'"),
        running: db.prepare("SELECT * FROM tool_jobs WHERE state = 'running'"),
        activeForOwner: db.prepare("SELECT COUNT(*) AS n FROM tool_jobs WHERE owner = ? AND state IN ('queued','running')"),
        progress: db.prepare('UPDATE tool_jobs SET progress = @progress, progress_message = @message, updated_at = @now WHERE id = @id AND state = \'running\''),
        requestCancel: db.prepare("UPDATE tool_jobs SET cancel_requested = 1, updated_at = @now WHERE id = @id AND state IN ('queued','running')"),
        requeue: db.prepare("UPDATE tool_jobs SET state = 'queued', started_at = NULL, progress = NULL, progress_message = NULL, updated_at = @now WHERE id = @id AND state = 'running'"),
        finish: db.prepare(`UPDATE tool_jobs SET state = @state, result_json = @result_json, error_json = @error_json, retryable = @retryable,
            progress = CASE WHEN @state = 'succeeded' THEN 100 ELSE progress END, progress_message = NULL,
            finished_at = @now, updated_at = @now, expires_at = @now + ttl_ms WHERE id = @id AND state IN ('queued','running')`),
        setFiles: db.prepare('UPDATE tool_jobs SET files_json = @files_json, updated_at = @now WHERE id = @id'),
        event: db.prepare('INSERT INTO tool_job_events (job_id, event, data, at) VALUES (?, ?, ?, ?)'),
        eventsAfter: db.prepare('SELECT seq, event, data, at FROM tool_job_events WHERE job_id = ? AND seq > ? ORDER BY seq'),
        lastSeq: db.prepare('SELECT MAX(seq) AS seq FROM tool_job_events WHERE job_id = ?'),
        // A job something still references is never expired (see tool_job_references).
        expired: db.prepare(`SELECT * FROM tool_jobs j WHERE expires_at IS NOT NULL AND expires_at <= ?
            AND NOT EXISTS (SELECT 1 FROM tool_job_references r WHERE r.job_id = j.id) LIMIT 500`),
        deferExpiry: db.prepare('UPDATE tool_jobs SET expires_at = @until, updated_at = @now WHERE id = @id'),
        del: db.prepare('DELETE FROM tool_jobs WHERE id = ?'),
        delEvents: db.prepare('DELETE FROM tool_job_events WHERE job_id = ?'),
        delRefs: db.prepare('DELETE FROM tool_job_references WHERE job_id = ?'),
        addRef: db.prepare('INSERT OR IGNORE INTO tool_job_references (job_id, ref, created_at) VALUES (?, ?, ?)'),
        dropRef: db.prepare('DELETE FROM tool_job_references WHERE job_id = ? AND ref = ?'),
        refs: db.prepare('SELECT ref, created_at FROM tool_job_references WHERE job_id = ? ORDER BY created_at, ref'),
        refCount: db.prepare('SELECT COUNT(*) AS n FROM tool_job_references WHERE job_id = ?'),
        // After the last reference goes, the result is kept at least one more ttl.
        releaseExpiry: db.prepare('UPDATE tool_jobs SET expires_at = MAX(COALESCE(expires_at, 0), @now + ttl_ms), updated_at = @now WHERE id = @id AND finished_at IS NOT NULL'),
        counts: db.prepare('SELECT state, COUNT(*) AS n FROM tool_jobs GROUP BY state'),
    };

    /** Append one event; returns its seq (the SSE id). */
    function appendEvent(jobId, event, data, now = Date.now()) {
        return Number(q.event.run(jobId, event, JSON.stringify(data), now).lastInsertRowid);
    }

    return {
        db,
        TERMINAL, STATES,
        insert(row) { q.insert.run({ retry_of: null, ...row }); },
        markRetried: (id, next, now = Date.now()) => q.markRetried.run({ id, next, now }).changes === 1,
        get: (id) => q.get.get(id) || null,
        byIdempotencyKey: (owner, key) => q.byIdem.get(owner, key) || null,
        nextQueued: (limit) => q.nextQueued.all(limit),
        claim: (id, now = Date.now()) => q.claim.run({ id, now }).changes === 1,
        running: () => q.running.all(),
        activeForOwner: (owner) => q.activeForOwner.get(owner).n,
        setProgress: (id, progress, message, now = Date.now()) => q.progress.run({ id, progress, message, now }).changes === 1,
        requestCancel: (id, now = Date.now()) => q.requestCancel.run({ id, now }).changes === 1,
        requeue: (id, now = Date.now()) => q.requeue.run({ id, now }).changes === 1,
        finish: (id, { state, result = null, error = null, retryable = false }, now = Date.now()) => q.finish.run({
            id, state, now, retryable: retryable ? 1 : 0,
            result_json: result == null ? null : JSON.stringify(result),
            error_json: error == null ? null : JSON.stringify(error),
        }).changes === 1,
        setFiles: (id, files, now = Date.now()) => q.setFiles.run({ id, files_json: JSON.stringify(files), now }),
        appendEvent,
        eventsAfter: (jobId, seq) => q.eventsAfter.all(jobId, seq).map(e => ({ seq: e.seq, event: e.event, data: parse(e.data, {}), at: e.at })),
        lastSeq: (jobId) => q.lastSeq.get(jobId).seq || 0,
        expired: (now = Date.now()) => q.expired.all(now),
        deferExpiry: (id, until, now = Date.now()) => q.deferExpiry.run({ id, until, now }),
        remove: db.transaction((id) => { q.delEvents.run(id); q.delRefs.run(id); q.del.run(id); }),
        /** → true when the reference is new. */
        addReference: (id, ref, now = Date.now()) => q.addRef.run(id, ref, now).changes === 1,
        /** → true when it existed; dropping the last one restarts the job's expiry clock. */
        dropReference: db.transaction((id, ref, now = Date.now()) => {
            const gone = q.dropRef.run(id, ref).changes === 1;
            if (gone && q.refCount.get(id).n === 0) q.releaseExpiry.run({ id, now });
            return gone;
        }),
        references: (id) => q.refs.all(id),
        referenceCount: (id) => q.refCount.get(id).n,
        counts() { const out = Object.fromEntries(STATES.map(s => [s, 0])); for (const r of q.counts.all()) out[r.state] = r.n; return out; },
        transaction: (fn) => db.transaction(fn),
        parse,
    };
}

module.exports = { createStore, TERMINAL, STATES };
