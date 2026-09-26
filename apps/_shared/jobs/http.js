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
//   GET    /api/internal/jobs/:id        direct loopback callers only (the gateway's jobs facade asking
//                                        which satellite holds a job): 200 { id, service } | 404
//
// Owner scoping: a job is visible only to whoever created it —
//   a Network user (user:usr_…, from the ov_token subject_id), a service/app principal presenting a
//   Network client-credentials token for audience openvibe.tools with tools.job.* capabilities, or,
//   for everyone else, this browser's jobs session cookie. Anyone else gets the same 404 as for a
//   job that does not exist. Errors are RFC 9457 problem+json.
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const { createCallerResolver, jobOwnerResolver, JOB_CAPS: CAPS } = require('../guard/caller');
const { isLoopback } = require('../guard/ip');

const ID_RE = /^job_[0-9A-HJKMNP-TV-Z]{26}$/;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const CLIENT_JS = path.join(__dirname, 'client.js');

function contentDisposition(kind, name) {
    const ascii = String(name || 'result').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(String(name || 'result'))}`;
}

/**
 * Who is asking. → { owner, kind: 'principal'|'user'|'session', claims?, env } | { error: [status, code, detail] } | null
 * The guard's one caller resolver (apps/_shared/guard/caller.js); an app with a guard passes
 * guard.ownerResolver() instead, which is the same resolver with the guard's daily address salt.
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
    return jobOwnerResolver(createCallerResolver({ contracts: o.contracts, getPublicKey: o.getPublicKey, issuer: o.issuer, audience: o.audience, cookieName: o.cookieName, secureCookie: o.secureCookie }));
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
 * @param {(req, res, { type, input, files }) => Promise<boolean>} [o.admit]  the guard's admission of a
 *        submit once its body is parsed (session rule, the bytes against the tool's accept, the quota
 *        difference); false = it answered
 * @param {(req, res, busy) => boolean} [o.onBusy]  system.busy() said so: true = go on (report mode);
 *        without it a busy store answers 503 tools.busy
 * @param {(req, res, full) => boolean} [o.onAddressFull]  a browser session's address already has its
 *        unfinished jobs (system.addressFull): true = go on (report mode); without it 429
 * @param {Function} [o.originCheck]  middleware for the writes (submit, cancel, retry, references): the
 *        guard's Origin check on cookie-authenticated calls (CSRF)
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

    const origin = o.originCheck || ((_req, _res, next) => next());

    // Which satellite holds a job? Only for a caller on this host with no proxy in between (the
    // gateway's facade); through nginx or the gateway's own proxy it is not found. Says nothing but
    // whether the id exists here.
    app.get('/api/internal/jobs/:id', (req, res) => {
        res.set('Cache-Control', 'no-store');
        const direct = isLoopback(req.socket && req.socket.remoteAddress) && !req.headers['x-forwarded-for'] && !req.headers['x-real-ip'];
        const id = String(req.params.id || '');
        if (!direct || !ID_RE.test(id) || !system.get(id)) return send(res, 404, 'tools.job.not_found', 'No such job');
        return res.json({ id, service: system.service || null });
    });

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

    // Over the store's bounds (queued jobs, disk): answer before an upload is accepted.
    const notBusy = (req, res, next) => {
        const busy = system.busy ? system.busy() : null;
        if (!busy) return next();
        if (o.onBusy) return o.onBusy(req, res, busy) ? next() : undefined;
        res.set('Retry-After', String(busy.retryAfter || 30));
        return send(res, 503, 'tools.busy', busy.detail);
    };

    app.post('/api/v1/jobs', origin, ...(o.limiters || []), notBusy, multipartOnly, async (req, res) => {
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
        // Sessions from one address share a bound on unfinished jobs: a new cookie is no new allowance.
        const full = w.caller && system.addressFull ? system.addressFull(w.owner, w.caller.ipKey) : null;
        if (full) {
            const goOn = o.onAddressFull ? o.onAddressFull(req, res, full) : (send(res, 429, 'tools.job.too_many_active', `At most ${full.limit} unfinished jobs from one address at a time; wait for one to finish`), false);
            if (!goOn) { for (const f of files) if (f.path) fs.unlink(f.path, () => {}); return; }
        }
        if (o.admit) {
            let ok = false;
            try { ok = await o.admit(req, res, { type: String(b.type || ''), input, files }); } catch (err) {
                console.error('[Jobs] admission failed:', err.message);
                if (!res.headersSent) send(res, 500, 'tools.job.submit_failed', 'The job could not be accepted');
            }
            if (!ok) { for (const f of files) if (f.path) fs.unlink(f.path, () => {}); return; }
        }
        try {
            const { job, replayed } = await system.submit({ owner: w.owner, type: String(b.type || ''), input, files, idempotencyKey: key, ttlMs: ttlMs(req, w), env: w.env || 'production', ipKey: w.caller ? w.caller.ipKey : null, project: w.kind === 'principal' && w.claims && w.claims.actor_type === 'app' ? w.claims.project_id : null });
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

    app.delete('/api/v1/jobs/:id', origin, (req, res) => {
        noStore(res);
        const row = load(req, res, 'cancel');
        if (!row) return;
        if (row.state === 'succeeded' || row.state === 'failed') return send(res, 409, 'tools.job.already_finished', `The job already ${row.state}`, { state: row.state });
        const { job } = system.cancel(row.id);
        return res.status(job.state === 'cancelled' ? 200 : 202).json(system.view(job));
    });

    // Retry and references are writes: a principal needs tools.job.create, like a submit.
    app.post('/api/v1/jobs/:id/retry', origin, ...(o.limiters || []), notBusy, (req, res) => {
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
    app.put('/api/v1/jobs/:id/references/:ref', origin, referenceRoute((id, ref) => system.reference(id, ref)));
    app.delete('/api/v1/jobs/:id/references/:ref', origin, referenceRoute((id, ref) => system.unreference(id, ref)));

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
