'use strict';
// ═══════════════════════════════════════════════════════════════
// Job lifecycle → OpenVibe.Events (roadmap Wave 11, ADR-004).
//
//   queued (submit, retry)       → tools.job.created     priority low        actor: the owner, else service:tools
//   running (claim)              → tools.job.started     priority low        actor: service:tools
//   succeeded                    → tools.job.succeeded   priority important  actor: service:tools
//   failed (tool, timeout, boot) → tools.job.failed      priority important  actor: service:tools
//
// Each event is written to the satellite's own `event_outbox` table (openvibe-sdk createOutbox) in
// the SQLite transaction that records the transition, so it exists if and only if the transition
// committed; the relay posts it to OpenVibe.Events afterwards (at least once; Events dedupes on
// event_id). A cancelled job, a progress tick and a requeue after a restart are not announced (a
// requeued job is announced again when it starts). Sandbox jobs (developer-app sandbox tokens) are
// never announced.
//
// Payloads (openvibe-contracts tools.job.*@1, validated before they are enqueued) carry ids, type,
// owner, state, times, where result files are and the error; never the job's input, file names,
// output data or a browser session: a session-owned job has owner null.
//
// Inert unless EVENTS_URL is set (and OV_OAUTH_CLIENT_SECRET, for the tools service token with
// events.event.publish on openvibe.events): no outbox table, nothing written, nothing relayed.
// EVENTS_PUBLISH=off turns it off with EVENTS_URL set.
// ═══════════════════════════════════════════════════════════════

const SOURCE = 'tools';
const SERVICE_ACTOR = Object.freeze({ type: 'service', id: SOURCE });
// Owner prefixes in tool_jobs.owner → SubjectRef types. `session:<hash>` (a browser) maps to null.
const OWNER_TYPES = { user: 'user', svc: 'service', app: 'app', mod: 'mod' };
const PRIORITY = { 'tools.job.created': 'low', 'tools.job.started': 'low', 'tools.job.succeeded': 'important', 'tools.job.failed': 'important' };

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
const parse = (s, fallback) => { if (s == null) return fallback; try { return JSON.parse(s); } catch { return fallback; } };

/** 'user:usr_…' | 'svc:<slug>' | 'app:app_…' | 'mod:mod_…' → SubjectRef; anything else (a session) → null. */
function ownerRef(contracts, owner) {
    const s = String(owner || '');
    const i = s.indexOf(':');
    if (i < 1) return null;
    const type = OWNER_TYPES[s.slice(0, i)];
    const id = s.slice(i + 1);
    return type && contracts.ids.isSubjectId(type, id) ? { type, id } : null;
}

/** An error detail for the network: the job's own file names are taken out as well as server paths. */
function scrubDetail(detail, row) {
    let out = String(detail == null ? '' : detail);
    const names = new Set();
    for (const f of parse(row.files_json, [])) {
        if (f && f.name && String(f.name).length >= 3) names.add(String(f.name));
        if (f && f._path) { const base = String(f._path).split(/[/\\]/).pop(); if (base.length >= 3) names.add(base); }
    }
    for (const n of [...names].sort((a, b) => b.length - a.length)) out = out.split(n).join('[file]');
    return out.slice(0, 500);
}

/** tool_jobs row → the payload of `eventType` (tools.job.*@1). */
function payloadFor(eventType, row, { contracts, service, referenced = false }) {
    const p = {
        job_id: row.id,
        service,
        type: row.type,
        type_version: row.type_version,
        state: row.state,
        owner: ownerRef(contracts, row.owner),
        attempts: row.attempts,
        max_attempts: row.max_attempts,
        created_at: iso(row.created_at),
        retry_of: row.retry_of || null,
    };
    if (eventType === 'tools.job.created') return p;
    p.started_at = iso(row.started_at);
    if (eventType === 'tools.job.started') return p;
    p.finished_at = iso(row.finished_at);
    p.expires_at = referenced ? null : iso(row.expires_at);
    if (eventType === 'tools.job.succeeded') {
        const result = parse(row.result_json, null) || {};
        p.result = {
            files: (result.files || []).map((f, index) => ({
                index,
                mime: String(f.mime || 'application/octet-stream'),
                size: Number(f.size) || 0,
                sha256: f.sha256,
                storage: f.storage === 'media' ? 'media' : 'local',
                media: f.storage === 'media' && f.media && f.media.media_id ? { media_id: f.media.media_id, role: f.media.role || 'output' } : null,
            })),
        };
        return p;
    }
    const error = parse(row.error_json, null) || {};
    p.error = {
        status: Number.isInteger(error.status) ? error.status : 500,
        code: /^tools\.[a-z0-9_.]+$/.test(String(error.code || '')) ? error.code : 'tools.job.failed',
        detail: scrubDetail(error.detail || error.title || 'The job failed', row),
    };
    p.retryable = !!row.retryable;
    return p;
}

/**
 * The announcer the job system calls inside its transactions. With no outbox every call is a no-op.
 *
 * @param {object} o
 * @param {object} o.contracts   require('openvibe-contracts') (v0.30.0+ knows tools.job.*@1)
 * @param {string} o.service     the satellite ('img' | 'audio' | 'docs' | …) → payload.service
 * @param {object|null} o.outbox openvibe-sdk createOutbox(db, …) on the jobs database, or null
 * @param {(id) => number} [o.referenceCount]
 * @param {object} [o.log]
 */
function createJobEvents({ contracts, service, outbox = null, referenceCount = () => 0, log = console }) {
    const stats = { queued: 0, invalid: 0, lastInvalid: null };

    /**
     * Enqueue `eventType` for this row (just read back inside the caller's transaction). A payload that
     * fails its contract is logged and skipped, never thrown: a bug here must not stop jobs. An outbox
     * write error does throw, so the caller's transaction rolls back with it.
     */
    function announce(eventType, row) {
        if (!outbox || !row || row.env === 'sandbox') return null;
        let payload;
        try {
            payload = payloadFor(eventType, row, { contracts, service, referenced: eventType !== 'tools.job.created' && eventType !== 'tools.job.started' && referenceCount(row.id) > 0 });
            const v = contracts.validate(`${eventType}@1`, payload);
            if (!v.valid) throw new Error(v.errors.map(e => `${e.path} ${e.message}`).join('; '));
        } catch (err) {
            stats.invalid++;
            stats.lastInvalid = `${eventType} ${row.id}: ${err.message}`;
            log.error(`[Jobs] ${eventType} for ${row.id} not announced (payload does not match the contract): ${err.message}`);
            return null;
        }
        const env = outbox.enqueue({
            event_type: eventType,
            actor: eventType === 'tools.job.created' && payload.owner ? payload.owner : SERVICE_ACTOR,
            subject: { type: 'job', id: row.id },
            visibility: 'internal',
            priority: PRIORITY[eventType],
            payload,
        });
        stats.queued++;
        outbox.kick();   // a timer: the relay runs after this transaction commits
        return env;
    }

    return {
        enabled: !!outbox,
        created: (row) => announce('tools.job.created', row),
        started: (row) => announce('tools.job.started', row),
        /** succeeded → tools.job.succeeded, failed → tools.job.failed; cancelled is not announced. */
        finished: (row) => (row && row.state === 'succeeded' ? announce('tools.job.succeeded', row)
            : row && row.state === 'failed' ? announce('tools.job.failed', row) : null),
        status() {
            if (!outbox) return { enabled: false };
            return { enabled: true, pending: outbox.pending(), rejected: outbox.rejected(), queued_since_boot: stats.queued, invalid: stats.invalid, last_invalid: stats.lastInvalid };
        },
    };
}

/**
 * The outbox from the environment → { outbox, reason } (outbox null = inert).
 *
 *   EVENTS_URL                 OpenVibe.Events on this host, e.g. http://127.0.0.1:4300 (unset = off)
 *   EVENTS_PUBLISH=off         off even with EVENTS_URL set
 *   OV_OAUTH_CLIENT_ID         the tools client (default tools): events.event.publish on openvibe.events
 *   OV_OAUTH_CLIENT_SECRET
 *   OV_NETWORK_INTERNAL_URL    token endpoint host (default http://127.0.0.1:4000)
 *   EVENTS_RELAY_INTERVAL_MS   relay poll (default 2000)
 *
 * @param {object} o
 * @param {object} o.db       the jobs database (better-sqlite3) — the outbox table lives beside tool_jobs
 * @param {object} [o.sdk]    require('openvibe-sdk')
 * @param {object} [o.env]
 * @param {Function} [o.fetch]
 * @param {object} [o.log]
 */
function outboxFromEnv({ db, sdk, env = process.env, fetch: fetchImpl, log = console }) {
    const url = String(env.EVENTS_URL || '').trim().replace(/\/+$/, '');
    if (!url) return { outbox: null, reason: 'EVENTS_URL is not set' };
    if (String(env.EVENTS_PUBLISH || '').toLowerCase() === 'off') return { outbox: null, reason: 'EVENTS_PUBLISH=off' };
    if (!sdk || !sdk.events || !sdk.auth) return { outbox: null, reason: 'openvibe-sdk is not installed in this app' };
    const secret = env.OV_OAUTH_CLIENT_SECRET || '';
    if (!secret) return { outbox: null, reason: 'EVENTS_URL is set but OV_OAUTH_CLIENT_SECRET is not' };
    const network = String(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
    const tokens = sdk.auth.createServiceTokenClient({
        tokenUrl: `${network}/oauth/token`,
        clientId: env.OV_OAUTH_CLIENT_ID || 'tools',
        clientSecret: secret,
        scope: { 'openvibe.events': 'events.event.publish' },
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
    const client = sdk.createClient({ baseUrls: { events: url }, tokenProvider: tokens, retries: 0, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
    let lastError = null;
    const interval = parseInt(env.EVENTS_RELAY_INTERVAL_MS, 10);
    const outbox = sdk.events.createOutbox(db, {
        events: sdk.events.createEventsClient(client, { source: SOURCE }),
        intervalMs: Number.isFinite(interval) && interval >= 100 ? interval : 2000,
        onError: (err) => {
            const msg = err && err.message;
            if (msg !== lastError) log.warn('[Jobs] events relay: publish failed (will retry):', msg);
            lastError = msg;
        },
    });
    outbox.ensureSchema();
    outbox.url = url;
    return { outbox, reason: null };
}

module.exports = { createJobEvents, outboxFromEnv, payloadFor, ownerRef, scrubDetail, SOURCE };
