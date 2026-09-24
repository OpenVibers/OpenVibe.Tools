'use strict';
// ═══════════════════════════════════════════════════════════════
// The gateway's jobs facade (ADR-027): https://openvibe.tools/api/v1/jobs… fronts every satellite's
// job routes, so a client (openvibe-sdk/jobs without a baseUrl, the run API's Location) needs one origin.
//
//   POST   /api/v1/jobs                     routed by the job type's prefix (img.process → img, …): from
//                                          ?type=, the JSON body, or the multipart `type` part (read from
//                                          the head of the stream; the uploads then stream through)
//   GET    /api/v1/jobs/:id                 routed by the job id: the satellite that answered its submit or
//   DELETE /api/v1/jobs/:id                 run (remembered here), else the one that says it holds the job
//   GET    /api/v1/jobs/:id/events          when asked on loopback (GET /api/internal/jobs/:id, direct
//   GET    /api/v1/jobs/:id/files/:n        callers only). Events (SSE) and files stream through.
//   POST   /api/v1/jobs/:id/retry
//   PUT    /api/v1/jobs/:id/references/:ref
//   DELETE /api/v1/jobs/:id/references/:ref
//
// The satellite does everything else (owner scoping, quotas, the Origin check, idempotency): the
// request reaches it with the caller's credentials and address, as through the host proxy.
// ═══════════════════════════════════════════════════════════════

const { forward } = require('../../../_shared/tools/proxy');
const { JOB_SATELLITES, satelliteForType } = require('../../../_shared/tools/satellites');

const ID_RE = /^job_[0-9A-HJKMNP-TV-Z]{26}$/;
const PATH_RE = /^\/api\/v1\/jobs(?:\/([^/]+)(\/.*)?)?\/?$/;
const PEEK_MAX = 64 * 1024;
const JSON_MAX = 1024 * 1024;
const TYPE_RE = /^[a-z][a-z0-9]*\.[a-z0-9_.]+$/;

const isJobsPath = (p) => PATH_RE.test(String(p || ''));

/** Job id → satellite, most recent first, bounded. */
function createJobIndex(max = 50_000) {
    const map = new Map();
    return {
        get: (id) => map.get(id) || null,
        set(id, sat) { if (!ID_RE.test(String(id)) || !JOB_SATELLITES.includes(sat)) return; map.delete(id); map.set(id, sat); if (map.size > max) map.delete(map.keys().next().value); },
        size: () => map.size,
    };
}

/** Read the start of a multipart body until the `type` part → { type, head, ended }. */
function peekMultipartType(req) {
    return new Promise((resolve) => {
        const chunks = [];
        let size = 0, finished = false;
        const re = /content-disposition:\s*form-data;\s*name="type"(?:;[^\r\n]*)?\r\n(?:[^\r\n]+\r\n)*\r\n([^\r\n]*)\r\n/i;
        const done = (type, ended) => {
            if (finished) return;
            finished = true;
            req.removeListener('data', onData); req.removeListener('end', onEnd); req.removeListener('error', onEnd);
            if (!ended) req.pause();
            resolve({ type, head: Buffer.concat(chunks), ended });
        };
        const onData = (c) => {
            chunks.push(c); size += c.length;
            const m = re.exec(Buffer.concat(chunks).toString('latin1'));
            if (m) return done(m[1].trim(), false);
            if (size > PEEK_MAX) return done(null, false);
            return undefined;
        };
        const onEnd = () => { const m = re.exec(Buffer.concat(chunks).toString('latin1')); done(m ? m[1].trim() : null, true); };
        req.on('data', onData);
        req.on('end', onEnd);
        req.on('error', onEnd);
    });
}

/** The whole (small) body → Buffer, or null past `max`. */
function readAll(req, max) {
    return new Promise((resolve) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => { size += c.length; if (size <= max) chunks.push(c); });
        req.on('end', () => resolve(size <= max ? Buffer.concat(chunks) : null));
        req.on('error', () => resolve(null));
    });
}

/**
 * @param {object} o
 * @param {() => object} o.ports        satellite ports
 * @param {object} o.index              createJobIndex()
 * @param {object} o.contracts
 * @param {Function} [o.fetchImpl]
 */
function createJobsFacade(o) {
    const fetchImpl = o.fetchImpl || fetch;
    const counts = { submitted: 0, routed: 0, probed: 0, not_found: 0 };
    const problem = (req, res, status, code, detail) => {
        res.setHeader('Cache-Control', 'no-store');
        // A body left unread (a refused upload): read and discard it, so the connection stays usable.
        if (!req.readableEnded) req.resume();
        return o.contracts.http.sendProblem(res, status, code, { detail, ctx: req.ov });
    };
    const remember = (sat) => (body) => { if (body && body.id && body.object === 'tools.job') o.index.set(body.id, sat); };

    /** Which satellite holds job `id`: remembered, else asked (in parallel, on loopback). */
    async function locate(id) {
        const known = o.index.get(id);
        if (known) return known;
        counts.probed++;
        const ports = o.ports();
        const answers = await Promise.all(JOB_SATELLITES.filter(s => ports[s]).map(async (sat) => {
            try {
                const r = await fetchImpl(`http://127.0.0.1:${ports[sat]}/api/internal/jobs/${id}`, { signal: AbortSignal.timeout(2500) });
                return r.status === 200 ? sat : null;
            } catch { return null; }
        }));
        const sat = answers.find(Boolean) || null;
        if (sat) o.index.set(id, sat);
        return sat;
    }

    async function submit(req, res) {
        let type = typeof req.query.type === 'string' ? req.query.type : null;
        let body = null, head = null;
        if (!type) {
            if (req.is('multipart/form-data')) {
                const p = await peekMultipartType(req);
                type = p.type;
                if (p.ended) body = p.head; else head = p.head;
            } else {
                body = await readAll(req, JSON_MAX);
                if (!body) return problem(req, res, 413, 'tools.job.too_large', 'A JSON job request is at most 1 MB; send files as multipart.');
                try { const j = JSON.parse(body.toString('utf8') || '{}'); type = j && typeof j.type === 'string' ? j.type : null; } catch {
                    return problem(req, res, 400, 'tools.job.invalid', 'The body is not valid JSON.');
                }
            }
        }
        if (!type || !TYPE_RE.test(type)) return problem(req, res, 400, 'tools.job.invalid', 'Name the job type (img.process, audio.process or docs.process): the `type` field, as the first multipart part, or ?type=.');
        const sat = satelliteForType(type);
        const port = sat && o.ports()[sat];
        if (!port) return problem(req, res, 400, 'tools.job.unknown_type', `Unknown job type "${type}". Known: ${JOB_SATELLITES.map(s => `${s}.process`).join(', ')}`);
        counts.submitted++;
        return forward(req, res, { port, ...(body ? { body } : { head }), onJson: remember(sat) });
    }

    return {
        async handle(req, res, next) {
            const m = PATH_RE.exec(req.path);
            if (!m) return next();
            if (req.method === 'OPTIONS') return next();
            try {
                const [, id, rest] = m;
                if (!id) {
                    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return problem(req, res, 405, 'method_not_allowed', 'POST a job; GET /api/v1/jobs/:id reads one.'); }
                    return await submit(req, res);
                }
                if (!ID_RE.test(id)) return problem(req, res, 404, 'tools.job.not_found', 'No such job');
                const sat = await locate(id);
                if (!sat) { counts.not_found++; return problem(req, res, 404, 'tools.job.not_found', 'No such job'); }
                counts.routed++;
                const port = o.ports()[sat];
                const learns = req.method === 'POST' && rest === '/retry';
                return await forward(req, res, { port, ...(learns && { onJson: remember(sat) }) });
            } catch (err) {
                return next(err);
            }
        },
        stats: () => ({ ...counts, known: o.index.size() }),
        locate,
    };
}

module.exports = { createJobsFacade, createJobIndex, peekMultipartType, isJobsPath, PATH_RE };
