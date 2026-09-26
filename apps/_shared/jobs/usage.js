'use strict';
// ═══════════════════════════════════════════════════════════════
// Developer-project usage → OpenVibe.Events (roadmap WS-N task 4, ADR-014).
//
// A job submitted with a developer-app token carries its project (tool_jobs.project_id) and env. When
// such a job ends (succeeded or failed; a cancelled job is not counted), the transaction that records
// the end also counts it in `tool_job_usage`, per project, environment, capability, job type or tool
// (dimension) and UTC hour:
//
//   capability   tools.tool.run for a tool run (POST /api/v1/tools/:id/run; dimension: the tool id),
//                tools.job.create for POST /api/v1/jobs (dimension: the job type, img.process)
//   unit         jobs
//   quantity     jobs that ended in the hour; errors: the failed ones, by problem code, with the last ten
//                failures' job id, status and the trace id of the request that submitted the job
//
// Once an hour has closed (plus a minute), flush() writes each of its rollups to the satellite's
// outbox as tools.usage.recorded (openvibe-contracts common.usage-recorded@1: subject the project,
// visibility internal, priority low, actor service:tools) in the transaction that marks it sent; the
// outbox relay publishes it. A job that ends in an hour already sent (a clock step back) reopens it as
// revision + 1. Only counts leave: no owner, session, address, input, file name or output.
//
// Inert without an outbox (EVENTS_URL unset, like ./events.js): nothing is counted.
// ═══════════════════════════════════════════════════════════════

const HOUR_MS = 60 * 60 * 1000;
const GRACE_MS = 60 * 1000;
const KEEP_SENT_MS = 7 * 24 * HOUR_MS;
const MAX_CODES = 20;
const MAX_SAMPLES = 10;
const PROJECT_RE = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;
const CODE_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
const TRACE_RE = /^[0-9a-f]{32}$/;
const DIMENSION_RE = /^[a-z0-9][a-z0-9_.:-]{0,79}$/;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tool_job_usage (
    project_id   TEXT NOT NULL,
    env          TEXT NOT NULL,
    capability   TEXT NOT NULL,
    dimension    TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    quantity     INTEGER NOT NULL DEFAULT 0,
    errors       INTEGER NOT NULL DEFAULT 0,
    error_codes  TEXT NOT NULL DEFAULT '{}',
    samples      TEXT NOT NULL DEFAULT '[]',
    revision     INTEGER NOT NULL DEFAULT 1,
    event_id     TEXT,
    emitted_at   INTEGER,
    PRIMARY KEY (project_id, env, capability, dimension, window_start)
);
CREATE INDEX IF NOT EXISTS tool_job_usage_open ON tool_job_usage(emitted_at, window_start);
`;

const hourOf = (ms) => Math.floor(ms / HOUR_MS) * HOUR_MS;
const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

/** The usage key of an ended tool_jobs row, or null when it does not count. */
function keyOf(row) {
    if (!row || !PROJECT_RE.test(String(row.project_id || '')) || (row.state !== 'succeeded' && row.state !== 'failed')) return null;
    const dimension = String(row.tool || row.type || '');
    return {
        project_id: row.project_id,
        env: row.env === 'sandbox' ? 'sandbox' : 'production',
        capability: row.tool ? 'tools.tool.run' : 'tools.job.create',
        dimension: DIMENSION_RE.test(dimension) ? dimension : 'other',
        window_start: hourOf(row.finished_at || Date.now()),
    };
}

/**
 * @param {object} o
 * @param {object} o.db          the jobs database (better-sqlite3), where the outbox lives too
 * @param {object} o.contracts   require('openvibe-contracts') (0.63.0+ knows tools.usage.recorded@1)
 * @param {object|null} o.outbox openvibe-sdk outbox on `db` (./events outboxFromEnv); null = inert
 * @param {() => number} [o.now]
 * @param {object} [o.log]
 */
function createJobUsage({ db, contracts, outbox = null, now = () => Date.now(), log = console }) {
    if (!outbox) return { enabled: false, finished() {}, flush: () => ({ queued: 0, invalid: 0 }), pending: () => 0 };
    db.exec(SCHEMA);
    const q = {
        add: db.prepare(`INSERT INTO tool_job_usage (project_id, env, capability, dimension, window_start, quantity, errors)
            VALUES (@project_id, @env, @capability, @dimension, @window_start, 1, @errors)
            ON CONFLICT(project_id, env, capability, dimension, window_start) DO UPDATE SET
                quantity = quantity + 1, errors = errors + excluded.errors,
                revision = revision + (CASE WHEN emitted_at IS NULL THEN 0 ELSE 1 END), emitted_at = NULL`),
        get: db.prepare('SELECT error_codes, samples FROM tool_job_usage WHERE project_id = ? AND env = ? AND capability = ? AND dimension = ? AND window_start = ?'),
        setErrors: db.prepare('UPDATE tool_job_usage SET error_codes = ?, samples = ? WHERE project_id = ? AND env = ? AND capability = ? AND dimension = ? AND window_start = ?'),
        due: db.prepare('SELECT * FROM tool_job_usage WHERE emitted_at IS NULL AND window_start <= ? ORDER BY window_start LIMIT 500'),
        sent: db.prepare('UPDATE tool_job_usage SET emitted_at = ?, event_id = ? WHERE project_id = ? AND env = ? AND capability = ? AND dimension = ? AND window_start = ? AND emitted_at IS NULL'),
        prune: db.prepare('DELETE FROM tool_job_usage WHERE emitted_at IS NOT NULL AND window_start < ?'),
        pending: db.prepare('SELECT COUNT(*) AS n FROM tool_job_usage WHERE emitted_at IS NULL'),
    };
    const stats = { invalid: 0, lastInvalid: null };

    /** INSIDE the transaction that records the job's end (store.finish), with the row read back. */
    function finished(row) {
        const k = keyOf(row);
        if (!k) return;
        const failed = row.state === 'failed';
        q.add.run({ ...k, errors: failed ? 1 : 0 });
        if (!failed) return;
        const error = parse(row.error_json, null) || {};
        const code = CODE_RE.test(String(error.code || '')) ? String(error.code) : 'tools.job.failed';
        const cur = q.get.get(k.project_id, k.env, k.capability, k.dimension, k.window_start);
        const codes = parse(cur.error_codes, {});
        if (codes[code] || Object.keys(codes).length < MAX_CODES) codes[code] = (codes[code] || 0) + 1;
        const sample = { at: new Date(row.finished_at || now()).toISOString(), code, ref: row.id };
        if (Number.isInteger(error.status) && error.status >= 100 && error.status <= 599) sample.status = error.status;
        if (TRACE_RE.test(String(row.trace_id || ''))) sample.trace_id = row.trace_id;
        const samples = [sample, ...parse(cur.samples, [])].slice(0, MAX_SAMPLES);
        q.setErrors.run(JSON.stringify(codes), JSON.stringify(samples), k.project_id, k.env, k.capability, k.dimension, k.window_start);
    }

    function payloadOf(row) {
        const p = {
            project_id: row.project_id, env: row.env, capability: row.capability, dimension: row.dimension, unit: 'jobs', window: 'hour',
            window_start: new Date(row.window_start).toISOString(), window_end: new Date(row.window_start + HOUR_MS).toISOString(),
            quantity: row.quantity, errors: row.errors,
        };
        const codes = parse(row.error_codes, {});
        if (Object.keys(codes).length) p.error_codes = codes;
        const samples = parse(row.samples, []);
        if (samples.length) p.samples = samples;
        if (row.revision > 1) p.revision = row.revision;
        return p;
    }

    /**
     * Write every closed hour's rollups to the outbox (each in the transaction that marks it sent).
     * A payload that fails its contract is logged and left unsent, never thrown.
     */
    function flush(at = now()) {
        let queued = 0;
        for (const row of q.due.all(hourOf(at - GRACE_MS) - HOUR_MS)) {
            const payload = payloadOf(row);
            const v = contracts.validate('tools.usage.recorded@1', payload);
            if (!v.valid) {
                stats.invalid++;
                stats.lastInvalid = `${row.project_id} ${row.capability} ${row.dimension}: ${v.errors.map(e => `${e.path} ${e.message}`).join('; ')}`;
                log.error(`[Jobs] tools.usage.recorded not sent (payload does not match the contract): ${stats.lastInvalid}`);
                continue;
            }
            db.transaction(() => {
                const env = outbox.enqueue({
                    event_type: 'tools.usage.recorded',
                    actor: { type: 'service', id: 'tools' },
                    subject: { type: 'project', id: row.project_id },
                    visibility: 'internal',
                    priority: 'low',
                    payload,
                });
                q.sent.run(at, env.event_id, row.project_id, row.env, row.capability, row.dimension, row.window_start);
            })();
            queued++;
        }
        q.prune.run(at - KEEP_SENT_MS);
        if (queued) outbox.kick();
        return { queued, invalid: stats.invalid };
    }

    return { enabled: true, finished, flush, payloadOf, pending: () => q.pending.get().n, status: () => ({ pending: q.pending.get().n, invalid: stats.invalid, last_invalid: stats.lastInvalid }) };
}

module.exports = { createJobUsage, keyOf, HOUR_MS, GRACE_MS };
