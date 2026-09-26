'use strict';
// ═══════════════════════════════════════════════════════════════
// Asynchronous jobs for a Tools satellite (roadmap Wave 11, §15.15).
//
//   accepted (202) → queued → running → succeeded | failed | cancelled
//
// Durable: a job is written to the satellite's SQLite, and its input files moved under
// <dataDir>/jobs/<id>/in/, BEFORE the 202 goes out. On boot, rows left 'running' by a restart
// are re-queued (onRestart: 'requeue', while attempts remain) or failed with retryable = true
// (onRestart: 'fail'), per job type. Queued rows simply start again.
//
// Bounded: at most `concurrency` jobs run at once in this process, and each owner may have at
// most `maxActivePerOwner` queued + running jobs. busy() says when the whole store is over its
// bounds — `maxQueued` jobs waiting (all owners), or `diskBudgetBytes` under <dataDir>/jobs — so the
// HTTP layer can answer 503 tools.busy with Retry-After before it accepts an upload (through the
// guard: refused in enforce mode, recorded in report mode). Finished jobs expire (ttl chosen at submit),
// and the pruner deletes the row, its events, its files and any Media objects it made — except
// while something references the result (reference(), e.g. a paste or a project that points at the
// Media object), and never while Media keeps an object (a retention hold, or Media unreachable):
// then the job is kept and looked at again later, so no referenced result loses its record.
//
// Retry: a failed job keeps its input files until it expires; retry(id) moves them to a new job
// (retry_of → the failed one, which records retried_by). Retrying the same failed job again
// returns that same new job, so the call is idempotent.
//
// Events: with an outbox (./events, openvibe-sdk createOutbox on this same database), created,
// started, succeeded and failed are also announced to OpenVibe.Events as tools.job.*, each written
// in the transaction that records the transition. Without one, nothing is announced.
//
// Usage (WS-N task 4): with an outbox, a developer project's job that ends is also counted in the
// transaction that records its end (./usage.js), and each closed hour goes out as tools.usage.recorded
// from the pruner's timer.
//
// No dependencies of its own: the app passes its better-sqlite3 handle and openvibe-contracts.
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { createStore, TERMINAL } = require('./store');
const { createJobEvents } = require('./events');
const { createJobUsage } = require('./usage');

const HOUR = 60 * 60 * 1000;

// A developer project's jobs (WS-L task 5): results go to Media under <tools namespace>.app.<project_id>
// (production) or .app.<project_id>.sandbox, so Media's namespace usage meters each project.
const PROJECT_RE = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;
const projectOf = (p) => (PROJECT_RE.test(String(p || '')) ? String(p) : null);
function projectNamespace(media, row) {
    if (!row.project_id || !PROJECT_RE.test(row.project_id)) return null;
    return `${media.namespace || 'tools'}.app.${row.project_id}${row.env === 'sandbox' ? '.sandbox' : ''}`;
}
const PRUNE_RECHECK_MS = 24 * HOUR;   // an expired job the pruner could not finish is looked at again after this
const REF_RE = /^[a-z][a-z0-9_-]*(?::[A-Za-z0-9_.-]+){1,4}$/;   // <service>:<kind>:<id>, e.g. community:paste:p_123
const MAX_REFS = 50;
const EVENT_FOR = { queued: 'job.queued', running: 'job.running', succeeded: 'job.succeeded', failed: 'job.failed', cancelled: 'job.cancelled' };
const SAFE_NAME = (s) => String(s || 'file').replace(/[/\\\0]/g, '_').replace(/[^\w.\- ]/g, '_').slice(-120) || 'file';

/** A failure the HTTP layer turns into problem+json. */
class JobError extends Error {
    constructor(status, code, detail, extra) { super(detail || code); this.status = status; this.code = code; this.detail = detail; this.extra = extra; }
}

/** Stable JSON: keys sorted, so the same input always hashes the same. */
function canonical(v) {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
    return JSON.stringify(v === undefined ? null : v);
}

function sha256File(file) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        fs.createReadStream(file).on('data', c => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
    });
}

async function moveFile(from, to) {
    try { await fsp.rename(from, to); } catch { await fsp.copyFile(from, to); await fsp.unlink(from).catch(() => {}); }
}

/** Tool error text is meant for people; absolute server paths are not. */
const scrub = (msg) => String(msg || '').replace(/(?:\/[\w.-]+){2,}/g, '[file]').slice(0, 500);

/**
 * @param {object} o
 * @param {object} o.db            better-sqlite3 Database (the satellite's own jobs database)
 * @param {object} o.contracts     require('openvibe-contracts')
 * @param {string} o.service       'img' | 'audio' | 'docs' | …
 * @param {string} o.dataDir       where job files live (<dataDir>/jobs/<id>/…)
 * @param {number} [o.concurrency=2]
 * @param {number} [o.maxActivePerOwner=10]
 * @param {number} [o.maxActivePerAddress]  unfinished browser-session jobs per address (ipKey), all
 *                                        sessions together (default 3 × maxActivePerOwner); see addressFull()
 * @param {number} [o.maxQueued=0]        queued jobs (all owners) before busy() says so; 0 = no bound
 * @param {number} [o.diskBudgetBytes=0]  bytes under <dataDir>/jobs before busy() says so; 0 = no bound
 * @param {object} [o.media]       result store from ./media (null = keep results on local disk)
 * @param {object} [o.outbox]      openvibe-sdk outbox on `db` (./events outboxFromEnv); null = no platform events
 * @param {number} [o.pruneIntervalMs=300000]
 * @param {number} [o.progressThrottleMs=250]
 */
function createJobSystem(o) {
    if (!o || !o.db || !o.contracts || !o.dataDir) throw new TypeError('createJobSystem needs db, contracts and dataDir');
    const { contracts } = o;
    const store = createStore(o.db);
    const log = o.log || console;
    const concurrency = Math.max(0, Number.isFinite(o.concurrency) ? o.concurrency : 2);
    const maxActivePerOwner = Math.max(1, o.maxActivePerOwner || 10);
    const media = o.media || null;
    const throttleMs = o.progressThrottleMs == null ? 250 : o.progressThrottleMs;
    const root = path.resolve(o.dataDir, 'jobs');
    fs.mkdirSync(root, { recursive: true });
    const maxQueued = o.maxQueued > 0 ? o.maxQueued : 0;
    const maxActivePerAddress = o.maxActivePerAddress > 0 ? o.maxActivePerAddress : 3 * maxActivePerOwner;
    const diskBudget = o.diskBudgetBytes > 0 ? o.diskBudgetBytes : 0;
    const disk = { bytes: 0, at: 0, scanning: null };
    const announce = createJobEvents({ contracts, service: o.service, outbox: o.outbox || null, referenceCount: (id) => store.referenceCount(id), log });
    const usage = createJobUsage({ db: o.db, contracts, outbox: o.outbox || null, log });
    /** Inside the transaction that recorded the end: tools.job.succeeded|failed and the project's usage. */
    function ended(id) {
        const row = store.get(id);
        announce.finished(row);
        usage.finished(row);
    }

    const types = new Map();
    const active = new Map();      // id → { ctrl, reason, last: { pct, msg, at } }
    const listeners = new Map();   // id → Set<fn>
    const stopHooks = new Set();   // e.g. open SSE streams, ended on stop()
    let started = false, stopped = false, pruneTimer = null, kicking = false;

    const jobDir = (id) => path.join(root, id);
    const problem = (status, code, detail, extra) => contracts.http.problem(status, code, { detail, extra });

    // ── Types ──────────────────────────────────────────────────
    /**
     * define({ type, version, onRestart: 'requeue'|'fail', maxAttempts, timeoutMs, minFiles, maxFiles,
     *          validate(input, files) → string|null, run(ctx) → { files: [{ path, name, mime }], data } })
     */
    function define(def) {
        if (!def || !/^[a-z][a-z0-9]*\.[a-z0-9_.]+$/.test(def.type || '')) throw new TypeError(`bad job type ${def && def.type}`);
        if (typeof def.run !== 'function') throw new TypeError(`${def.type}: run() is required`);
        types.set(def.type, {
            version: 1, onRestart: 'requeue', maxAttempts: 3, timeoutMs: 10 * 60 * 1000, minFiles: 0, maxFiles: 1,
            validate: () => null, ...def,
            onRestart: def.onRestart === 'fail' ? 'fail' : 'requeue',
        });
        return api;
    }

    // ── Public representation ─────────────────────────────────
    const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
    function publicResult(result, id) {
        if (!result) return null;
        return {
            files: (result.files || []).map((f, i) => {
                const out = {};
                for (const [k, v] of Object.entries(f)) if (!k.startsWith('_')) out[k] = v;
                out.url = `/api/v1/jobs/${id}/files/${i}`;
                return out;
            }),
            data: result.data || {},
        };
    }
    function view(row) {
        if (!row) return null;
        const live = row.state === 'queued' || row.state === 'running';
        const references = store.references(row.id).map(r => ({ ref: r.ref, created_at: iso(r.created_at) }));
        return {
            id: row.id,
            object: 'tools.job',
            service: o.service,
            ...(row.tool && { tool: row.tool }),
            type: row.type,
            type_version: row.type_version,
            state: row.state,
            progress: { percent: row.progress == null ? null : Math.round(row.progress * 10) / 10, message: row.progress_message || null },
            attempts: row.attempts,
            max_attempts: row.max_attempts,
            cancel_requested: !!row.cancel_requested,
            created_at: iso(row.created_at),
            started_at: iso(row.started_at),
            finished_at: iso(row.finished_at),
            // null while something references the result: it is kept until the last reference goes.
            expires_at: references.length ? null : iso(row.expires_at),
            result: publicResult(store.parse(row.result_json, null), row.id),
            error: store.parse(row.error_json, null),
            retryable: !!row.retryable,
            retry_of: row.retry_of || null,
            retried_by: row.retried_by || null,
            references,
            links: {
                self: `/api/v1/jobs/${row.id}`,
                events: `/api/v1/jobs/${row.id}/events`,
                cancel: live ? `/api/v1/jobs/${row.id}` : null,
                retry: row.state === 'failed' ? `/api/v1/jobs/${row.id}/retry` : null,
                retried_by: row.retried_by ? `/api/v1/jobs/${row.retried_by}` : null,
            },
        };
    }

    // ── Events ─────────────────────────────────────────────────
    function emit(id, event) {
        if (stopped) return;
        const data = view(store.get(id));
        if (!data) return;
        const seq = store.appendEvent(id, event, data);
        const set = listeners.get(id);
        if (set) for (const fn of [...set]) { try { fn({ seq, event, data }); } catch (err) { log.error('[Jobs] listener error:', err.message); } }
    }
    function subscribe(id, fn) {
        if (!listeners.has(id)) listeners.set(id, new Set());
        listeners.get(id).add(fn);
        return () => { const s = listeners.get(id); if (s) { s.delete(fn); if (!s.size) listeners.delete(id); } };
    }

    // ── Submit ─────────────────────────────────────────────────
    /**
     * submit({ owner, type, input, files: [{ path | buffer, name, mime, size }], idempotencyKey, ttlMs })
     * → { job (row), replayed }. Temp input files are consumed (moved) on accept and deleted on replay.
     */
    // Developer-app sandbox jobs: fewer at a time, kept briefly, results never leave this server.
    const SANDBOX_MAX_ACTIVE = Math.max(1, o.sandboxMaxActivePerOwner || 2);
    const SANDBOX_TTL_MS = 30 * 60 * 1000;
    async function submit({ owner, type, input = {}, files = [], idempotencyKey = null, ttlMs = HOUR, env = 'production', ipKey = null, tool = null, project = null, traceId = null }) {
        if (env !== 'sandbox') env = 'production';
        if (env === 'sandbox') ttlMs = Math.min(ttlMs, SANDBOX_TTL_MS);
        if (stopped) throw new JobError(503, 'tools.job.unavailable', 'The job system is shutting down');
        const discard = () => Promise.all(files.map(f => (f.path ? fsp.unlink(f.path).catch(() => {}) : null)));
        try {
            if (!owner) throw new JobError(401, 'tools.job.no_owner', 'No owner for this job');
            const def = types.get(type);
            if (!def) throw new JobError(400, 'tools.job.unknown_type', `Unknown job type "${type}". Known: ${[...types.keys()].join(', ')}`);
            if (input == null || typeof input !== 'object' || Array.isArray(input)) throw new JobError(400, 'tools.job.invalid', 'input must be a JSON object');
            if (JSON.stringify(input).length > 16384) throw new JobError(400, 'tools.job.invalid', 'input is larger than 16 KB');
            if (files.length < def.minFiles) throw new JobError(400, 'tools.job.invalid', def.minFiles === 1 ? 'This job needs a file' : `This job needs at least ${def.minFiles} files`);
            if (files.length > def.maxFiles) throw new JobError(400, 'tools.job.invalid', `At most ${def.maxFiles} file(s) for this job`);
            const bad = def.validate(input, files);
            if (bad) throw new JobError(400, 'tools.job.invalid', bad);
            if (idempotencyKey != null && !/^[\x21-\x7e]{8,200}$/.test(String(idempotencyKey))) throw new JobError(400, 'tools.job.invalid', 'Idempotency-Key must be 8-200 printable characters');

            // Hash the request so a reused key with a different request is caught.
            const fileHashes = [];
            for (const f of files) fileHashes.push(f.buffer ? crypto.createHash('sha256').update(f.buffer).digest('hex') : await sha256File(f.path));
            const requestHash = crypto.createHash('sha256').update(canonical({ type, input, files: fileHashes })).digest('hex');

            if (idempotencyKey != null) {
                const prior = store.byIdempotencyKey(owner, String(idempotencyKey));
                if (prior) {
                    await discard();
                    if (prior.request_hash !== requestHash) throw new JobError(409, 'tools.job.idempotency_conflict', 'This Idempotency-Key was used for a different request', { job_id: prior.id });
                    return { job: prior, replayed: true };
                }
            }
            const limit = env === 'sandbox' ? Math.min(SANDBOX_MAX_ACTIVE, maxActivePerOwner) : maxActivePerOwner;
            if (store.activeForOwner(owner) >= limit) throw new JobError(429, 'tools.job.too_many_active', `At most ${limit} unfinished jobs at a time; wait for one to finish or cancel one`);

            const id = `job_${contracts.ids.ulid()}`;
            const inDir = path.join(jobDir(id), 'in');
            await fsp.mkdir(inDir, { recursive: true });
            const stored = [];
            for (let i = 0; i < files.length; i++) {
                const f = files[i];
                const dest = path.join(inDir, `${i}-${SAFE_NAME(f.name)}`);
                if (f.buffer) await fsp.writeFile(dest, f.buffer); else await moveFile(f.path, dest);
                stored.push({ name: String(f.name || `file-${i}`).slice(0, 200), mime: f.mime || 'application/octet-stream', size: f.size != null ? f.size : fs.statSync(dest).size, sha256: fileHashes[i], _path: dest });
            }
            try {
                store.transaction(() => {
                    store.insert({
                        id, type, type_version: def.version, owner, input_json: JSON.stringify(input), files_json: JSON.stringify(stored),
                        idempotency_key: idempotencyKey == null ? null : String(idempotencyKey), request_hash: requestHash,
                        max_attempts: def.maxAttempts, ttl_ms: ttlMs, now: Date.now(), env,
                        ip_key: String(owner).startsWith('session:') && ipKey ? String(ipKey) : null,
                        tool: tool && /^[a-z][a-z0-9-]{0,39}$/.test(String(tool)) ? String(tool) : null,
                        project_id: projectOf(project),
                        trace_id: /^[0-9a-f]{32}$/.test(String(traceId || '')) ? String(traceId) : null,
                    });
                    announce.created(store.get(id));
                })();
            } catch (err) {
                await fsp.rm(jobDir(id), { recursive: true, force: true });
                // Two submits with one key raced: the other one won, so this is a replay of it.
                if (/UNIQUE/.test(err.message) && idempotencyKey != null) {
                    const prior = store.byIdempotencyKey(owner, String(idempotencyKey));
                    if (prior && prior.request_hash === requestHash) return { job: prior, replayed: true };
                    throw new JobError(409, 'tools.job.idempotency_conflict', 'This Idempotency-Key was used for a different request');
                }
                throw err;
            }
            disk.bytes += stored.reduce((n, f) => n + (f.size || 0), 0);
            emit(id, 'job.queued');
            kick();
            return { job: store.get(id), replayed: false };
        } catch (err) {
            await discard();
            throw err;
        }
    }

    // ── Scheduling ─────────────────────────────────────────────
    function kick() {
        if (!started || stopped || kicking) return;
        kicking = true;
        try {
            while (active.size < concurrency) {
                const [row] = store.nextQueued(1);
                if (!row) break;
                // The claim and its tools.job.started event commit together (or neither does).
                let claimed;
                try {
                    claimed = store.transaction(() => {
                        if (!store.claim(row.id)) return false;
                        announce.started(store.get(row.id));
                        return true;
                    })();
                } catch (err) {
                    log.error(`[Jobs] could not start ${row.id}:`, err.message);
                    break;   // it stays queued; the next kick tries again
                }
                if (!claimed) continue;
                const entry = { ctrl: new AbortController(), reason: null, last: { pct: -1, msg: null, at: 0 } };
                active.set(row.id, entry);
                emit(row.id, 'job.running');
                setImmediate(() => execute(row.id, entry));
            }
        } finally { kicking = false; }
    }

    function progressFn(id, entry) {
        return (percent, message) => {
            if (stopped || entry.reason) return;
            const pct = Math.max(0, Math.min(100, Number(percent) || 0));
            const msg = message == null ? entry.last.msg : String(message).slice(0, 200);
            const now = Date.now();
            if (msg === entry.last.msg && (Math.abs(pct - entry.last.pct) < 1 || now - entry.last.at < throttleMs)) return;
            entry.last = { pct, msg, at: now };
            if (store.setProgress(id, pct, msg, now)) emit(id, 'job.progress');
        };
    }

    async function execute(id, entry) {
        const row = stopped ? null : store.get(id);
        if (!row) { active.delete(id); return; }
        const def = types.get(row.type);
        const outDir = path.join(jobDir(row.id), 'out');
        let outcome;
        const timer = setTimeout(() => { if (!entry.reason) { entry.reason = 'timeout'; entry.ctrl.abort(new Error('timeout')); } }, def.timeoutMs);
        if (timer.unref) timer.unref();
        try {
            await fsp.mkdir(outDir, { recursive: true });
            const files = store.parse(row.files_json, []).map(f => ({ name: f.name, mime: f.mime, size: f.size, sha256: f.sha256, path: f._path }));
            const out = await def.run({
                job: { id: row.id, type: row.type, attempt: row.attempts, owner: row.owner },
                input: store.parse(row.input_json, {}), files, outDir,
                signal: entry.ctrl.signal,
                progress: progressFn(row.id, entry),
            });
            if (stopped) return;
            if (entry.reason) throw new Error(entry.reason);
            const result = await storeResult(row, out || {}, entry);
            if (stopped) return;
            if (entry.reason) { await dropResult(result); throw new Error(entry.reason); }
            outcome = { state: 'succeeded', result };
        } catch (err) {
            if (stopped) return;
            const fresh = store.get(row.id) || row;
            if (entry.reason === 'cancel' || fresh.cancel_requested) outcome = { state: 'cancelled', error: problem(409, 'tools.job.cancelled', 'The job was cancelled') };
            else if (entry.reason === 'timeout') outcome = { state: 'failed', error: problem(504, 'tools.job.timeout', `The job ran longer than ${Math.round(def.timeoutMs / 1000)} s`), retryable: true };
            else {
                if (!err.expose) log.error(`[Jobs] ${row.type} ${row.id} failed:`, err.message);
                // Only codes a tool chose on purpose (tools.…) are passed on; errno codes and the like are not contracts.
                const code = /^tools\.[a-z0-9_.]+$/.test(String(err.code || '')) ? err.code : 'tools.job.failed';
                outcome = { state: 'failed', error: problem(Number.isInteger(err.status) ? err.status : 422, code, scrub(err.message) || 'The tool could not process this input'), retryable: !!err.retryable };
            }
        } finally {
            clearTimeout(timer);
        }
        let recorded = false;
        try {
            // The end state and its tools.job.succeeded|failed event commit together (or neither does).
            store.transaction(() => { if (store.finish(row.id, outcome)) ended(row.id); })();
            recorded = true;
            emit(row.id, EVENT_FOR[outcome.state]);
        } catch (err) {
            // Nothing committed: the row is still 'running' with its inputs, which the next start() recovers.
            log.error(`[Jobs] could not record the end of ${row.id}:`, err.message);
        } finally {
            active.delete(row.id);
            // A failed job keeps its inputs (until it expires) so it can be retried.
            if (recorded && outcome.state !== 'failed') fsp.rm(path.join(jobDir(row.id), 'in'), { recursive: true, force: true }).catch(() => {});
            if (recorded && outcome.state !== 'succeeded') fsp.rm(outDir, { recursive: true, force: true }).catch(() => {});
            kick();
        }
    }

    /** Output files → Media objects (when configured) or kept under <job>/out for /files/:n. */
    async function storeResult(row, out, entry) {
        const outDir = path.join(jobDir(row.id), 'out');
        const files = [];
        const list = Array.isArray(out.files) ? out.files : [];
        for (let i = 0; i < list.length; i++) {
            const f = list[i];
            let local = path.resolve(f.path);
            if (path.dirname(local) !== outDir) {
                const dest = path.join(outDir, `${i}-${SAFE_NAME(f.name)}`);
                await moveFile(local, dest);
                local = dest;
            }
            const size = fs.statSync(local).size;
            const sha256 = await sha256File(local);
            const rec = { name: String(f.name || `result-${i}`).slice(0, 200), mime: f.mime || 'application/octet-stream', size, sha256, storage: 'local', media: null, _path: local };
            // A developer app's results (sandbox too) go under its project's namespace (WS-L task 5); other
            // sandbox results stay on this server until the job expires.
            if (media && !entry.reason && (row.env !== 'sandbox' || row.project_id)) {
                try {
                    const progress = progressFn(row.id, entry);
                    progress(99, 'Storing the result');
                    rec.media = await media.upload({ path: local, name: rec.name, mime: rec.mime, size, sha256, owner: row.owner, jobId: row.id, service: o.service, type: row.type, namespace: projectNamespace(media, row) });
                    rec.storage = 'media';
                    delete rec._path;
                    await fsp.unlink(local).catch(() => {});
                } catch (err) {
                    // The result is still here; say where it is rather than pretending it reached Media.
                    log.error(`[Jobs] Media upload failed for ${row.id}:`, err.message);
                    rec.media_error = 'Could not store the result in OpenVibe.Media; it is kept on this server until the job expires';
                }
            }
            files.push(rec);
        }
        return { files, data: out.data && typeof out.data === 'object' ? out.data : {} };
    }

    async function dropResult(result) {
        for (const f of (result && result.files) || []) {
            if (f._path) await fsp.unlink(f._path).catch(() => {});
            if (f.media && media) await media.remove(f.media.media_id).catch(() => {});
        }
    }

    // ── Cancel ─────────────────────────────────────────────────
    /** → { job, changed } — queued jobs end at once; running ones are signalled and end as cancelled. */
    function cancel(id) {
        const row = store.get(id);
        if (!row) return null;
        if (TERMINAL.includes(row.state)) return { job: row, changed: false };
        if (row.state === 'queued') {
            const done = store.transaction(() => store.requestCancel(id) && store.finish(id, { state: 'cancelled', error: problem(409, 'tools.job.cancelled', 'The job was cancelled before it started') }))();
            if (done) {
                emit(id, 'job.cancelled');
                fsp.rm(jobDir(id), { recursive: true, force: true }).catch(() => {});
            }
            return { job: store.get(id), changed: done };
        }
        store.requestCancel(id);
        const entry = active.get(id);
        if (entry && !entry.reason) { entry.reason = 'cancel'; entry.ctrl.abort(new Error('cancelled')); }
        emit(id, 'job.cancel_requested');
        return { job: store.get(id), changed: true };
    }

    // ── Retry ──────────────────────────────────────────────────
    /**
     * Retry a failed job as a new job with the same type, input, files and lifetime.
     * → { job, replayed } | null (no such job). Idempotent: a failed job is retried once, and asking
     * again returns that retry, whatever state it is in now. Only failed jobs can be retried.
     * Everything up to the insert is synchronous, so two concurrent calls cannot both retry it.
     */
    function retry(id) {
        const row = store.get(id);
        if (!row) return null;
        if (row.retried_by) {
            const next = store.get(row.retried_by);
            if (next) return { job: next, replayed: true };
            throw new JobError(410, 'tools.job.retry_gone', 'This job was retried and the retry has since expired', { retried_by: row.retried_by });
        }
        if (row.state !== 'failed') throw new JobError(409, 'tools.job.not_failed', `Only failed jobs can be retried; this one is ${row.state}`, { state: row.state });
        if (stopped) throw new JobError(503, 'tools.job.unavailable', 'The job system is shutting down');
        const def = types.get(row.type);
        if (!def) throw new JobError(409, 'tools.job.unknown_type', `This service no longer runs "${row.type}" jobs`);
        const limit = row.env === 'sandbox' ? Math.min(SANDBOX_MAX_ACTIVE, maxActivePerOwner) : maxActivePerOwner;
        if (store.activeForOwner(row.owner) >= limit) throw new JobError(429, 'tools.job.too_many_active', `At most ${limit} unfinished jobs at a time; wait for one to finish or cancel one`);
        const inputs = store.parse(row.files_json, []);
        if (inputs.some(f => !f._path || !fs.existsSync(f._path))) throw new JobError(410, 'tools.job.inputs_gone', 'The input files of this job are no longer kept; submit it again');

        const next = `job_${contracts.ids.ulid()}`;
        const oldIn = path.join(jobDir(row.id), 'in');
        const newIn = path.join(jobDir(next), 'in');
        let moved = false;
        if (inputs.length) {
            fs.mkdirSync(jobDir(next), { recursive: true });
            fs.renameSync(oldIn, newIn);   // same directory tree, so one atomic rename
            moved = true;
        }
        const stored = inputs.map(f => ({ ...f, _path: path.join(newIn, path.basename(f._path)) }));
        try {
            store.transaction(() => {
                if (!store.markRetried(row.id, next)) throw new JobError(409, 'tools.job.not_failed', 'This job cannot be retried any more');
                store.insert({
                    id: next, type: row.type, type_version: def.version, owner: row.owner, input_json: row.input_json, files_json: JSON.stringify(stored),
                    idempotency_key: null, request_hash: row.request_hash, max_attempts: def.maxAttempts, ttl_ms: row.ttl_ms, now: Date.now(),
                    env: row.env, retry_of: row.id, ip_key: row.ip_key || null, tool: row.tool || null, project_id: row.project_id || null,
                });
                announce.created(store.get(next));
            })();
        } catch (err) {
            if (moved) { try { fs.renameSync(newIn, oldIn); } catch { /* best effort */ } }
            fs.rmSync(jobDir(next), { recursive: true, force: true });
            throw err;
        }
        emit(next, 'job.queued');
        kick();
        return { job: store.get(next), replayed: false };
    }

    // ── References (results something still points at) ─────────
    function checkRef(ref) {
        if (!REF_RE.test(String(ref || '')) || String(ref).length > 200) {
            throw new JobError(400, 'tools.job.invalid', 'A reference is <service>:<kind>:<id>, e.g. community:paste:p_123 (at most 200 characters)');
        }
        return String(ref);
    }
    /**
     * Keep a succeeded job's result while `ref` points at it. → { job, created }. Idempotent.
     */
    function reference(id, ref) {
        ref = checkRef(ref);
        const row = store.get(id);
        if (!row) return null;
        if (row.state !== 'succeeded') throw new JobError(409, 'tools.job.not_succeeded', `Only a succeeded job's result can be referenced; this one is ${row.state}`, { state: row.state });
        if (row.env === 'sandbox') throw new JobError(409, 'tools.job.sandbox', 'Sandbox results are kept briefly and cannot be referenced');
        const has = store.references(id).some(r => r.ref === ref);
        if (!has && store.referenceCount(id) >= MAX_REFS) throw new JobError(409, 'tools.job.too_many_references', `At most ${MAX_REFS} references per job`);
        const created = store.addReference(id, ref);
        return { job: store.get(id), created };
    }
    /** Stop keeping the result for `ref`. → { job, removed }. Idempotent. */
    function unreference(id, ref) {
        ref = checkRef(ref);
        if (!store.get(id)) return null;
        const removed = store.dropReference(id, ref);
        return { job: store.get(id), removed };
    }

    // ── Boot recovery, pruning ─────────────────────────────────
    /** A job the restart ended as failed: the row and its tools.job.failed event in one transaction. */
    function failRecovered(id, outcome) {
        store.transaction(() => { if (store.finish(id, outcome)) ended(id); })();
    }

    function recover() {
        let requeued = 0, failed = 0;
        for (const row of store.running()) {
            const def = types.get(row.type);
            if (row.cancel_requested) {
                store.finish(row.id, { state: 'cancelled', error: problem(409, 'tools.job.cancelled', 'The job was cancelled') });
                emit(row.id, 'job.cancelled');
            } else if (!def) {
                failRecovered(row.id, { state: 'failed', error: problem(500, 'tools.job.unknown_type', `This service no longer runs "${row.type}" jobs`) });
                emit(row.id, 'job.failed'); failed++;
            } else if (def.onRestart === 'requeue' && row.attempts < row.max_attempts) {
                store.requeue(row.id);
                emit(row.id, 'job.queued'); requeued++;
            } else {
                const retryable = def.onRestart === 'fail';
                failRecovered(row.id, {
                    state: 'failed', retryable,
                    error: problem(503, 'tools.job.interrupted', retryable ? 'The service restarted while this job was running; submit it again' : `The service restarted during each of ${row.attempts} attempts`),
                });
                emit(row.id, 'job.failed'); failed++;
            }
            fs.rmSync(path.join(jobDir(row.id), 'out'), { recursive: true, force: true });
        }
        // Directories without a row: a crash between moving the upload and recording the job.
        // That job was never accepted (no 202 went out), so its files have no owner.
        for (const name of fs.readdirSync(root)) {
            if (/^job_[0-9A-Z]{26}$/.test(name) && !store.get(name)) fs.rmSync(path.join(root, name), { recursive: true, force: true });
        }
        return { requeued, failed };
    }

    /**
     * Delete expired jobs. Referenced jobs are never expired (store.expired skips them). A job whose
     * Media objects cannot all be deleted — Media keeps one under a retention hold (409
     * media.object.held), Media is unreachable, or this process no longer has Media configured —
     * is kept, record and all, and looked at again after PRUNE_RECHECK_MS: dropping the record
     * would leave an object nobody deletes, and a held object is one somebody still needs.
     */
    async function prune(now = Date.now()) {
        let n = 0;
        for (const row of store.expired(now)) {
            const result = store.parse(row.result_json, null);
            let kept = null;
            for (const f of (result && result.files) || []) {
                if (!f.media || !f.media.media_id) continue;
                if (!media) { kept = 'results in OpenVibe.Media, but Media is not configured here'; continue; }
                try { await media.remove(f.media.media_id); } catch (err) {
                    kept = err.code === 'media.object.held' ? `${f.media.media_id} is under a retention hold` : `could not delete ${f.media.media_id}: ${err.message}`;
                }
            }
            if (kept) {
                log.warn(`[Jobs] kept expired job ${row.id} (${kept}); checking again later`);
                store.deferExpiry(row.id, now + PRUNE_RECHECK_MS);
                continue;
            }
            await fsp.rm(jobDir(row.id), { recursive: true, force: true }).catch(() => {});
            store.remove(row.id);
            listeners.delete(row.id);
            n++;
        }
        return n;
    }

    // ── Host-wide bounds ───────────────────────────────────────
    /** Bytes under <dataDir>/jobs (inputs and results), walked in the background at most every 30 s. */
    async function scanDisk() {
        let total = 0;
        const walk = async (dir) => {
            let entries = [];
            try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
            for (const e of entries) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) await walk(p);
                else if (e.isFile()) { try { total += (await fsp.stat(p)).size; } catch { /* gone meanwhile */ } }
            }
        };
        await walk(root);
        disk.bytes = total;
        disk.at = Date.now();
        return total;
    }
    function refreshDisk() {
        if (!disk.scanning) disk.scanning = scanDisk().catch(() => disk.bytes).finally(() => { disk.scanning = null; });
        return disk.scanning;
    }

    /**
     * Is the store over its bounds? → null, or { reason: 'queue'|'disk', detail, retryAfter } for a
     * 503 tools.busy. Cheap: one COUNT and the last disk walk (a stale walk is refreshed in the background).
     */
    function busy() {
        if (maxQueued) {
            const queued = store.counts().queued || 0;
            if (queued >= maxQueued) return { reason: 'queue', detail: `${queued} jobs are already waiting on this server; try again in a minute.`, retryAfter: 60, queued, limit: maxQueued };
        }
        if (diskBudget) {
            if (Date.now() - disk.at > 30_000) refreshDisk();
            if (disk.bytes >= diskBudget) return { reason: 'disk', detail: 'This server is holding as many files as it can right now; try again in a few minutes.', retryAfter: 300, bytes: disk.bytes, limit: diskBudget };
        }
        return null;
    }

    /**
     * Browser sessions from one address together have maxActivePerAddress unfinished jobs: → null, or
     * { active, limit } when a new session job from `ipKey` would pass it (the HTTP layer answers 429
     * tools.job.too_many_active through the guard). Principals and people are bounded per owner only.
     */
    function addressFull(owner, ipKey) {
        if (!ipKey || !String(owner || '').startsWith('session:')) return null;
        const active = store.activeForIp(ipKey);
        return active >= maxActivePerAddress ? { active, limit: maxActivePerAddress } : null;
    }

    function start() {
        if (started) return api;
        started = true;
        if (diskBudget) refreshDisk();
        const r = recover();
        if (r.requeued || r.failed) log.log(`[Jobs] ${o.service}: ${r.requeued} job(s) re-queued, ${r.failed} failed after restart`);
        prune().catch(() => {});
        flushUsage();
        pruneTimer = setInterval(() => {
            prune().catch(err => log.error('[Jobs] prune:', err.message));
            flushUsage();
        }, o.pruneIntervalMs || 5 * 60 * 1000);
        if (pruneTimer.unref) pruneTimer.unref();
        kick();
        return api;
    }

    /**
     * Stop. Running jobs are left as they are in the database ('running'), which is exactly what a
     * crash or a restart leaves behind; the next start() recovers them per type.
     */
    /** Closed hours of project usage → the outbox (./usage.js); a failure is logged and retried next tick. */
    function flushUsage(at) {
        try { return usage.flush(at); } catch (err) { log.error('[Jobs] usage flush:', err.message); return { queued: 0, invalid: 0 }; }
    }

    function stop() {
        stopped = true;
        if (pruneTimer) clearInterval(pruneTimer);
        for (const entry of active.values()) { entry.reason = entry.reason || 'shutdown'; entry.ctrl.abort(new Error('shutdown')); }
        listeners.clear();
        for (const fn of [...stopHooks]) { try { fn(); } catch { /* best effort */ } }
        stopHooks.clear();
    }
    /** Run fn when the system stops; → a function that removes it. */
    function onStop(fn) { stopHooks.add(fn); return () => stopHooks.delete(fn); }

    /** The owner's succeeded job with a result file stored as Media object `mediaId` → { row, index } or null. */
    function findResultMedia(owner, mediaId) {
        for (const row of store.byResultMedia(owner, mediaId)) {
            const files = (store.parse(row.result_json, null) || {}).files || [];
            const index = files.findIndex(f => f.media && f.media.media_id === mediaId);
            if (index >= 0) return { row, index };
        }
        return null;
    }

    /** Where a result file's bytes are: { local: path } or { media: MediaRef }. */
    function resultFile(row, n) {
        const result = store.parse(row.result_json, null);
        const f = result && result.files && result.files[n];
        if (!f) return null;
        return { name: f.name, mime: f.mime, size: f.size, storage: f.storage, media: f.media || null, path: f._path || null };
    }

    const api = {
        define, submit, cancel, retry, reference, unreference, subscribe, start, stop, onStop, prune, recover, view, resultFile, findResultMedia,
        busy, refreshDisk, addressFull, bounds: { maxQueued, diskBudgetBytes: diskBudget, maxActivePerAddress },
        get: (id) => store.get(id),
        service: o.service,
        eventsAfter: (id, seq) => store.eventsAfter(id, seq),
        lastSeq: (id) => store.lastSeq(id),
        types: () => [...types.keys()],
        media,
        // running (after the spread) is the store's count of rows in 'running'; executing is this process's.
        stats: () => ({ running: active.size, concurrency, ...store.counts(), executing: active.size, results: media ? 'media' : 'local', events: announce.status(), usage: usage.enabled ? usage.status() : { enabled: false } }),
        usage, flushUsage,
        outbox: o.outbox || null,
        /** True between start() and stop(): the worker picks up queued jobs. */
        isRunning: () => started && !stopped,
        store,
        JobError,
    };
    return api;
}

module.exports = { createJobSystem, JobError, canonical, TERMINAL };
