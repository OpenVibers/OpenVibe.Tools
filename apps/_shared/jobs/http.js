'use strict';
// ═══════════════════════════════════════════════════════════════
// Jobs over HTTP — the same routes on every satellite that runs jobs.
//
//   POST   /api/v1/jobs                  submit  (JSON { type, input, idempotency_key } or multipart:
//                                        type, input (JSON text), file/files; Idempotency-Key header)
//                                        → 202 + Location (new) | 200 + Idempotent-Replayed: true
//   GET    /api/v1/jobs/:id              the job (reattach by id)
//   DELETE /api/v1/jobs/:id              cancel → 200 cancelled | 202 cancel requested (running)
//   POST   /api/v1/jobs/:id/retry        retry a failed job as a new job → 202 + Location (new) |
//                                        200 + Idempotent-Replayed: true (it was already retried: that job)
//                                        | 409 tools.job.not_failed | 410 tools.job.inputs_gone
//   PUT    /api/v1/jobs/:id/references/:ref   keep a succeeded job's result while <ref> points at it
//                                        (e.g. community:paste:p_123) → 201 new | 200 already there
//   DELETE /api/v1/jobs/:id/references/:ref   drop it → 200 (the expiry clock restarts after the last one)
//   GET    /api/v1/jobs/:id/events       SSE: job.queued|running|progress|cancel_requested|succeeded|failed|cancelled;
//                                        every event has an id; reconnecting with Last-Event-ID replays
//                                        only what came after it; 204 once there is nothing left to say
//   GET    /api/v1/jobs/:id/files/:n     a result file (attachment; ?inline=1 for previews)
//   GET    /js/ov-jobs.js                the browser helper (submit, watch, reattach)
//
// Owner scoping: a job is visible only to whoever created it —
//   a Network user (user:usr_…, from the ov_token subject_id), a service/app principal presenting a
//   Network client-credentials token for audience openvibe.tools with tools.job.* capabilities, or,
//   for everyone else, this browser's jobs session cookie. Anyone else gets the same 404 as for a
//   job that does not exist. Errors are RFC 9457 problem+json.
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

const ID_RE = /^job_[0-9A-HJKMNP-TV-Z]{26}$/;
const SESSION_RE = /^[A-Za-z0-9_-]{32,64}$/;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const CLIENT_JS = path.join(__dirname, 'client.js');
const CAPS = { create: 'tools.job.create', read: 'tools.job.read', cancel: 'tools.job.cancel' };

const b64json = (part) => { try { return JSON.parse(Buffer.from(String(part).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch { return null; } };

function contentDisposition(kind, name) {
    const ascii = String(name || 'result').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(String(name || 'result'))}`;
}

/**
 * Who is asking. → { owner, kind: 'principal'|'user'|'session', claims? } | { error: [status, code, detail] } | null
 *
 * @param {object} o
 * @param {object} o.contracts
 * @param {() => string|null} o.getPublicKey   the Network public key PEM the app already loads
 * @param {string} o.issuer                    the Network issuer URL
 * @param {string} [o.audience='openvibe.tools']
 * @param {string} [o.cookieName='ov_tools_jobs']
 * @param {boolean} [o.secureCookie]
 */
function createOwnerResolver(o) {
    const audience = o.audience || 'openvibe.tools';
    const cookieName = o.cookieName || 'ov_tools_jobs';
    const { contracts } = o;

    function principalCapability(claims, cap) {
        const c = contracts.capabilities.check(claims, cap);
        if (c.allowed) return null;
        // The tools.job.* manifests are proposed for the next contracts release; until the installed
        // version knows them, an explicit grant in the token (which only Network can sign) is enough.
        if (c.code === 'capability.unknown' && contracts.capabilities.grants(claims.cap, cap)) return null;
        return [403, c.code === 'capability.unknown' ? 'capability.denied' : c.code, `${cap} not granted`];
    }

    return function resolveOwner(req, res, { create = false, action = 'read' } = {}) {
        const auth = String(req.headers.authorization || '');
        if (auth.startsWith('Bearer ')) {
            const token = auth.slice(7).trim();
            const parts = token.split('.');
            const claims = parts.length === 3 ? b64json(parts[1]) : null;
            const looksLikePrincipal = claims && (Array.isArray(claims.cap) || /^(svc|app|mod):/.test(String(claims.sub || '')));
            if (looksLikePrincipal) {
                // Job routes are the only Tools routes that take sandbox tokens (developer apps, ADR-014), and
                // only from apps: a sandbox token that is not an app's is refused.
                const r = contracts.serviceAuth.verifyServiceToken(token, { publicKey: o.getPublicKey(), issuer: o.issuer, audience, acceptSandbox: true });
                if (r.ok && r.claims.env === 'sandbox' && !(r.claims.actor_type === 'app' && /^app:/.test(String(r.claims.sub || '')))) {
                    return { error: [401, 'token.sandbox_refused', 'sandbox tokens are accepted only from developer apps'] };
                }
                if (!r.ok) return { error: [401, r.code, r.reason] };
                const denied = principalCapability(r.claims, CAPS[action] || CAPS.read);
                if (denied) return { error: denied };
                return { owner: r.claims.sub, kind: 'principal', claims: r.claims, env: r.claims.env === 'sandbox' ? 'sandbox' : 'production' };
            }
        }
        const sid = req.user && req.user.subject_id;
        if (sid && contracts.ids.isSubjectId('user', sid)) return { owner: `user:${sid}`, kind: 'user' };

        let session = req.cookies && req.cookies[cookieName];
        if (!SESSION_RE.test(String(session || ''))) {
            if (!create) return null;
            session = crypto.randomBytes(24).toString('base64url');
            res.cookie(cookieName, session, {
                httpOnly: true, sameSite: 'lax', path: '/', maxAge: 7 * 24 * 60 * 60 * 1000,
                secure: o.secureCookie != null ? o.secureCookie : process.env.NODE_ENV === 'production',
            });
        }
        // Only a hash of the cookie is stored, so the database cannot be used to take over a session.
        return { owner: `session:${crypto.createHash('sha256').update(session).digest('hex').slice(0, 40)}`, kind: 'session' };
    };
}

/**
 * Mount the job routes on an Express app.
 *
 * @param {object} app
 * @param {object} o
 * @param {object} o.system        createJobSystem(...)
 * @param {object} o.contracts
 * @param {function} o.resolveOwner createOwnerResolver(...)
 * @param {function} [o.receive]    multipart middleware that sets req.file / req.files (the app's multer)
 * @param {function[]} [o.limiters] middleware run before accepting a submit (rate limits)
 * @param {(req, who) => number} [o.ttlMs] how long a finished job is kept
 * @param {(req, input) => object} [o.defaults] fills input from the host (e.g. the format a png.* host implies)
 */
function mountJobRoutes(app, o) {
    const { system, contracts } = o;
    const send = (res, status, code, detail, extra) => contracts.http.sendProblem(res, status, code, { detail, extra, ctx: res.req && res.req.ov });
    const ttlMs = o.ttlMs || ((_req, who) => (who.kind === 'session' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000));
    const noStore = (res) => res.set('Cache-Control', 'no-store');

    function who(req, res, opts) {
        const w = o.resolveOwner(req, res, opts);
        if (w && w.error) { send(res, ...w.error); return null; }
        return w || { owner: null };
    }
    /** The job, if it exists AND belongs to the caller; otherwise the same 404 either way. */
    function load(req, res, action) {
        const w = who(req, res, { action });
        if (!w) return null;
        const id = String(req.params.id || '');
        const row = ID_RE.test(id) ? system.get(id) : null;
        if (!row || !w.owner || row.owner !== w.owner) { send(res, 404, 'tools.job.not_found', 'No such job'); return null; }
        return row;
    }

    app.get('/js/ov-jobs.js', (_req, res) => {
        res.set({ 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.sendFile(CLIENT_JS);
    });

    const receive = o.receive || ((_req, _res, next) => next());
    // The apps' upload middleware answers { error } (their legacy shape); on this API those become problem+json.
    const multipartOnly = (req, res, next) => {
        if (!req.is('multipart/form-data')) return next();
        const json = res.json.bind(res);
        res.json = (body) => {
            res.json = json;
            if (res.statusCode >= 400 && body && body.error && !body.code) return send(res, res.statusCode, res.statusCode === 413 ? 'tools.job.too_large' : 'tools.job.invalid', String(body.error));
            return json(body);
        };
        receive(req, res, (err) => { res.json = json; next(err); });
    };

    app.post('/api/v1/jobs', ...(o.limiters || []), multipartOnly, async (req, res) => {
        noStore(res);
        const w = who(req, res, { create: true, action: 'create' });
        if (!w) return;
        const b = req.body || {};
        let input = b.input;
        if (typeof input === 'string') {
            try { input = input.trim() ? JSON.parse(input) : {}; } catch { return send(res, 400, 'tools.job.invalid', 'input must be JSON'); }
        }
        if (input == null) input = {};
        if (typeof input !== 'object' || Array.isArray(input)) return send(res, 400, 'tools.job.invalid', 'input must be a JSON object');
        if (o.defaults) input = o.defaults(req, input) || input;
        const list = Array.isArray(req.files) ? req.files : req.files && typeof req.files === 'object' ? Object.values(req.files).flat() : req.file ? [req.file] : [];
        const files = list.map(f => ({ path: f.path, buffer: f.path ? undefined : f.buffer, name: f.originalname, mime: f.mimetype, size: f.size }));
        const key = req.headers['idempotency-key'] != null ? String(req.headers['idempotency-key']) : (b.idempotency_key != null ? String(b.idempotency_key) : null);
        try {
            const { job, replayed } = await system.submit({ owner: w.owner, type: String(b.type || ''), input, files, idempotencyKey: key, ttlMs: ttlMs(req, w), env: w.env || 'production' });
            res.set('Location', `/api/v1/jobs/${job.id}`);
            if (replayed) res.set('Idempotent-Replayed', 'true');
            return res.status(replayed ? 200 : 202).json(system.view(job));
        } catch (err) {
            if (err instanceof system.JobError) return send(res, err.status, err.code, err.detail, err.extra);
            console.error('[Jobs] submit failed:', err.message);
            return send(res, 500, 'tools.job.submit_failed', 'The job could not be accepted');
        }
    });

    app.get('/api/v1/jobs/:id', (req, res) => {
        noStore(res);
        const row = load(req, res, 'read');
        if (row) res.json(system.view(row));
    });

    app.delete('/api/v1/jobs/:id', (req, res) => {
        noStore(res);
        const row = load(req, res, 'cancel');
        if (!row) return;
        if (row.state === 'succeeded' || row.state === 'failed') return send(res, 409, 'tools.job.already_finished', `The job already ${row.state}`, { state: row.state });
        const { job } = system.cancel(row.id);
        return res.status(job.state === 'cancelled' ? 200 : 202).json(system.view(job));
    });

    // Retry and references are writes: a principal needs tools.job.create, like a submit.
    app.post('/api/v1/jobs/:id/retry', ...(o.limiters || []), (req, res) => {
        noStore(res);
        const row = load(req, res, 'create');
        if (!row) return;
        try {
            const { job, replayed } = system.retry(row.id);
            res.set('Location', `/api/v1/jobs/${job.id}`);
            if (replayed) res.set('Idempotent-Replayed', 'true');
            return res.status(replayed ? 200 : 202).json(system.view(job));
        } catch (err) {
            if (err instanceof system.JobError) return send(res, err.status, err.code, err.detail, err.extra);
            console.error('[Jobs] retry failed:', err.message);
            return send(res, 500, 'tools.job.retry_failed', 'The job could not be retried');
        }
    });

    function referenceRoute(fn) {
        return (req, res) => {
            noStore(res);
            const row = load(req, res, 'create');
            if (!row) return;
            try {
                const r = fn(row.id, String(req.params.ref || ''));
                return res.status(r.created ? 201 : 200).json(system.view(r.job));
            } catch (err) {
                if (err instanceof system.JobError) return send(res, err.status, err.code, err.detail, err.extra);
                console.error('[Jobs] reference failed:', err.message);
                return send(res, 500, 'tools.job.reference_failed', 'The reference could not be changed');
            }
        };
    }
    app.put('/api/v1/jobs/:id/references/:ref', referenceRoute((id, ref) => system.reference(id, ref)));
    app.delete('/api/v1/jobs/:id/references/:ref', referenceRoute((id, ref) => system.unreference(id, ref)));

    app.get('/api/v1/jobs/:id/events', (req, res) => {
        const row = load(req, res, 'read');
        if (!row) return;
        const raw = req.headers['last-event-id'] != null ? req.headers['last-event-id'] : req.query.last_event_id;
        const after = Math.max(0, parseInt(raw, 10) || 0);
        const pending = system.eventsAfter(row.id, after);
        // Finished and nothing new since the client's last event: 204 tells EventSource to stop reconnecting.
        if (TERMINAL.has(row.state) && !pending.length) return res.status(204).set('Cache-Control', 'no-store').end();

        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.write('retry: 3000\n\n');
        let last = after, closed = false, replaying = true;
        const queue = [];
        const close = () => { if (closed) return; closed = true; unsubscribe(); offStop(); clearInterval(keepAlive); res.end(); };
        // On shutdown the stream ends; EventSource reconnects to the next process with Last-Event-ID.
        const offStop = system.onStop(close);
        const write = (e) => {
            if (closed || e.seq <= last) return;
            last = e.seq;
            res.write(`id: ${e.seq}\nevent: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
            if (TERMINAL.has(e.data.state) && e.event !== 'job.progress') setImmediate(close);
        };
        // Subscribe before replaying so nothing emitted in between is lost; the seq check drops duplicates.
        const unsubscribe = system.subscribe(row.id, (e) => (replaying ? queue.push(e) : write(e)));
        for (const e of system.eventsAfter(row.id, after)) write(e);
        replaying = false;
        queue.forEach(write);
        const keepAlive = setInterval(() => { if (!closed) res.write(': keep-alive\n\n'); }, 15000);
        if (keepAlive.unref) keepAlive.unref();
        req.on('close', close);
    });

    app.get('/api/v1/jobs/:id/files/:n', async (req, res) => {
        const row = load(req, res, 'read');
        if (!row) return;
        if (row.state !== 'succeeded') return send(res, 409, 'tools.job.not_ready', `The job is ${row.state}`);
        const f = system.resultFile(row, parseInt(req.params.n, 10));
        if (!f) return send(res, 404, 'tools.job.file_not_found', 'No such result file');
        const inline = ['1', 'true'].includes(String(req.query.inline || ''));
        res.set('Cache-Control', 'private, no-store');
        res.set('X-Content-Type-Options', 'nosniff');
        if (f.storage === 'media' && f.media && system.media) {
            try {
                const signed = await system.media.downloadUrl(f.media.media_id);
                // Previews load straight from Media (range requests, no bytes through this server);
                // downloads come through here so the browser saves them under the right name.
                if (inline) return res.redirect(302, signed.url);
                const up = await fetch(signed.internal_url, { signal: AbortSignal.timeout(120_000) });
                if (!up.ok || !up.body) return send(res, 502, 'tools.job.media_unavailable', 'OpenVibe.Media could not return the file');
                res.set({ 'Content-Type': f.mime, 'Content-Disposition': contentDisposition('attachment', f.name) });
                const len = up.headers.get('content-length');
                if (len) res.set('Content-Length', len);
                return Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
            } catch (err) {
                console.error('[Jobs] media download failed:', err.message);
                return send(res, 502, 'tools.job.media_unavailable', 'OpenVibe.Media could not return the file');
            }
        }
        if (!f.path || !fs.existsSync(f.path)) return send(res, 410, 'tools.job.file_gone', 'The result file has expired');
        res.set({ 'Content-Type': f.mime, 'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', f.name) });
        return res.sendFile(f.path);
    });
}

module.exports = { mountJobRoutes, createOwnerResolver, contentDisposition, CAPS };
