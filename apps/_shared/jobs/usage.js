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
// Billing readings (plan T5 step 7): with a Billing client (../billing.js, OV_BILLING_URL set), the same
// transaction also stores the job's platform.usage-sample@1 reading (readingOf: anyone's job that
// succeeded or failed, not only a project's; quantity 1, unit jobs, idempotency_key tools:job:<id>) in
// tool_job_billing_readings, never posting it there. flushReadings() posts the unsent ones (500 at most
// a call) and marks each sent; a refused post counts an attempt with its error and stays for the next
// call. The reading names the person (subject user:usr_…) for a person's job, never an app or a browser
// session; no input, file name or output. Billing keeps it; the hourly rollups above stay subject-less.
//
// On PostgreSQL (plan T8): openvibe-sdk/db, ambient transactions, createPgOutbox. The rollups are inert
// without an outbox (EVENTS_URL unset, like ./events.js), the readings without a Billing client.
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
const PERSON_RE = /^user:usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const READINGS_PER_FLUSH = 500;

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

/** The Billing reading (platform.usage-sample@1) of an ended tool_jobs row, or null when it is not billed. */
function readingOf(row) {
    if (!row || !row.id || (row.state !== 'succeeded' && row.state !== 'failed')) return null;
    const resource = String(row.tool || row.type || '');
    const r = {
        id: `tools-job-${row.id}`,
        idempotency_key: `tools:job:${row.id}`,
        service: 'openvibe.tools',
        operation: row.tool ? 'tools.tool.run' : 'tools.job.create',
        resource: DIMENSION_RE.test(resource) ? resource : 'other',
        quantity: 1,
        unit: 'jobs',
        at: new Date(Number(row.finished_at) || Date.now()).toISOString(),
        source: 'openvibe.tools',
    };
    if (PROJECT_RE.test(String(row.project_id || ''))) r.project = row.project_id;
    if (PERSON_RE.test(String(row.owner || ''))) r.subject = row.owner;     // a person's job; never an app or a session
    if (TRACE_RE.test(String(row.trace_id || ''))) r.trace_id = row.trace_id;
    return r;
}

/**
 * @param {object} o
 * @param {object} o.db          openvibe-sdk/db handle (the one tools database), where the outbox lives too
 * @param {string} o.app         the owning app ('img' | …)
 * @param {object} o.contracts   require('openvibe-contracts') (0.63.0+ knows tools.usage.recorded@1)
 * @param {object|null} o.outbox openvibe-sdk createPgOutbox on `db` (./events outboxFromEnv); null = no rollups
 * @param {object|null} [o.billing] ../billing createBillingClient; null or not enabled = no readings
 * @param {() => number} [o.now]
 * @param {object} [o.log]
 */
function createJobUsage({ db, app, contracts, outbox = null, billing = null, now = () => Date.now(), log = console }) {
    const billed = !!(billing && billing.enabled);
    const r = {
        add: db.prepare('INSERT INTO tool_job_billing_readings (job_id, app, reading, created_at) VALUES (@job_id, @app, @reading, @at) ON CONFLICT (job_id) DO NOTHING'),
        unsent: db.prepare('SELECT job_id, reading FROM tool_job_billing_readings WHERE app = @app AND sent_at IS NULL ORDER BY attempts, created_at LIMIT @limit'),
        sent: db.prepare('UPDATE tool_job_billing_readings SET sent_at = @at, last_error = NULL WHERE job_id = @job_id'),
        failed: db.prepare('UPDATE tool_job_billing_readings SET attempts = attempts + 1, last_error = @error WHERE job_id = @job_id'),
        prune: db.prepare('DELETE FROM tool_job_billing_readings WHERE app = @app AND sent_at IS NOT NULL AND sent_at < @at'),
        pending: db.prepare('SELECT COUNT(*) AS n FROM tool_job_billing_readings WHERE app = @app AND sent_at IS NULL'),
    };
    const readings = { posted: 0, refused: 0, invalid: 0, lastError: null, running: null };

    /** INSIDE the job-end transaction: store the reading (once per job); nothing leaves here. */
    async function record(row) {
        const reading = billed ? readingOf(row) : null;
        if (!reading) return;
        let v;
        try { v = contracts.validate('platform.usage-sample@1', reading); } catch (err) { v = { valid: false, errors: [{ path: '', message: err.message }] }; }
        if (!v.valid) {
            readings.invalid++;
            readings.lastError = `${reading.idempotency_key}: ${v.errors.map(e => `${e.path} ${e.message}`).join('; ')}`;
            log.error(`[Jobs] billing reading not stored (does not match the contract): ${readings.lastError}`);
            return;
        }
        await r.add.run({ job_id: row.id, app, reading: JSON.stringify(reading), at: now() });
    }

    /** Post the unsent readings to Billing, oldest and least-tried first; a refused one stays for the next call. */
    function flushReadings(at = now()) {
        if (!billed) return Promise.resolve({ posted: 0, refused: 0 });
        if (!readings.running) readings.running = (async () => {
            let posted = 0, refused = 0;
            for (const row of await r.unsent.all({ app, limit: READINGS_PER_FLUSH })) {
                const reading = typeof row.reading === 'string' ? parse(row.reading, null) : row.reading;
                const res = await billing.post(reading);
                if (res.ok) { await r.sent.run({ job_id: row.job_id, at: now() }); posted++; continue; }
                refused++;
                readings.lastError = res.error || String(res.status);
                await r.failed.run({ job_id: row.job_id, error: readings.lastError.slice(0, 500) });
                // Billing or the token is down (or the grant is missing): stop here, the rest waits for the next call.
                if (res.token || !res.status || res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500) break;
            }
            await r.prune.run({ app, at: at - KEEP_SENT_MS });
            readings.posted += posted; readings.refused += refused;
            return { posted, refused };
        })().finally(() => { readings.running = null; });
        return readings.running;
    }
    const readingsStatus = async () => ({ pending: Number((await r.pending.get({ app })).n), posted: readings.posted, refused: readings.refused, invalid: readings.invalid, last_error: readings.lastError });

    if (!outbox) {
        return {
            enabled: false, billed, finished: record, flush: async () => ({ queued: 0, invalid: 0 }), flushReadings,
            pending: async () => 0, status: async () => ({ enabled: false }), readings: readingsStatus,
        };
    }
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
        await record(row);
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
        enabled: true, billed, finished, flush, flushReadings, payloadOf, readings: readingsStatus,
        pending: async () => (await q.pending.get({ app })).n,
        status: async () => ({ pending: (await q.pending.get({ app })).n, invalid: stats.invalid, last_invalid: stats.lastInvalid }),
    };
}

module.exports = { createJobUsage, keyOf, readingOf, HOUR_MS, GRACE_MS };
