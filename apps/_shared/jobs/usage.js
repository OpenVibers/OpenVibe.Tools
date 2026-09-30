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
// On PostgreSQL (plan T8): openvibe-sdk/db, ambient transactions, createPgOutbox. Inert without an
// outbox (EVENTS_URL unset, like ./events.js): nothing is counted.
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
 * @param {object} o.db          openvibe-sdk/db handle (the one tools database), where the outbox lives too
 * @param {string} o.app         the owning app ('img' | …)
 * @param {object} o.contracts   require('openvibe-contracts') (0.63.0+ knows tools.usage.recorded@1)
 * @param {object|null} o.outbox openvibe-sdk createPgOutbox on `db` (./events outboxFromEnv); null = inert
 * @param {() => number} [o.now]
 * @param {object} [o.log]
 */
function createJobUsage({ db, app, contracts, outbox = null, now = () => Date.now(), log = console }) {
    if (!outbox) return { enabled: false, finished: async () => {}, flush: async () => ({ queued: 0, invalid: 0 }), pending: async () => 0, status: async () => ({ enabled: false }) };
    const q = {
        add: db.prepare(`INSERT INTO tool_job_usage (app, project_id, env, capability, dimension, window_start, quantity, errors)
            VALUES (@app, @project_id, @env, @capability, @dimension, @window_start, 1, @errors)
            ON CONFLICT(app, project_id, env, capability, dimension, window_start) DO UPDATE SET
                quantity = tool_job_usage.quantity + 1, errors = tool_job_usage.errors + excluded.errors,
                revision = tool_job_usage.revision + (CASE WHEN tool_job_usage.emitted_at IS NULL THEN 0 ELSE 1 END), emitted_at = NULL`),
        get: db.prepare('SELECT error_codes, samples FROM tool_job_usage WHERE app = @app AND project_id = @project_id AND env = @env AND capability = @capability AND dimension = @dimension AND window_start = @window_start'),
        setErrors: db.prepare('UPDATE tool_job_usage SET error_codes = @error_codes, samples = @samples WHERE app = @app AND project_id = @project_id AND env = @env AND capability = @capability AND dimension = @dimension AND window_start = @window_start'),
        due: db.prepare('SELECT * FROM tool_job_usage WHERE app = @app AND emitted_at IS NULL AND window_start <= @at ORDER BY window_start LIMIT 500'),
        sent: db.prepare('UPDATE tool_job_usage SET emitted_at = @at, event_id = @event_id WHERE app = @app AND project_id = @project_id AND env = @env AND capability = @capability AND dimension = @dimension AND window_start = @window_start AND emitted_at IS NULL'),
        prune: db.prepare('DELETE FROM tool_job_usage WHERE app = @app AND emitted_at IS NOT NULL AND window_start < @at'),
        pending: db.prepare('SELECT COUNT(*) AS n FROM tool_job_usage WHERE app = @app AND emitted_at IS NULL'),
    };
    const stats = { invalid: 0, lastInvalid: null };

    /** INSIDE the transaction that records the job's end (store.finish), with the row read back. */
    async function finished(row) {
        const k = keyOf(row);
        if (!k) return;
        const failed = row.state === 'failed';
        await q.add.run({ app, ...k, errors: failed ? 1 : 0 });
        if (!failed) return;
        const error = parse(row.error_json, null) || {};
        const code = CODE_RE.test(String(error.code || '')) ? String(error.code) : 'tools.job.failed';
        const cur = await q.get.get({ app, ...k });
        const codes = parse(cur.error_codes, {});
        if (codes[code] || Object.keys(codes).length < MAX_CODES) codes[code] = (codes[code] || 0) + 1;
        const sample = { at: new Date(row.finished_at || now()).toISOString(), code, ref: row.id };
        if (Number.isInteger(error.status) && error.status >= 100 && error.status <= 599) sample.status = error.status;
        if (TRACE_RE.test(String(row.trace_id || ''))) sample.trace_id = row.trace_id;
        const samples = [sample, ...parse(cur.samples, [])].slice(0, MAX_SAMPLES);
        await q.setErrors.run({ app, ...k, error_codes: JSON.stringify(codes), samples: JSON.stringify(samples) });
    }

    function payloadOf(row) {
        const p = {
            project_id: row.project_id, env: row.env, capability: row.capability, dimension: row.dimension, unit: 'jobs', window: 'hour',
            window_start: new Date(Number(row.window_start)).toISOString(), window_end: new Date(Number(row.window_start) + HOUR_MS).toISOString(),
            quantity: Number(row.quantity), errors: Number(row.errors),
        };
        const codes = parse(row.error_codes, {});
        if (Object.keys(codes).length) p.error_codes = codes;
        const samples = parse(row.samples, []);
        if (samples.length) p.samples = samples;
        if (Number(row.revision) > 1) p.revision = Number(row.revision);
        return p;
    }

    /**
     * Write every closed hour's rollups to the outbox (each in the transaction that marks it sent).
     * A payload that fails its contract is logged and left unsent, never thrown.
     */
    async function flush(at = now()) {
        let queued = 0;
        for (const row of await q.due.all({ app, at: hourOf(at - GRACE_MS) - HOUR_MS })) {
            const payload = payloadOf(row);
            const v = contracts.validate('tools.usage.recorded@1', payload);
            if (!v.valid) {
                stats.invalid++;
                stats.lastInvalid = `${row.project_id} ${row.capability} ${row.dimension}: ${v.errors.map(e => `${e.path} ${e.message}`).join('; ')}`;
                log.error(`[Jobs] tools.usage.recorded not sent (payload does not match the contract): ${stats.lastInvalid}`);
                continue;
            }
            await db.tx(async (t) => {
                const env = await outbox.enqueue(t, {
                    event_type: 'tools.usage.recorded',
                    actor: { type: 'service', id: 'tools' },
                    subject: { type: 'project', id: row.project_id },
                    visibility: 'internal',
                    priority: 'low',
                    payload,
                });
                await q.sent.run({ app, ...row, event_id: env.event_id, at });
            });
            queued++;
        }
        await q.prune.run({ app, at: at - KEEP_SENT_MS });
        if (queued) outbox.kick();
        return { queued, invalid: stats.invalid };
    }

    return {
        enabled: true, finished, flush, payloadOf,
        pending: async () => (await q.pending.get({ app })).n,
        status: async () => ({ pending: (await q.pending.get({ app })).n, invalid: stats.invalid, last_invalid: stats.lastInvalid }),
    };
}

module.exports = { createJobUsage, keyOf, HOUR_MS, GRACE_MS };
