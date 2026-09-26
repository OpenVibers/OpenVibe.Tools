'use strict';
// ═══════════════════════════════════════════════════════════════
// The uniform run API (ADR-027; openvibe-contracts tools.run-request@1 → tools.run@1):
//
//   POST /api/v1/tools/:id/run
//
// Body: JSON { input, files, wait_ms, idempotency_key } (tools.run-request@1), or multipart/form-data
// with the uploads as `file` (or `files`) file parts and the other fields as text parts: `input` (JSON
// text), `files` (the file references' JSON), `wait_ms`, `idempotency_key` — exactly what
// openvibe-sdk/tools v0.6.0 sends. ?wait_ms= on the query does the same as the field; the
// Idempotency-Key header wins over idempotency_key.
//
// Answers (tools.run@1):
//   200 { state: succeeded, tool, result: { data | text | files }, took_ms[, job] }
//   200 { state: failed | cancelled, tool, error (problem+json), took_ms[, job] }   the tool's own failure
//   202 { state: queued | running, tool, job, location } + Location     a job still going after wait_ms
//   200 + Idempotent-Replayed: true                                      the same key and request again
// Refusals before the tool runs are problem+json: 400 tools.run.invalid, 401 token.missing |
// tools.session_required, 403 capability.denied | tools.origin.refused, 404 tools.tool.not_found |
// tools.tool.not_runnable (api false, e.g. the YouTube downloader) | tools.run.file_not_found,
// 409 tools.job.idempotency_conflict, 413 tools.file.too_large | tools.input.too_large,
// 415 tools.file.unsupported_type, 422 tools.input.invalid (errors[] with JSON pointers),
// 429 tools.quota.exceeded (Retry-After), 503 tools.tool.unavailable (the descriptor's status is
// unavailable), 503 tools.unavailable (a program the tool needs is missing), 503 tools.busy.
//
// Who may run what (always enforced, whatever TOOLS_GUARD says, because it is authorization, not a
// quota): an app or service token needs the tool's auth.capability (tools.tool.run, or tools.net.probe
// for the network probes, which nobody else runs through the API: people keep the probe pages); a
// tool with auth.anonymous false needs a browser session, a sign-in or a token. Quotas (the tool's
// quotaClass × the caller's tier, weighted by its cost), the Origin check on cookie-authenticated
// calls and the job bounds follow the guard's mode; the per-target throttle and upload sniffing are
// hard limits in both.
//
// Where a tool runs is the app's business (o.runs): inline (in this process — the gateway's net and
// dev routes, and the dev and text engines in a worker pool), as a job of this satellite's job system,
// or forwarded (o.proxy: the gateway streams a job tool's run to the satellite that owns it).
// Inline answers are cached per tool where that is safe (o.cacheTtl: pure transforms and slow-moving
// lookups; never a probe, a random generator or the caller's own address). An inline run's
// Idempotency-Key replays its first answer for 15 minutes; a job tool's key is the job's.
//
// Like the rest of apps/_shared this has no dependencies: the app passes its guard, contracts, an
// input validator (createInputValidator with the Ajv it has) and, on a satellite, multer.
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { canonical } = require('../jobs/system');

const RUN_RE = /^\/api\/v1\/tools\/([a-z][a-z0-9-]{0,39})\/run\/?$/;
const FIELDS = new Set(['input', 'files', 'wait_ms', 'idempotency_key']);
const KEY_RE = /^[\x21-\x7e]{8,200}$/;
const MEDIA_ID_RE = /^med_[0-9A-HJKMNP-TV-Z]{26}$/;
const JOB_ID_RE = /^job_[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_WAIT_MS = 60_000;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const REPLAY_TTL_MS = 15 * 60 * 1000;

const isRunPath = (p) => RUN_RE.test(String(p || ''));

/** Run Express middleware in order (the apps' older limiters) → true when every one called next(). */
async function passes(list, req, res) {
    for (const mw of list || []) {
        const ok = await new Promise((resolve) => {
            let settled = false;
            const done = (v) => { if (!settled) { settled = true; res.removeListener('finish', onFinish); resolve(v); } };
            const onFinish = () => done(false);
            res.once('finish', onFinish);
            try { mw(req, res, (err) => done(!err)); } catch { done(false); }
        });
        if (!ok || res.headersSent) return false;
    }
    return true;
}

/** A refusal before the tool ran: answered as problem+json, not as a run. */
class Refusal extends Error {
    constructor(status, code, detail, extra, headers) { super(detail || code); this.status = status; this.code = code; this.detail = detail; this.extra = extra; this.headers = headers; this.refusal = true; }
}

// ── Input validation (the tool's own JSON Schema) ────────────

/**
 * @param {Function} Ajv          ajv/dist/2020 (from the app: openvibe-contracts brings it)
 * @param {Function} [addFormats] ajv-formats
 * @returns {(d, input) => { path, message }[]}
 */
function createInputValidator(Ajv, addFormats) {
    const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true, logger: false });
    if (addFormats) addFormats(ajv);
    const compiled = new Map();   // id → { sig, fn, schema }
    return function validate(d, input) {
        if (!d.input || typeof d.input !== 'object') return [];
        const sig = JSON.stringify(d.input);
        let v = compiled.get(d.id);
        if (!v || v.sig !== sig) {
            if (v && v.schema) { try { ajv.removeSchema(v.schema); } catch { /* not registered */ } }
            const schema = { ...d.input };
            delete schema.$id;
            v = { sig, schema, fn: ajv.compile(schema) };
            compiled.set(d.id, v);
        }
        if (v.fn(input)) return [];
        return (v.fn.errors || []).slice(0, 20).map((e) => {
            if (e.keyword === 'additionalProperties') return { path: `${e.instancePath}/${e.params.additionalProperty}`, message: 'is not a field of this tool' };
            if (e.keyword === 'required') return { path: `${e.instancePath}/${e.params.missingProperty}`, message: 'is required' };
            return { path: e.instancePath || '/', message: e.message || 'is not valid' };
        });
    };
}

// ── Answers kept for a while ─────────────────────────────────

/** A TTL + LRU map bounded by entries and bytes (the inline cache, inline Idempotency-Key replays). */
function createTtlStore({ maxEntries = 2000, maxBytes = 32 * 1024 * 1024, now = Date.now } = {}) {
    const map = new Map();   // key → { value, size, until }
    let bytes = 0, hits = 0, misses = 0;
    const drop = (k) => { const e = map.get(k); if (e) { bytes -= e.size; map.delete(k); } };
    return {
        get(k) {
            const e = map.get(k);
            if (!e) { misses++; return undefined; }
            if (e.until <= now()) { drop(k); misses++; return undefined; }
            map.delete(k); map.set(k, e);   // most recently used last
            hits++;
            return e.value;
        },
        set(k, value, ttlMs, size) {
            if (!(ttlMs > 0)) return false;
            const n = size || Buffer.byteLength(JSON.stringify(value));
            if (n > maxBytes / 8) return false;          // one answer never takes a big share
            drop(k);
            map.set(k, { value, size: n, until: now() + ttlMs });
            bytes += n;
            while (map.size > maxEntries || bytes > maxBytes) drop(map.keys().next().value);
            return true;
        },
        stats: () => ({ entries: map.size, bytes, hits, misses }),
        clear() { map.clear(); bytes = 0; },
    };
}

// ── Request parsing ──────────────────────────────────────────

function toInt(v) {
    if (v === undefined || v === null || v === '') return undefined;
    const n = typeof v === 'number' ? v : Number(String(v).trim());
    return Number.isInteger(n) ? n : NaN;
}

/** tools.run-request@1 from req.body (JSON, or multipart text fields) and the query → fields, or throws Refusal. */
function readRequest(req, multipart) {
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
    if (!b && req.body != null && req.body !== '') throw new Refusal(400, 'tools.run.invalid', 'The body is a JSON object (tools.run-request@1), or multipart/form-data.');
    const body = b || {};
    for (const k of Object.keys(body)) if (!FIELDS.has(k)) throw new Refusal(400, 'tools.run.invalid', `Unknown field "${k}": a run request has input, files, wait_ms and idempotency_key.`);
    const parseJson = (name, v, dflt) => {
        if (!multipart || typeof v !== 'string') return v === undefined ? dflt : v;
        if (!v.trim()) return dflt;
        try { return JSON.parse(v); } catch { throw new Refusal(400, 'tools.run.invalid', `The ${name} part must be JSON.`); }
    };
    const input = parseJson('input', body.input, {});
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Refusal(400, 'tools.run.invalid', 'input is a JSON object.');
    const refs = parseJson('files', body.files, []);
    if (!Array.isArray(refs) || refs.length > 50) throw new Refusal(400, 'tools.run.invalid', 'files is an array of at most 50 references ({ media_id } or { job_id, index }).');
    for (const r of refs) {
        const okMedia = r && typeof r === 'object' && Object.keys(r).length === 1 && MEDIA_ID_RE.test(String(r.media_id || ''));
        const okJob = r && typeof r === 'object' && Object.keys(r).length === 2 && JOB_ID_RE.test(String(r.job_id || '')) && Number.isInteger(r.index) && r.index >= 0 && r.index <= 99;
        if (!okMedia && !okJob) throw new Refusal(400, 'tools.run.invalid', 'A files reference is { media_id: "med_…" } or { job_id: "job_…", index: 0..99 }.');
    }
    let wait = toInt(body.wait_ms);
    if (wait === undefined) wait = toInt(req.query && req.query.wait_ms);
    if (wait === undefined) wait = 0;
    if (!Number.isInteger(wait) || wait < 0 || wait > MAX_WAIT_MS) throw new Refusal(400, 'tools.run.invalid', `wait_ms is an integer, 0..${MAX_WAIT_MS}.`);
    const header = req.headers['idempotency-key'];
    const key = header != null && header !== '' ? String(header) : body.idempotency_key != null && body.idempotency_key !== '' ? String(body.idempotency_key) : null;
    if (key != null && !KEY_RE.test(key)) throw new Refusal(400, 'tools.run.invalid', 'Idempotency-Key is 8-200 printable ASCII characters.');
    return { input, refs, wait, key };
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/**
 * @param {object} o
 * @param {object} o.guard          apps/_shared/guard
 * @param {object} o.contracts      openvibe-contracts
 * @param {() => object} o.snapshot the registry: { tools: [descriptor], gone: Map }
 * @param {(d, input) => object[]} o.validate
 * @param {(d) => 'inline'|'job'|null} o.runs     what this app runs itself
 * @param {(d, input, ctx) => Promise<{data}|{text}>} [o.inline]   ctx: { req, res, caller, signal, timeoutMs }
 * @param {(d) => number} [o.cacheTtl]              ms an inline answer may be reused (0 = never)
 * @param {(d, input) => string|null} [o.targetOf] the host an egress tool reaches (per-target throttle)
 * @param {(d, req, res) => boolean} [o.proxy]     forwards the run elsewhere (the gateway)
 * @param {Function} [o.parseJson]                 JSON body parser middleware, when the app has not run one
 * @param {object} [o.jobs]                        a satellite's jobs: { system: () => system, receive: (d) => middleware,
 *                                                 fetchSibling: (ref, req) → file | null }
 * @param {object} [o.log]
 */
function createRunApi(o) {
    const { guard, contracts } = o;
    const log = o.log || console;
    const cache = createTtlStore({ maxEntries: 5000, maxBytes: 64 * 1024 * 1024 });
    const replays = createTtlStore({ maxEntries: 20000, maxBytes: 32 * 1024 * 1024 });
    const counts = { runs: 0, inline: 0, jobs: 0, proxied: 0, refused: 0, failed: 0, cached: 0, replayed: 0 };

    function problem(req, res, status, code, detail, extra, headers) {
        counts.refused++;
        if (headers) for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
        res.setHeader('Cache-Control', 'no-store');
        return contracts.http.sendProblem(res, status, code, { detail, extra, ctx: req.ov });
    }
    const send = (res, status, body, headers = {}) => {
        res.setHeader('Cache-Control', 'no-store');
        for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
        res.status(status).json(body);
    };
    const toolProblem = (req, err, fallbackStatus = 422) => {
        const status = Number.isInteger(err.status) && err.status >= 400 && err.status <= 599 ? err.status : fallbackStatus;
        const code = /^tools\.[a-z0-9_.]+$/.test(String(err.code || '')) ? err.code : 'tools.job.failed';
        const detail = String(err.detail || err.message || 'The tool failed').replace(/(?:\/[\w.-]+){2,}/g, '[file]').slice(0, 500);
        return contracts.http.problem(status, code, { detail, ctx: req.ov });
    };

    // ── Who may run it (always enforced) ─────────────────────
    function authorize(req, res, d) {
        const c = guard.caller(req, res);
        const cap = (d.auth && d.auth.capability) || 'tools.tool.run';
        const probe = cap === 'tools.net.probe';
        // A token that does not verify (expired, another audience) is an error here, not anonymity:
        // the client refreshes it instead of running as nobody.
        if (/^Bearer\s+\S/i.test(String(req.headers.authorization || '')) && c.kind !== 'principal' && c.kind !== 'user') {
            throw new Refusal(401, 'token.invalid', 'The Bearer token was not accepted (expired, not for openvibe.tools, or not signed by the Network).');
        }
        if (c.kind === 'principal') {
            if (!guard.tokens.hasCapability(c.claims, cap, contracts)) {
                guard.record(req, c, { reason: 'capability', tool: d.id, enforced: true });
                throw new Refusal(403, 'capability.denied', `${cap} not granted to this token`);
            }
            return c;
        }
        if (probe) {
            guard.record(req, c, { reason: 'capability', tool: d.id, enforced: true });
            if (c.kind === 'user') throw new Refusal(403, 'capability.denied', `Network probes run through the API only for apps and services holding ${cap}; people use the tool's page.`);
            throw new Refusal(401, 'token.missing', `${d.id} runs through the API only with a token holding ${cap}; people use the tool's page.`);
        }
        if (d.auth && d.auth.anonymous === false && c.kind === 'anonymous') {
            guard.record(req, c, { reason: 'session', tool: d.id, enforced: true });
            throw new Refusal(401, 'tools.session_required', `${d.id} needs a browser session (open its page first), a sign-in or an API token.`);
        }
        // A person running a tool through the API counts in their recent tools (tools.usage).
        if (c.kind === 'user' && c.claims && c.claims.subject_id) { try { require('../usage').recorder().record(c.claims.subject_id, d.id); } catch { /* best-effort */ } }
        return c;
    }

    function answerRefusal(req, res, err) {
        if (res.headersSent) return undefined;
        return problem(req, res, err.status, err.code, err.detail, err.extra, err.headers);
    }

    // ── Inline tools ─────────────────────────────────────────
    async function runInline(req, res, d, c, fields, t0) {
        counts.inline++;
        const { input, key } = fields;
        const reqHash = sha(canonical({ tool: d.id, input }));
        const replayKey = key ? `${c.key}|${key}` : null;
        if (replayKey) {
            const prior = replays.get(replayKey);
            if (prior) {
                if (prior.hash !== reqHash) throw new Refusal(409, 'tools.job.idempotency_conflict', 'This Idempotency-Key was used for a different request');
                counts.replayed++;
                return send(res, 200, prior.body, { 'Idempotent-Replayed': 'true' });
            }
        }
        const ttl = o.cacheTtl ? o.cacheTtl(d) : 0;
        const cacheKey = ttl > 0 ? `${d.id}|${reqHash}` : null;
        let result = cacheKey ? cache.get(cacheKey) : undefined;
        let body;
        if (result !== undefined) {
            counts.cached++;
            res.setHeader('X-OV-Cache', 'hit');
            body = { state: 'succeeded', tool: d.id, result, took_ms: Date.now() - t0 };
        } else {
            // A tool that reaches a host the caller chose: that host's minute is shared by everyone (hard).
            const target = o.targetOf ? o.targetOf(d, input) : null;
            if (target && d.limits && d.limits.perTargetPerMinute && !guard.target(req, res, { tool: d.id, target })) return undefined;
            const ac = new AbortController();
            const onClose = () => { if (!res.writableFinished) ac.abort(); };
            res.on('close', onClose);
            const timeoutMs = (d.limits && d.limits.timeoutMs) || 15000;
            let timer;
            try {
                const out = await Promise.race([
                    o.inline(d, input, { req, res, caller: c, signal: ac.signal, timeoutMs }),
                    new Promise((_, reject) => { timer = setTimeout(() => { ac.abort(); reject(Object.assign(new Error(`The tool ran longer than ${Math.round(timeoutMs / 1000)} s`), { status: 504, code: 'tools.run.timeout' })); }, timeoutMs + 250); }),
                ]);
                result = out && out.text !== undefined ? { text: String(out.text) } : { data: out && out.data && typeof out.data === 'object' ? out.data : {} };
                if (cacheKey) cache.set(cacheKey, result, ttl);
                body = { state: 'succeeded', tool: d.id, result, took_ms: Date.now() - t0 };
            } catch (err) {
                if (err && err.refusal) throw err;
                if (res.headersSent) return undefined;   // a guard refusal inside the tool already answered
                counts.failed++;
                body = { state: 'failed', tool: d.id, error: toolProblem(req, err), took_ms: Date.now() - t0 };
            } finally {
                clearTimeout(timer);
                res.removeListener('close', onClose);
            }
        }
        if (replayKey) replays.set(replayKey, { hash: reqHash, body }, REPLAY_TTL_MS);
        return send(res, 200, body);
    }

    // ── Job tools (a satellite's own job system) ─────────────
    const uploadsOf = (req) => (Array.isArray(req.files) ? req.files : req.files && typeof req.files === 'object' ? Object.values(req.files).flat() : []);

    async function tempCopy(from, name, mime, dir) {
        const to = path.join(dir, `run-${crypto.randomBytes(12).toString('hex')}${path.extname(String(name || '')).slice(0, 9)}`);
        await fsp.copyFile(from, to);
        return { path: to, name, mime, size: (await fsp.stat(to)).size };
    }

    /** A file reference → a temporary input file the job will own, or throws 404 tools.run.file_not_found. */
    async function resolveRef(req, ref, owner, dir) {
        const system = o.jobs.system();
        const notFound = () => new Refusal(404, 'tools.run.file_not_found', `${ref.media_id || `${ref.job_id} file ${ref.index}`} is not a file you can read here: a result of one of your own Tools jobs that has not expired.`);
        let row = null, index = ref.index;
        if (ref.job_id) {
            row = system.get(ref.job_id);
            if (!row && o.jobs.fetchSibling) {
                const got = await o.jobs.fetchSibling(ref, req, dir);
                if (got) return got;
                throw notFound();
            }
        } else {
            const hit = system.findResultMedia(owner, ref.media_id);
            if (hit) { row = hit.row; index = hit.index; }
        }
        if (!row || row.owner !== owner || row.state !== 'succeeded') throw notFound();
        const f = system.resultFile(row, index);
        if (!f) throw notFound();
        if (f.path && fs.existsSync(f.path)) return tempCopy(f.path, f.name, f.mime, dir);
        if (f.storage === 'media' && f.media && system.media) {
            const signed = await system.media.downloadUrl(f.media.media_id);
            const up = await fetch(signed.internal_url, { signal: AbortSignal.timeout(120_000) });
            if (!up.ok) throw notFound();
            const to = path.join(dir, `run-${crypto.randomBytes(12).toString('hex')}`);
            await fsp.writeFile(to, Buffer.from(await up.arrayBuffer()));
            return { path: to, name: f.name, mime: f.mime, size: (await fsp.stat(to)).size };
        }
        throw notFound();
    }

    function waitFor(system, id, ms, res) {
        return new Promise((resolve) => {
            const row = system.get(id);
            if (!row || TERMINAL.has(row.state) || ms <= 0) return resolve();
            let done = false;
            const finish = () => { if (done) return; done = true; clearTimeout(timer); off(); res.removeListener('close', finish); resolve(); };
            const off = system.subscribe(id, (e) => { if (TERMINAL.has(e.data.state)) finish(); });
            const timer = setTimeout(finish, ms);
            res.on('close', finish);
            // It may have finished between the first read and the subscription.
            const again = system.get(id);
            if (!again || TERMINAL.has(again.state)) finish();
        });
    }

    function runView(system, d, row) {
        const job = system.view(row);
        const took = row.finished_at ? Math.max(0, row.finished_at - row.created_at) : 0;
        if (row.state === 'succeeded') return { state: 'succeeded', tool: d.id, result: { data: (job.result && job.result.data) || {}, files: (job.result && job.result.files) || [] }, took_ms: took, job };
        if (row.state === 'failed' || row.state === 'cancelled') return { state: row.state, tool: d.id, error: job.error || contracts.http.problem(500, 'tools.job.failed', { detail: 'The job failed' }), took_ms: took, job };
        return { state: row.state, tool: d.id, job, location: job.links.self };
    }

    async function runJob(req, res, d, c, fields, uploads) {
        counts.jobs++;
        const system = o.jobs.system();
        const { input, refs, wait, key } = fields;
        const dir = o.jobs.uploadsDir;
        const files = uploads.map(f => ({ path: f.path, buffer: f.path ? undefined : f.buffer, name: f.originalname, mime: f.mimetype, size: f.size, originalname: f.originalname, mimetype: f.mimetype }));
        const cleanup = () => { for (const f of files) if (f.path) fs.unlink(f.path, () => {}); };
        try {
            // The owner: a person, a principal, or this browser's session (started now when there is none).
            const who = guard.resolveCaller(req, res, { create: true });
            const owner = who.owner;
            if (!owner) throw new Refusal(401, 'tools.session_required', `${d.id} needs a browser session, a sign-in or an API token.`);
            for (const ref of refs) files.push(await resolveRef(req, ref, owner, dir));
            const spec = d.files;
            if (!spec && files.length) throw new Refusal(400, 'tools.run.invalid', `${d.id} takes no files.`);
            if (spec && (files.length < spec.min || files.length > spec.max)) {
                throw new Refusal(400, 'tools.run.invalid', `${d.id} takes ${spec.min === spec.max ? spec.min : `${spec.min} to ${spec.max}`} file${spec.max === 1 ? '' : 's'}; this request has ${files.length}.`);
            }
            if (spec && spec.maxBytes) {
                const big = files.find(f => (f.size || 0) > spec.maxBytes);
                if (big) throw new Refusal(413, 'tools.file.too_large', `${big.name} is over ${Math.round(spec.maxBytes / 1024 / 1024)} MB, the limit for ${d.id}.`);
            }
            // The bytes against files.accept (hard; a misleading name or type is corrected).
            if (spec && !guard.checkFiles(req, res, files, spec.accept, d.id)) return undefined;
            // Sessions from one address share a bound on unfinished jobs; the store's queue and disk bounds.
            const full = system.addressFull ? system.addressFull(owner, who.ipKey) : null;
            if (full && guard.refuse(req, res, { status: 429, code: 'tools.job.too_many_active', reason: 'jobs.address', tool: d.id, retryAfter: 30, detail: `At most ${full.limit} unfinished jobs from one address at a time; wait for one to finish.`, extra: { scope: 'address' } })) return undefined;
            const busy = system.busy ? system.busy() : null;
            if (busy && !guard.jobsBusy(req, res, busy, d.id)) return undefined;
            let row, replayed;
            try {
                const out = await system.submit({
                    owner, type: d.run.job.type, input: contracts.tools.jobInput(d, input),
                    files: files.map(f => ({ path: f.path, buffer: f.buffer, name: f.originalname || f.name, mime: f.mimetype || f.mime, size: f.size })),
                    idempotencyKey: key, ttlMs: who.kind === 'session' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000,
                    env: who.env || 'production', ipKey: who.ipKey, tool: d.id,
                    project: who.kind === 'principal' && who.claims && who.claims.actor_type === 'app' ? who.claims.project_id : null,
                });
                row = out.job; replayed = out.replayed;
            } catch (err) {
                if (err instanceof system.JobError) throw new Refusal(err.status, err.code, err.detail, err.extra);
                throw err;
            }
            files.length = 0;   // the job owns them now
            if (wait > 0) await waitFor(system, row.id, wait, res);
            const fresh = system.get(row.id) || row;
            const body = runView(system, d, fresh);
            const headers = replayed ? { 'Idempotent-Replayed': 'true' } : {};
            if (body.location) headers.Location = body.location;
            return send(res, replayed || !body.location ? 200 : 202, body, headers);
        } finally {
            cleanup();
        }
    }

    // ── The route ────────────────────────────────────────────
    async function handle(req, res, next) {
        const m = RUN_RE.exec(req.path);
        if (!m) return next();
        if (req.method === 'OPTIONS') return next();   // the app's CORS answers preflights
        if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return problem(req, res, 405, 'method_not_allowed', 'POST a tools.run-request@1 to run a tool.'); }
        const t0 = Date.now();
        counts.runs++;
        const snap = o.snapshot();
        const id = m[1];
        const d = snap.tools.find(t => t.id === id);
        if (!d) return problem(req, res, 404, 'tools.tool.not_found', (snap.gone && snap.gone.get(id)) || `No tool is called "${id}". GET /api/v1/tools lists them all.`);
        if (d.status === 'unavailable') return problem(req, res, 503, 'tools.tool.unavailable', d.statusReason || `${d.id} is not available right now.`);
        if (!d.api || !d.run) return problem(req, res, 404, 'tools.tool.not_runnable', `${d.id} has no run API; use its page${d.hosts && d.hosts[0] ? ` (https://${d.hosts[0]})` : ''}.`);
        if (o.proxy && o.proxy(d, req, res)) { counts.proxied++; return undefined; }
        const mode = o.runs(d);
        if (!mode) return problem(req, res, 404, 'tools.tool.not_runnable', `${d.id} is not run here; POST it to https://openvibe.tools/api/v1/tools/${d.id}/run.`);
        try {
            // Cookies from another site's page (CSRF): refused in enforce mode, recorded in report mode.
            if (!guard.originOk(req, res, { hosts: d.hosts, tool: d.id })) return undefined;
            const c = authorize(req, res, d);
            // The tool's quota class and cost (recorded for the job admission, so it is not charged twice).
            req._ovCharged = { quotaClass: d.quotaClass, cost: d.cost || 1, tool: d.id };
            if (!(await guard.charge(req, res, { quotaClass: d.quotaClass, cost: d.cost || 1, tool: d.id }))) return undefined;
            // A satellite's older per-route limiters count job runs like its job submits (report mode: in force).
            if (mode === 'job' && o.jobs.limiters && !(await passes(o.jobs.limiters, req, res))) return undefined;
            const multipart = req.is && req.is('multipart/form-data');
            if (multipart && mode !== 'job') throw new Refusal(400, 'tools.run.invalid', `${d.id} takes no files: send JSON (tools.run-request@1).`);
            if (!multipart && o.parseJson && req.body === undefined) {
                const bad = await new Promise((resolve) => o.parseJson(req, res, (err) => resolve(err || null)));
                if (bad) throw new Refusal(bad.status === 413 ? 413 : 400, bad.status === 413 ? 'tools.input.too_large' : 'tools.run.invalid', bad.status === 413 ? 'The request body is larger than 1 MB.' : 'The body is not valid JSON.');
            }
            let uploads = [];
            if (multipart) {
                const err = await new Promise((resolve) => o.jobs.receive(d)(req, res, (e) => resolve(e || null)));
                uploads = uploadsOf(req);
                if (err) { for (const f of uploads) if (f.path) fs.unlink(f.path, () => {}); throw err.refusal ? err : new Refusal(400, 'tools.run.invalid', err.message); }
            }
            let fields;
            try { fields = readRequest(req, multipart); } catch (err) { for (const f of uploads) if (f.path) fs.unlink(f.path, () => {}); throw err; }
            const bytes = Buffer.byteLength(JSON.stringify(fields.input));
            const limit = d.limits && d.limits.maxInputBytes;
            if (limit && bytes > limit) { for (const f of uploads) if (f.path) fs.unlink(f.path, () => {}); throw new Refusal(413, 'tools.input.too_large', `input is ${bytes} bytes as JSON; ${d.id} takes at most ${limit}.`); }
            const errors = o.validate(d, fields.input);
            if (errors.length) { for (const f of uploads) if (f.path) fs.unlink(f.path, () => {}); throw new Refusal(422, 'tools.input.invalid', `The input does not match ${d.id}'s input schema (GET /api/v1/tools/${d.id}/schema).`, { errors }); }
            if (mode === 'inline') return await runInline(req, res, d, c, fields, t0);
            return await runJob(req, res, d, c, fields, uploads);
        } catch (err) {
            if (err && err.refusal) return answerRefusal(req, res, err);
            log.error(`[Run] ${id}:`, err && err.message);
            if (!res.headersSent) return problem(req, res, 500, 'tools.run.failed', 'The run could not be started.');
            return undefined;
        }
    }

    return {
        handle: (req, res, next) => { handle(req, res, next).catch(next); },
        stats: () => ({ ...counts, cache: cache.stats(), replays: replays.stats() }),
        cache, replays,
    };
}

/**
 * A satellite's upload receiver for runs: `file` and `files` file parts on disk (never in memory), the
 * descriptor's file count and size, any declared type (the guard sniffs the bytes). The text parts
 * (input, files, wait_ms, idempotency_key) land in req.body.
 * @param {Function} multer   the app's multer
 * @param {string} dir        where uploads wait (the app's uploads directory)
 */
function createRunUploads(multer, dir) {
    fs.mkdirSync(dir, { recursive: true });
    const storage = multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, dir),
        filename: (_req, file, cb) => {
            const ext = (path.extname(file.originalname || '').toLowerCase().match(/^\.[a-z0-9]{1,8}$/) || ['.bin'])[0];
            cb(null, `run-${crypto.randomBytes(16).toString('hex')}${ext}`);
        },
    });
    const byTool = new Map();
    return function receive(d) {
        const max = (d.files && d.files.max) || 1;
        const maxBytes = (d.files && d.files.maxBytes) || 50 * 1024 * 1024;
        const k = `${max}|${maxBytes}`;
        if (!byTool.has(k)) {
            byTool.set(k, multer({ storage, limits: { fileSize: maxBytes, files: max, fields: 8, fieldSize: 1024 * 1024 } })
                .fields([{ name: 'file', maxCount: max }, { name: 'files', maxCount: max }]));
        }
        const mw = byTool.get(k);
        return (req, res, next) => mw(req, res, (err) => {
            if (!err) return next();
            if (err.code === 'LIMIT_FILE_SIZE') return next(new Refusal(413, 'tools.file.too_large', `A file is over ${Math.round(maxBytes / 1024 / 1024)} MB, the limit for ${d.id}.`));
            if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') return next(new Refusal(400, 'tools.run.invalid', `${d.id} takes at most ${max} file${max === 1 ? '' : 's'}, as "file" parts.`));
            return next(new Refusal(400, 'tools.run.invalid', err.message));
        });
    };
}

/**
 * A run's { job_id, index } reference to a job another satellite on this host holds: ask it which one
 * (the facade's loopback probe), then read the file there with the caller's own credentials and
 * address, so the owner check is that satellite's. → { path, name, mime, size } or null.
 */
function createSiblingFetch({ self, ports, fetchImpl = fetch }) {
    const { JOB_SATELLITES } = require('./satellites');
    return async function fetchSibling(ref, req, dir) {
        const all = ports();
        const others = JOB_SATELLITES.filter(s => s !== self && all[s]);
        let port = null;
        for (const sat of others) {
            try {
                const r = await fetchImpl(`http://127.0.0.1:${all[sat]}/api/internal/jobs/${ref.job_id}`, { signal: AbortSignal.timeout(2500) });
                if (r.status === 200) { port = all[sat]; break; }
            } catch { /* not that one */ }
        }
        if (!port) return null;
        const headers = { 'x-forwarded-for': String(req.ip || ''), 'x-real-ip': String(req.ip || '') };
        if (req.headers.authorization) headers.authorization = req.headers.authorization;
        if (req.headers.cookie) headers.cookie = req.headers.cookie;
        const r = await fetchImpl(`http://127.0.0.1:${port}/api/v1/jobs/${ref.job_id}/files/${ref.index}`, { headers, signal: AbortSignal.timeout(120_000) });
        if (r.status !== 200 || !r.body) return null;
        const cd = String(r.headers.get('content-disposition') || '');
        const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
        const plain = /filename="([^"]+)"/i.exec(cd);
        let name = 'file';
        try { name = star ? decodeURIComponent(star[1]) : plain ? plain[1] : 'file'; } catch { name = plain ? plain[1] : 'file'; }
        const to = path.join(dir, `run-${crypto.randomBytes(12).toString('hex')}${path.extname(name).slice(0, 9)}`);
        await fsp.writeFile(to, Buffer.from(await r.arrayBuffer()));
        return { path: to, name, mime: String(r.headers.get('content-type') || 'application/octet-stream').split(';')[0], size: (await fsp.stat(to)).size };
    };
}

/**
 * The run API of a satellite that runs job tools (img, audio, docs): each of its job tools runs as a
 * job of its own job system; file references to other satellites' jobs are read from them.
 * @param {object} o
 * @param {string} o.app            'img' | 'audio' | 'docs'
 * @param {object} o.guard  @param {object} o.contracts
 * @param {() => object} o.snapshot the satellite's own registry
 * @param {() => object} o.system   its job system (set up after the routes)
 * @param {Function} o.multer       @param {string} o.uploadsDir
 * @param {Function} o.Ajv          @param {Function} [o.addFormats]
 * @param {() => object} o.ports    satellite ports (./satellites.js)
 * @param {Function[]} [o.limiters] the app's older burst and processing limiters (as on its job submits)
 */
function satelliteRunApi(o) {
    const uploadsDir = path.resolve(o.uploadsDir);
    return createRunApi({
        guard: o.guard, contracts: o.contracts, snapshot: o.snapshot, log: o.log,
        validate: createInputValidator(o.Ajv, o.addFormats),
        runs: (d) => (d.execution === 'job' && d.run && d.run.job ? 'job' : null),
        jobs: {
            system: o.system,
            limiters: o.limiters || [],
            receive: createRunUploads(o.multer, uploadsDir),
            uploadsDir,
            fetchSibling: createSiblingFetch({ self: o.app, ports: o.ports }),
        },
    });
}

/**
 * Ajv (and ajv-formats) from the app's own openvibe-contracts, which depends on them (apps/_shared has
 * no node_modules). appRequire: the app's `require`.
 */
function ajvFrom(appRequire) {
    const base = path.dirname(appRequire.resolve('openvibe-contracts'));
    const Ajv = appRequire(appRequire.resolve('ajv/dist/2020', { paths: [base] }));
    let addFormats = null;
    try { addFormats = appRequire(appRequire.resolve('ajv-formats', { paths: [base] })); } catch { /* formats are optional */ }
    return { Ajv: Ajv.default || Ajv, addFormats: addFormats && (addFormats.default || addFormats) };
}

module.exports = { ajvFrom, createRunApi, satelliteRunApi, createRunUploads, createSiblingFetch, createInputValidator, createTtlStore, readRequest, isRunPath, Refusal, RUN_RE };
