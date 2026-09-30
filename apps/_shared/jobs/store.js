'use strict';
// ═══════════════════════════════════════════════════════════════
// Job store — the one `tools` PostgreSQL database (plan T8, decision 3), through openvibe-sdk/db.
//
// Three tables, all created by migrations/0001_tools.sql (not here):
//   tool_jobs            one row per job; the durable truth a restart recovers from
//   tool_job_events      the ordered event log per job; its per-job identity seq is the SSE event id,
//                        so a reconnect with Last-Event-ID replays exactly what was missed
//   tool_job_references  who still points at a job's result (a paste, a project, …); a referenced
//                        job never expires, so its files and Media objects are not pruned
//
// Eight apps share the one database, so every row carries `app` and every read that could see another
// app's rows filters on it. All statements are async (openvibe-sdk/db) and join an ambient transaction
// when one is open, so a store call inside db.tx(fn) commits with it.
// ═══════════════════════════════════════════════════════════════

const TERMINAL = ['succeeded', 'failed', 'cancelled'];
const STATES = ['queued', 'running', ...TERMINAL];

const parse = (s, fallback) => { if (s == null) return fallback; try { return JSON.parse(s); } catch { return fallback; } };

/**
 * @param {object} db   openvibe-sdk/db handle (or the gated one apps/_shared/db.js returns)
 * @param {object} o
 * @param {string} o.app  the owning app ('img' | 'audio' | 'docs' | …): every row this store writes or reads
 */
function createStore(db, { app } = {}) {
    if (!db || typeof db.prepare !== 'function') throw new TypeError('createStore needs an openvibe-sdk/db handle');
    if (!app) throw new TypeError('createStore needs app');
    const q = {
        insert: db.prepare(`INSERT INTO tool_jobs (id, app, type, type_version, owner, state, input_json, files_json, idempotency_key, request_hash, max_attempts, ttl_ms, created_at, updated_at, env, retry_of, ip_key, tool, project_id, trace_id)
            VALUES (@id, @app, @type, @type_version, @owner, 'queued', @input_json, @files_json, @idempotency_key, @request_hash, @max_attempts, @ttl_ms, @now, @now, @env, @retry_of, @ip_key, @tool, @project_id, @trace_id)`),
        markRetried: db.prepare("UPDATE tool_jobs SET retried_by = @next, updated_at = @now WHERE id = @id AND app = @app AND state = 'failed' AND retried_by IS NULL"),
        get: db.prepare('SELECT * FROM tool_jobs WHERE id = ? AND app = ?'),
        byIdem: db.prepare('SELECT * FROM tool_jobs WHERE app = @app AND owner = @owner AND idempotency_key = @idempotency_key'),
        // A result file stored in Media, by its media_id (a run's { media_id } reference); the owner's only.
        byResultMedia: db.prepare("SELECT * FROM tool_jobs WHERE app = @app AND owner = @owner AND state = 'succeeded' AND result_json ILIKE @like ORDER BY id DESC LIMIT 5"),
        nextQueued: db.prepare("SELECT * FROM tool_jobs WHERE app = @app AND state = 'queued' ORDER BY id LIMIT @limit"),
        claim: db.prepare("UPDATE tool_jobs SET state = 'running', attempts = attempts + 1, started_at = @now, updated_at = @now, progress = NULL, progress_message = NULL WHERE id = @id AND app = @app AND state = 'queued'"),
        running: db.prepare("SELECT * FROM tool_jobs WHERE app = @app AND state = 'running'"),
        activeForOwner: db.prepare("SELECT COUNT(*) AS n FROM tool_jobs WHERE app = @app AND owner = @owner AND state IN ('queued','running')"),
        activeForIp: db.prepare("SELECT COUNT(*) AS n FROM tool_jobs WHERE app = @app AND ip_key = @ip_key AND state IN ('queued','running')"),
        progress: db.prepare('UPDATE tool_jobs SET progress = @progress, progress_message = @message, updated_at = @now WHERE id = @id AND app = @app AND state = \'running\''),
        requestCancel: db.prepare("UPDATE tool_jobs SET cancel_requested = 1, updated_at = @now WHERE id = @id AND app = @app AND state IN ('queued','running')"),
        requeue: db.prepare("UPDATE tool_jobs SET state = 'queued', started_at = NULL, progress = NULL, progress_message = NULL, updated_at = @now WHERE id = @id AND app = @app AND state = 'running'"),
        finish: db.prepare(`UPDATE tool_jobs SET state = @state, result_json = @result_json, error_json = @error_json, retryable = @retryable,
            progress = CASE WHEN @state = 'succeeded' THEN 100 ELSE progress END, progress_message = NULL,
            finished_at = @now, updated_at = @now, expires_at = @now + ttl_ms::bigint WHERE id = @id AND app = @app AND state IN ('queued','running')`),
        setFiles: db.prepare('UPDATE tool_jobs SET files_json = @files_json, updated_at = @now WHERE id = @id AND app = @app'),
        // tool_job_events and tool_job_references carry no `app` of their own: every statement on them
        // goes through this app's tool_jobs row, so an id from another app reads and changes nothing.
        event: db.prepare(`INSERT INTO tool_job_events (job_id, event, data, at)
            SELECT CAST(@job_id AS text), CAST(@event AS text), CAST(@data AS text), CAST(@at AS bigint) WHERE EXISTS (SELECT 1 FROM tool_jobs WHERE id = @job_id AND app = @app) RETURNING seq`),
        eventsAfter: db.prepare(`SELECT e.seq, e.event, e.data, e.at FROM tool_job_events e JOIN tool_jobs j ON j.id = e.job_id
            WHERE e.job_id = @job_id AND j.app = @app AND e.seq > @seq ORDER BY e.seq`),
        lastSeq: db.prepare('SELECT MAX(e.seq) AS seq FROM tool_job_events e JOIN tool_jobs j ON j.id = e.job_id WHERE e.job_id = @job_id AND j.app = @app'),
        // A job something still references is never expired (see tool_job_references).
        expired: db.prepare(`SELECT * FROM tool_jobs j WHERE app = @app AND expires_at IS NOT NULL AND expires_at <= @now
            AND NOT EXISTS (SELECT 1 FROM tool_job_references r WHERE r.job_id = j.id) LIMIT 500`),
        deferExpiry: db.prepare('UPDATE tool_jobs SET expires_at = @until, updated_at = @now WHERE id = @id AND app = @app'),
        del: db.prepare('DELETE FROM tool_jobs WHERE id = @id AND app = @app'),
        delEvents: db.prepare('DELETE FROM tool_job_events WHERE job_id = @id AND EXISTS (SELECT 1 FROM tool_jobs WHERE id = @id AND app = @app)'),
        delRefs: db.prepare('DELETE FROM tool_job_references WHERE job_id = @id AND EXISTS (SELECT 1 FROM tool_jobs WHERE id = @id AND app = @app)'),
        addRef: db.prepare(`INSERT INTO tool_job_references (job_id, ref, created_at)
            SELECT CAST(@id AS text), CAST(@ref AS text), CAST(@now AS bigint) WHERE EXISTS (SELECT 1 FROM tool_jobs WHERE id = @id AND app = @app) ON CONFLICT DO NOTHING`),
        dropRef: db.prepare('DELETE FROM tool_job_references WHERE job_id = @id AND ref = @ref AND EXISTS (SELECT 1 FROM tool_jobs WHERE id = @id AND app = @app)'),
        refs: db.prepare(`SELECT r.ref, r.created_at FROM tool_job_references r JOIN tool_jobs j ON j.id = r.job_id
            WHERE r.job_id = @id AND j.app = @app ORDER BY r.created_at, r.ref`),
        refCount: db.prepare('SELECT COUNT(*) AS n FROM tool_job_references r JOIN tool_jobs j ON j.id = r.job_id WHERE r.job_id = @id AND j.app = @app'),
        // After the last reference goes, the result is kept at least one more ttl.
        releaseExpiry: db.prepare('UPDATE tool_jobs SET expires_at = GREATEST(COALESCE(expires_at, 0), @now + ttl_ms::bigint), updated_at = @now WHERE id = @id AND app = @app AND finished_at IS NOT NULL'),
        counts: db.prepare('SELECT state, COUNT(*) AS n FROM tool_jobs WHERE app = @app GROUP BY state'),
    };

    /** Append one event; returns its seq (the SSE id). */
    async function appendEvent(jobId, event, data, now = Date.now()) {
        const r = await q.event.run({ app, job_id: jobId, event, data: JSON.stringify(data), at: now });
        return r.changes === 1 ? Number(r.lastInsertRowid) : 0;   // 0: no such job in this app
    }

    return {
        db,
        app,
        TERMINAL, STATES,
        async insert(row) { await q.insert.run({ app, retry_of: null, ip_key: null, tool: null, project_id: null, trace_id: null, ...row }); },
        byResultMedia: async (owner, mediaId) => q.byResultMedia.all({ app, owner, like: `%"media_id":"${String(mediaId).replace(/[%"\\]/g, '')}"%` }),
        markRetried: async (id, next, now = Date.now()) => (await q.markRetried.run({ app, id, next, now })).changes === 1,
        get: async (id) => (await q.get.get(id, app)) || null,
        byIdempotencyKey: async (owner, key) => (await q.byIdem.get({ app, owner, idempotency_key: key })) || null,
        nextQueued: (limit) => q.nextQueued.all({ app, limit }),
        claim: async (id, now = Date.now()) => (await q.claim.run({ app, id, now })).changes === 1,
        running: () => q.running.all({ app }),
        activeForOwner: async (owner) => (await q.activeForOwner.get({ app, owner })).n,
        activeForIp: async (ipKey) => (ipKey ? (await q.activeForIp.get({ app, ip_key: ipKey })).n : 0),
        setProgress: async (id, progress, message, now = Date.now()) => (await q.progress.run({ app, id, progress, message, now })).changes === 1,
        requestCancel: async (id, now = Date.now()) => (await q.requestCancel.run({ app, id, now })).changes === 1,
        requeue: async (id, now = Date.now()) => (await q.requeue.run({ app, id, now })).changes === 1,
        finish: async (id, { state, result = null, error = null, retryable = false }, now = Date.now()) => (await q.finish.run({
            app, id, state, now, retryable: retryable ? 1 : 0,
            result_json: result == null ? null : JSON.stringify(result),
            error_json: error == null ? null : JSON.stringify(error),
        })).changes === 1,
        setFiles: (id, files, now = Date.now()) => q.setFiles.run({ app, id, files_json: JSON.stringify(files), now }),
        appendEvent,
        eventsAfter: async (jobId, seq) => (await q.eventsAfter.all({ app, job_id: jobId, seq })).map(e => ({ seq: Number(e.seq), event: e.event, data: parse(e.data, {}), at: Number(e.at) })),
        lastSeq: async (jobId) => Number((await q.lastSeq.get({ app, job_id: jobId })).seq) || 0,
        expired: (now = Date.now()) => q.expired.all({ app, now }),
        deferExpiry: (id, until, now = Date.now()) => q.deferExpiry.run({ app, id, until, now }),
        remove: (id) => db.tx(async () => { await q.delEvents.run({ app, id }); await q.delRefs.run({ app, id }); await q.del.run({ app, id }); }),
        /** → true when the reference is new. */
        addReference: async (id, ref, now = Date.now()) => (await q.addRef.run({ app, id, ref, now })).changes === 1,
        /** → true when it existed; dropping the last one restarts the job's expiry clock. */
        dropReference: (id, ref, now = Date.now()) => db.tx(async () => {
            const gone = (await q.dropRef.run({ app, id, ref })).changes === 1;
            if (gone && Number((await q.refCount.get({ app, id })).n) === 0) await q.releaseExpiry.run({ app, id, now });
            return gone;
        }),
        references: (id) => q.refs.all({ app, id }),
        referenceCount: async (id) => Number((await q.refCount.get({ app, id })).n),
        counts: async () => { const out = Object.fromEntries(STATES.map(s => [s, 0])); for (const r of await q.counts.all({ app })) out[r.state] = Number(r.n); return out; },
        tx: (fn) => db.tx(fn),
        parse,
    };
}

module.exports = { createStore, TERMINAL, STATES };
