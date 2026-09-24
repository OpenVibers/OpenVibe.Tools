'use strict';
// ═══════════════════════════════════════════════════════════════
// The Tools guard (apps/_shared/guard): anti-abuse for the gateway and every satellite, driven by
// the tools' descriptors (tools.tool@1: quotaClass, cost, auth, files.accept, limits) and the host-wide
// numbers in ./limits.js. Like the rest of apps/_shared it has no dependencies: the app passes its
// better-sqlite3 class, openvibe-contracts (when it has it) and its descriptor specs.
//
//   const guard = createGuard({ app: 'img', dataDir, Database, contracts, specs, networkUrl, … });
//   app.set('trust proxy', TRUST_PROXY);                 // ./ip.js: one loopback hop
//   app.use(guard.identify);                             // req.user (Network sign-in, aud checked)
//   app.use('/api/', legacyLimiter, guard.apiQuota);     // every /api/ request (tools-api)
//   app.post('/api/process', guard.toolQuota(hostTool), upload, guard.admitUpload(toolOf), guard.heavy(), …)
//
// What it does:
//   callers    one resolver (./caller.js): anonymous (address, IPv6 /64) < session < user < service;
//              sandbox tokens keep their small allowance
//   quotas     token buckets per class × tier weighted by the tool's cost (./quota.js), day allowances
//              in guard.db; RateLimit-Limit/Remaining/Reset on every counted answer, and on refusal
//              429 problem+json tools.quota.exceeded with Retry-After
//   heavy      a semaphore for synchronous heavy calls (503 tools.busy + Retry-After when it is full)
//   uploads    the bytes are checked against the descriptor's files.accept (415 tools.file.unsupported_type);
//              heavy tools (auth.anonymous false) need a session cookie, a sign-in or a token
//   egress     a per-target throttle across all callers (limits.perTargetPerMinute) and the port-scan cap
//   log        every refusal (and every would-be refusal in report mode) in guard.db's abuse log:
//              HMAC(address, today's salt), principal or user id, tool, reason — 30 days, no raw
//              address anywhere; metric tools_guard_refused_total{reason,tool}
//   challenge  a hook for a person-check (Turnstile later; ./challenge.js, a no-op now)
//
// Mode: TOOLS_GUARD=report (default) logs and counts what it would refuse and refuses nothing, except
// the hard limits that apply in both modes: the image pixel limit, ffmpeg's protocol and format
// whitelists and duration cap, upload sniffing, the port-scan cap and the per-target throttle.
// TOOLS_GUARD=enforce refuses. The apps' older per-route limiters keep working in report mode and step
// aside in enforce mode (guard.enforcing), where the tiered quotas replace them.
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const limits = require('./limits');
const ip = require('./ip');
const tokens = require('./tokens');
const sniff = require('./sniff');
const ffmpeg = require('./ffmpeg');
const { createGuardStore, dayOf, DAY_MS } = require('./store');
const { createQuotas, setHeaders } = require('./quota');
const { createSemaphore, Busy } = require('./semaphore');
const { createTargetThrottle, createPortScanCap, normalizeTarget } = require('./targets');
const { createCallerResolver, jobOwnerResolver } = require('./caller');
const { NO_CHALLENGE, validChallenge } = require('./challenge');

const TITLES = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 413: 'Payload Too Large', 415: 'Unsupported Media Type', 422: 'Unprocessable Content', 429: 'Too Many Requests', 503: 'Service Unavailable', 504: 'Gateway Timeout' };

/** RFC 9457 problem+json in the contracts' shape (errors.problem@1), with the legacy { error } field. */
function sendProblem(req, res, status, code, detail, extra, contracts) {
    if (contracts && contracts.http) return contracts.http.sendProblem(res, status, code, { detail, extra, ctx: req.ov });
    const body = { type: `https://openvibe.network/problems/${code}`, title: TITLES[status] || 'Error', status, code };
    if (detail) body.detail = detail;
    if (req.ov) { body.request_id = req.ov.requestId; body.trace_id = req.ov.traceId; }
    body.error = detail || body.title;
    Object.assign(body, extra);
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/problem+json');
    res.end(JSON.stringify(body));
    return body;
}

/** Every uploaded file on a request (multer single, array or fields). */
function uploadsOf(req) {
    if (Array.isArray(req.files)) return req.files;
    if (req.files && typeof req.files === 'object') return Object.values(req.files).flat();
    return req.file ? [req.file] : [];
}

/** Delete the files multer wrote to disk for a request that is refused. */
function discardUploads(req) {
    for (const f of uploadsOf(req)) if (f.path) fs.unlink(f.path, () => {});
}

/**
 * @param {object} o
 * @param {string} o.app                  'gateway' | 'img' | … (logs, metrics)
 * @param {string} [o.dataDir]            guard.db goes here (with o.Database)
 * @param {Function} [o.Database]         require('better-sqlite3'); without it everything stays in memory
 * @param {object} [o.contracts]          openvibe-contracts, when the app has it
 * @param {object[]} [o.specs]            the app's descriptor specs (server/descriptors.js SPECS)
 * @param {object} [o.keys]               { get(), ensure() } — or networkUrl/networkInternalUrl/publicKeyFiles
 * @param {string} o.issuer               the Network issuer URL
 * @param {object} [o.challenge]          a challenge provider (./challenge.js); default: none
 * @param {object} [o.env]  [o.log]  [o.now]  [o.secureCookie]
 */
function createGuard(o = {}) {
    const env = o.env || process.env;
    const log = o.log || console;
    const now = o.now || Date.now;
    const appName = o.app || 'tools';
    const mode = String(env.TOOLS_GUARD || 'report').trim().toLowerCase() === 'enforce' ? 'enforce' : 'report';
    const enforcing = mode === 'enforce';
    const bounds = limits.bounds(env);
    const table = limits.quotas(env, log);
    const store = createGuardStore({ Database: o.Database, dataDir: o.dataDir, now, log });

    let saltDay = null, saltValue = null;
    const salt = () => {
        const d = dayOf(now());
        if (d !== saltDay) { saltValue = store.salt(d); saltDay = d; }
        return saltValue;
    };

    const keys = o.keys || tokens.createKeySource({ networkUrl: o.networkUrl, networkInternalUrl: o.networkInternalUrl, files: o.publicKeyFiles || [], log });
    const issuer = o.issuer;
    const audience = env.OV_TOOLS_AUDIENCE || tokens.AUDIENCE;
    const callers = createCallerResolver({ getPublicKey: () => keys.get(), issuer, audience, contracts: o.contracts, salt, secureCookie: o.secureCookie });
    const quotas = createQuotas({ store, quotas: () => table, now });
    const targets = createTargetThrottle({ now });
    const ports = createPortScanCap({ ...bounds.ports, now });
    const sync = createSemaphore({ max: bounds.sync.concurrency, queue: bounds.sync.queue, waitMs: bounds.sync.waitMs });
    const challenge = validChallenge(o.challenge) ? o.challenge : NO_CHALLENGE;

    // ── Descriptors ──────────────────────────────────────────
    const specs = new Map((o.specs || []).map(s => [s.id, s]));
    const tool = (id) => (id && specs.get(id)) || null;
    /** The descriptor of a job run: the host's own tool when it runs this operation, else the tool named after it, else the first. */
    function toolForJob(type, operation, preferId) {
        const pref = tool(preferId);
        if (pref && pref.job && pref.job.type === type && (!operation || pref.job.operation === operation)) return pref;
        let first = null;
        for (const s of specs.values()) {
            if (!s.job || s.job.type !== type || (operation && s.job.operation !== operation)) continue;
            if (s.id === operation) return s;
            if (!first) first = s;
        }
        return first;
    }
    const label = (id) => (id && specs.has(id) ? id : id ? 'other' : '-');

    // ── Metrics and the log ──────────────────────────────────
    let refused = null;
    function attachMetrics(registry) {
        if (!registry || refused) return;
        refused = registry.counter({ name: 'tools_guard_refused_total', help: 'Requests the guard refused, or in report mode would have refused, by reason and tool', labelNames: ['reason', 'tool'], maxSeries: 2000 });
        registry.gauge({ name: 'tools_guard_enforcing', help: '1 when TOOLS_GUARD=enforce, 0 in report mode (hard limits refuse in both)', collect: () => [{ labels: {}, value: enforcing ? 1 : 0 }] });
        registry.gauge({
            name: 'tools_guard_sync', help: 'Synchronous heavy calls running and waiting, and the limit', labelNames: ['kind'],
            collect: () => { const s = sync.stats(); return [{ labels: { kind: 'running' }, value: s.active }, { labels: { kind: 'waiting' }, value: s.waiting }, { labels: { kind: 'limit' }, value: s.max }]; },
        });
    }
    const said = new Map();
    function record(req, c, { reason, tool: toolId, enforced }) {
        try {
            store.logAbuse({ at: now(), ipHash: c ? c.ipHash : callers.hashIp(req.ip), principal: (c && c.id) || '', tool: toolId || '', reason, enforced });
        } catch (err) { log.error(`[Guard] ${appName}: abuse log write failed: ${err.message}`); }
        if (refused) refused.inc({ reason, tool: label(toolId) });
        const k = `${reason}|${toolId || ''}|${enforced}`;
        const t = now();
        if (!said.has(k) || t - said.get(k) > 60_000) {
            said.set(k, t);
            if (said.size > 1000) said.clear();
            log.warn(`[Guard] ${appName}: ${enforced ? 'refused' : 'would refuse (report mode)'} ${reason}${toolId ? ` on ${toolId}` : ''} (${c ? c.tier : 'anonymous'})`);
        }
    }

    // ── Callers ──────────────────────────────────────────────
    /** The request's caller, resolved once (before any cookie is minted during the request). */
    function caller(req, res) {
        if (!req._ovCaller) req._ovCaller = callers.resolve(req, res);
        return req._ovCaller;
    }

    /** Attach req.user for a valid Network sign-in (aud openvibe.tools); a principal's token is left to the resolver. */
    function identify(req, _res, next) {
        const { token } = tokens.extractToken(req);
        if (!token || tokens.looksLikePrincipal(tokens.peek(token))) return next();
        const verify = () => {
            const claims = tokens.verifyUserToken(token, { publicKey: keys.get(), issuer, audience, now: now() });
            if (claims) { req.user = claims; req.token = token; }
        };
        if (keys.get() || typeof keys.ensure !== 'function') { verify(); return next(); }
        Promise.resolve(keys.ensure()).then(verify, () => {}).finally(() => next());
    }

    // ── Refusals ─────────────────────────────────────────────
    /**
     * Refuse (enforce mode, or a hard limit) or only record it (report mode).
     * → true when the answer was sent, false when the request may go on.
     */
    function refuse(req, res, r) {
        const c = caller(req, res);
        const enforced = !!r.hard || enforcing;
        record(req, c, { reason: r.reason, tool: r.tool, enforced });
        if (!enforced) return false;
        if (r.discard !== false) discardUploads(req);
        if (r.retryAfter) res.setHeader('Retry-After', String(Math.max(1, Math.ceil(r.retryAfter))));
        sendProblem(req, res, r.status, r.code, r.detail, r.extra, o.contracts);
        return true;
    }

    // ── Quotas ───────────────────────────────────────────────
    async function charge(req, res, { quotaClass, cost, tool: toolId }) {
        const c = caller(req, res);
        const r = quotas.check(c, { quotaClass, cost }, { report: !enforcing });
        // In report mode an older limiter that ran on this request (req.rateLimit) is the one in force:
        // its RateLimit-* headers stay. Otherwise the guard's describe the allowance closest to running out.
        if (enforcing || !req.rateLimit) setHeaders(res, r);
        if (r.ok) return true;
        if (enforcing && (c.tier === 'anonymous' || c.tier === 'session') && challenge.required(req, c, { reason: 'quota', tool: toolId })) {
            if (await challenge.verify(req, c)) return true;
            record(req, c, { reason: 'challenge', tool: toolId, enforced: true });
            discardUploads(req);
            sendProblem(req, res, 403, 'tools.challenge.required', 'Show that you are a person to go on.', { challenge: challenge.name }, o.contracts);
            return false;
        }
        const detail = r.binding === 'day'
            ? `You have used today's allowance for ${quotaClass.replace(/^tools-/, '')} requests; it renews at midnight UTC.`
            : 'Too many requests; slow down a little.';
        return !refuse(req, res, { status: 429, code: 'tools.quota.exceeded', detail, reason: 'quota', tool: toolId, retryAfter: r.retryAfter, extra: { quota_class: quotaClass, scope: r.scope, tier: c.tier, retry_after: r.retryAfter } });
    }

    /** Middleware: charge a fixed class and cost (tools-api for every /api/ request). */
    function quota({ quotaClass, cost = 1, skip = null }) {
        return (req, res, next) => {
            if (skip && skip(req)) return next();
            charge(req, res, { quotaClass, cost }).then(ok => { if (ok) next(); }, next);
        };
    }
    // Liveness and readiness probes (the gateway polls every satellite's) are never counted.
    const PROBES = new Set(['/api/health', '/api/ready']);
    const isProbe = (req) => req.method === 'GET' && PROBES.has(`${req.baseUrl || ''}${req.path}`);

    /**
     * Middleware: charge the tool's own class and cost (its descriptor). toolOf(req) → a tool id. Records
     * what was taken on req._ovCharged, so admit()/admitJob() can settle the difference once the real
     * tool is known (a multipart body names it only after the upload).
     */
    function toolQuota(toolOf) {
        return (req, res, next) => {
            const d = tool(typeof toolOf === 'function' ? toolOf(req) : toolOf);
            if (!d) return next();
            req._ovCharged = { quotaClass: d.quotaClass, cost: d.cost || 1, tool: d.id };
            charge(req, res, { quotaClass: d.quotaClass, cost: d.cost || 1, tool: d.id }).then(ok => { if (ok) next(); }, next);
        };
    }

    /** Settle a pre-charge against the real tool: charge the difference or give it back. → ok */
    async function settle(req, res, d) {
        const was = req._ovCharged;
        const cost = d.cost || 1;
        if (!was || was.quotaClass !== d.quotaClass) {
            req._ovCharged = { quotaClass: d.quotaClass, cost, tool: d.id };
            return charge(req, res, { quotaClass: d.quotaClass, cost, tool: d.id });
        }
        if (cost > was.cost) { req._ovCharged = { ...was, cost }; return charge(req, res, { quotaClass: d.quotaClass, cost: cost - was.cost, tool: d.id }); }
        if (cost < was.cost) { quotas.refund(caller(req, res), { quotaClass: d.quotaClass, cost: was.cost - cost }); req._ovCharged = { ...was, cost }; }
        return true;
    }

    // ── Who may run it ───────────────────────────────────────
    /** Heavy tools (descriptor auth.anonymous false) need a session that existed before this request, a sign-in or a token. → ok */
    function sessionRule(req, res, d) {
        if (!d || !d.auth || d.auth.anonymous !== false) return true;
        const c = caller(req, res);
        if (c.kind !== 'anonymous') return true;
        return !refuse(req, res, { status: 401, code: 'tools.session_required', detail: 'This tool needs a browser session (open its page first), a sign-in or an API token.', reason: 'session', tool: d.id });
    }

    /** A principal must hold the tool's capability (tools.net.probe for probes). People use the pages. → ok */
    function capabilityRule(req, res, d) {
        if (!d || !d.auth) return true;
        const c = caller(req, res);
        if (c.kind !== 'principal') return true;
        if (tokens.hasCapability(c.claims, d.auth.capability, o.contracts)) return true;
        return !refuse(req, res, { status: 403, code: 'capability.denied', detail: `${d.auth.capability} not granted`, reason: 'capability', tool: d.id });
    }

    // ── Uploads ──────────────────────────────────────────────
    /**
     * The bytes of every file against `accept` (hard limit). Fixes each file's type (and a misleading
     * extension) to what the bytes are. files: multer files ({ buffer|path, originalname, mimetype })
     * or job files ({ buffer|path, name, mime }). → ok
     */
    function checkFiles(req, res, files, accept, toolId) {
        if (!Array.isArray(accept) || !accept.length) return true;
        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            let found = null;
            try { found = sniff.detect(sniff.head(f)); } catch { found = null; }
            const name = f.originalname != null ? f.originalname : f.name;
            if (!sniff.accepts(accept, found)) {
                const what = found ? `a ${found.ext.toUpperCase()} file` : 'not a file type this tool knows';
                refuse(req, res, { status: 415, code: 'tools.file.unsupported_type', hard: true, reason: 'sniff', tool: toolId, detail: `${files.length > 1 ? `File ${i + 1}` : 'The file'} is ${what}; this tool takes ${sniff.describe(accept)}.`, extra: { detected: found ? found.mime : null } });
                return false;
            }
            if ('mimetype' in f) f.mimetype = found.mime; else f.mime = found.mime;
            if (!sniff.extFits(name, found)) {
                const base = String(name || 'file').replace(/\.[A-Za-z0-9]{1,8}$/, '') || 'file';
                if (f.originalname != null) f.originalname = `${base}.${found.ext}`; else f.name = `${base}.${found.ext}`;
                if (f.path && !sniff.extFits(f.path, found)) {
                    const to = `${f.path.replace(/\.[A-Za-z0-9]{1,8}$/, '')}.${found.ext}`;
                    try { fs.renameSync(f.path, to); f.path = to; if (f.filename) f.filename = path.basename(to); } catch { /* keep the old name */ }
                }
            }
        }
        return true;
    }

    /**
     * After the upload middleware: the real tool (toolOf(req) once the body is parsed) — its session rule,
     * the bytes against its files.accept, and the quota difference. → middleware
     */
    function admitUpload(toolOf) {
        return (req, res, next) => {
            const d = tool(toolOf(req));
            if (!d) return next();
            if (!sessionRule(req, res, d)) return;
            if (!checkFiles(req, res, uploadsOf(req), d.files && d.files.accept, d.id)) return;
            settle(req, res, d).then(ok => { if (ok) next(); }, next);
        };
    }

    /** The job routes' admission hook (apps/_shared/jobs/http.js o.admit): the same checks for a job submit. → ok */
    async function admitJob(req, res, { type, input, files, toolId }) {
        const d = tool(toolId) || toolForJob(type, input && input.tool, null);
        if (!d) return true;
        if (!sessionRule(req, res, d)) return false;
        if (!checkFiles(req, res, files, d.files && d.files.accept, d.id)) return false;
        return settle(req, res, d);
    }

    // ── Heavy work ───────────────────────────────────────────
    /** Middleware: hold one of the synchronous heavy slots until the answer is sent. */
    function heavy(toolOf) {
        return (req, res, next) => {
            sync.acquire().then((release) => {
                let done = false;
                const free = () => { if (!done) { done = true; release(); } };
                res.on('finish', free);
                res.on('close', free);
                next();
            }, (err) => {
                if (!(err instanceof Busy)) return next(err);
                const toolId = typeof toolOf === 'function' ? toolOf(req) : toolOf;
                if (refuse(req, res, { status: 503, code: 'tools.busy', detail: 'The server is busy with other files right now; try again in a moment.', reason: `busy.${err.reason === 'queue' ? 'sync' : 'wait'}`, tool: toolId, retryAfter: 10 })) return;
                next();   // report mode: runs without a slot
            });
        };
    }

    /** The job store is over its queue or disk bound (system.busy()): refuse or record. → ok */
    function jobsBusy(req, res, busy, toolId) {
        if (!busy) return true;
        return !refuse(req, res, { status: 503, code: 'tools.busy', detail: busy.detail, reason: `busy.${busy.reason}`, tool: toolId, retryAfter: busy.retryAfter || 30 });
    }

    // ── Egress ───────────────────────────────────────────────
    /** Per-target throttle (hard). → ok */
    function target(req, res, { tool: toolId, target: t, perMinute }) {
        const d = tool(toolId);
        const per = perMinute || (d && d.limits && d.limits.perTargetPerMinute);
        const r = targets.take(t, per);
        if (r.ok) return true;
        refuse(req, res, { status: 429, code: 'tools.quota.exceeded', hard: true, reason: 'target', tool: toolId, retryAfter: r.retryAfter, detail: `${r.target} was checked too often in the last minute; try again in ${r.retryAfter} s.`, extra: { scope: 'target', retry_after: r.retryAfter } });
        return false;
    }

    /** The port checker's caps (hard). Browser sessions count by address, so a new cookie is no new allowance. → ok */
    function portScan(req, res, { tool: toolId, target: t, ports: list }) {
        const c = caller(req, res);
        const key = c.tier === 'anonymous' || c.tier === 'session' ? c.ipKey : c.key;
        const r = ports.take(key, t, list);
        if (r.ok) return true;
        if (r.reason === 'ports.per_request') {
            refuse(req, res, { status: 400, code: 'tools.run.invalid', hard: true, reason: 'ports', tool: toolId, detail: r.detail });
        } else {
            refuse(req, res, { status: 429, code: 'tools.quota.exceeded', hard: true, reason: 'ports', tool: toolId, retryAfter: r.retryAfter, detail: `${r.detail}: the port checker is for your own servers, not for scanning.`, extra: { scope: 'ports', retry_after: r.retryAfter } });
        }
        return false;
    }

    // ── Older limiters, and tool errors ──────────────────────
    /**
     * One of the apps' older express-rate-limit limiters, keyed by the resolved caller: a signed-in
     * person or a principal by who they are (their higher number applies — these limiters used to run
     * before sign-in was read), everyone else by address (IPv6 /64, hashed). Skipped in enforce mode.
     * @param {Function} rateLimit   require('express-rate-limit')
     */
    function legacyLimiter(rateLimit, { windowMs, anonymous, signedIn = anonymous, message, headers = true }) {
        const signed = (c) => c.tier === 'user' || c.tier === 'service';
        return rateLimit({
            windowMs,
            max: (req) => (signed(caller(req)) ? signedIn : anonymous),
            standardHeaders: headers,
            legacyHeaders: false,
            keyGenerator: (req) => { const c = caller(req); return signed(c) || c.tier === 'sandbox' ? c.key : c.ipKey; },
            skip: (req) => enforcing || isProbe(req),   // liveness and readiness probes are never limited
            message: { error: message },
        });
    }
    /** The three limiters an upload app had (LEGACY numbers in ./limits.js). */
    function legacyLimiters(rateLimit, numbers) {
        const n = numbers || limits.LEGACY[appName];
        return {
            apiLimiter: legacyLimiter(rateLimit, { windowMs: 60_000, anonymous: n.api[0], signedIn: n.api[1], message: 'Too many requests. Please try again later.' }),
            processLimiter: legacyLimiter(rateLimit, { windowMs: 60_000, anonymous: n.process[0], signedIn: n.process[1], message: 'Processing rate limit reached. Sign in for higher limits or wait a moment.' }),
            burstLimiter: legacyLimiter(rateLimit, { windowMs: 5_000, anonymous: n.burst, signedIn: n.burst, headers: false, message: 'Too many requests in quick succession. Please slow down.' }),
        };
    }

    /**
     * A tool refused its input on a hard limit (err.guardReason: 'pixels', 'ffmpeg.format',
     * 'ffmpeg.duration', 'timeout'): record it and answer its problem. → true when answered.
     */
    function toolRefused(req, res, err, toolId) {
        if (!err || !err.guardReason || res.headersSent) return false;
        refuse(req, res, { status: err.status || 422, code: err.code || 'tools.input.invalid', hard: true, reason: err.guardReason, tool: toolId, detail: err.message });
        return true;
    }

    // ── Upkeep ───────────────────────────────────────────────
    function prune() {
        try {
            const cutoff = now() - bounds.abuseRetentionDays * DAY_MS;
            store.pruneAbuse(cutoff);
            store.pruneDays(dayOf(now() - DAY_MS));
        } catch (err) { log.error(`[Guard] ${appName}: prune failed: ${err.message}`); }
    }
    prune();
    const pruneTimer = o.pruneIntervalMs === 0 ? null : setInterval(prune, o.pruneIntervalMs || 6 * 60 * 60 * 1000);
    if (pruneTimer && pruneTimer.unref) pruneTimer.unref();

    const api = {
        app: appName, mode, enforcing, bounds, table, store, keys, challenge,
        issuer, audience,
        identify, caller, resolveCaller: (req, res, opt) => callers.resolve(req, res, opt),
        ensureSession: (req, res) => callers.ensureSession(req, res),
        ownerResolver: () => jobOwnerResolver(callers),
        hashIp: (addr) => callers.hashIp(addr),
        tool, toolForJob,
        refuse, record, sendProblem: (req, res, status, code, detail, extra) => sendProblem(req, res, status, code, detail, extra, o.contracts),
        quota, apiQuota: quota({ quotaClass: 'tools-api', cost: 1, skip: isProbe }), toolQuota, charge, settle, quotas,
        sessionRule, capabilityRule,
        checkFiles, admitUpload, admitJob, uploadsOf, discardUploads,
        heavy, sync, jobsBusy,
        target, portScan, targets, ports, normalizeTarget,
        legacyLimiter, legacyLimiters, toolRefused,
        attachMetrics, prune,
        close() { if (pruneTimer) clearInterval(pruneTimer); if (keys.stop) keys.stop(); store.close(); },
    };
    return api;
}

module.exports = { createGuard, sendProblem, uploadsOf, discardUploads, TRUST_PROXY: ip.TRUST_PROXY, limits, ip, tokens, sniff, ffmpeg, NO_CHALLENGE };
