'use strict';
// ═══════════════════════════════════════════════════════════════
// The tool registry routes (capability tools.tool.read, ADR-027), the same on the gateway and on
// every satellite:
//
//   GET /api/v1/tools                 tools.tool-list@1: every descriptor, schemas as { $ref }
//                                     ?family= ?execution=client|sync|job ?api=true|false ?status= ?q=
//   GET /api/v1/tools/:id             tools.tool@1 with its schemas embedded
//   GET /api/v1/tools/:id/schema      { $schema, $id, $defs: { input, output } }
//
// Public and cacheable: Access-Control-Allow-Origin *, an ETag (If-None-Match → 304) and
// Cache-Control: public, max-age=300. An unknown id is 404 problem+json tools.tool.not_found; a bad
// filter value is 400 tools.query.invalid. Framework-free: (req, res, next) with Express's req.path.
//
// The app's CORS middleware must not refuse these paths (exceptRegistry wraps it, and puts the
// open CORS header on anything answered earlier, a rate limiter's 429 included).
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');
const { refForm, schemaDoc } = require('./descriptor');

const PATH_RE = /^\/api\/v1\/tools(?:\/([a-z][a-z0-9-]{0,39})(\/schema)?)?\/?$/;
const EXECUTIONS = new Set(['client', 'sync', 'job']);
const STATUSES = new Set(['stable', 'beta', 'preview', 'unavailable']);
const TITLES = { 400: 'Bad Request', 404: 'Not Found' };
const CACHE_MAX = 200;

const isRegistryPath = (p) => PATH_RE.test(String(p || ''));

function openCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'ETag');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
}

// The run API and the jobs API take calls from any site's page with a token (openvibe-sdk in a
// browser): such an origin gets CORS without credentials (so the browser never sends our cookies
// along); first-party pages keep the app's own credentialed CORS.
const RUN_OR_JOBS_RE = /^\/api\/v1\/(?:tools\/[a-z][a-z0-9-]{0,39}\/run|jobs(?:\/.*)?)\/?$/;
const isPublicApiPath = (p) => RUN_OR_JOBS_RE.test(String(p || ''));
const API_HEADERS = 'Authorization, Content-Type, Idempotency-Key, Last-Event-ID, Cache-Control, traceparent, X-OpenVibe-Request-Id';
const API_EXPOSE = 'Location, Idempotent-Replayed, Retry-After, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, X-OpenVibe-Request-Id, traceparent, Content-Disposition, Deprecation, Sunset, Link';

/**
 * Wrap an app's CORS middleware: registry paths skip it and are open to every origin instead; run and
 * jobs paths from an origin the app does not know (isFirstParty false) get CORS without credentials.
 * @param {Function} corsMiddleware
 * @param {{ isFirstParty?: (origin) => boolean }} [opts]
 */
function exceptRegistry(corsMiddleware, opts = {}) {
    return function corsExceptToolRegistry(req, res, next) {
        if (isRegistryPath(req.path)) { openCors(res); return next(); }
        const origin = req.headers.origin;
        if (opts.isFirstParty && origin && isPublicApiPath(req.path) && !opts.isFirstParty(origin)) {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Expose-Headers', API_EXPOSE);
            res.setHeader('Vary', 'Origin');
            if (req.method === 'OPTIONS') {
                res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
                res.setHeader('Access-Control-Allow-Headers', API_HEADERS);
                res.setHeader('Access-Control-Max-Age', '600');
                res.statusCode = 204;
                return res.end();
            }
            return next();
        }
        return corsMiddleware(req, res, next);
    };
}

/** Does If-None-Match name this ETag (weak or strong, one of a list, or *)? */
function matches(header, etag) {
    if (!header) return false;
    const want = etag.replace(/^W\//, '');
    return String(header).split(',').some(t => { const v = t.trim(); return v === '*' || v.replace(/^W\//, '') === want; });
}

/** Filters from the query string → { key (cache key), test(d, meta) } or { error }. */
function parseFilters(url) {
    const sp = new URL(url, 'http://registry.invalid').searchParams;
    const list = (k) => [...new Set(sp.getAll(k).flatMap(v => String(v).split(',')).map(v => v.trim().toLowerCase()).filter(Boolean))].sort();
    const family = list('family');
    const execution = list('execution');
    const status = list('status');
    const apiRaw = sp.get('api');
    const q = String(sp.get('q') || '').trim().toLowerCase().slice(0, 100);
    const bad = execution.find(e => !EXECUTIONS.has(e)) || status.find(s => !STATUSES.has(s));
    if (bad) return { error: `Unknown filter value "${bad}": execution is client, sync or job; status is stable, beta, preview or unavailable.` };
    if (apiRaw != null && apiRaw !== '' && !['true', 'false'].includes(apiRaw)) return { error: 'api is true or false.' };
    const api = apiRaw === 'true' ? true : apiRaw === 'false' ? false : null;
    const words = q.split(/\s+/).filter(Boolean);
    return {
        key: JSON.stringify([family, execution, status, api, words]),
        test(d, meta) {
            if (family.length && !family.includes(d.family)) return false;
            if (execution.length && !execution.includes(d.execution)) return false;
            if (status.length && !status.includes(d.status)) return false;
            if (api !== null && d.api !== api) return false;
            if (words.length) {
                const hay = [d.id, d.name, d.summary, ...(meta.keywords || [])].join(' ').toLowerCase();
                if (!words.every(w => hay.includes(w))) return false;
            }
            return true;
        },
    };
}

/**
 * @param {object} o
 * @param {() => object} o.snapshot  the registry now: { version, updatedAt, tools: [descriptor (embedded)],
 *                                   meta: Map(id → { keywords }), families: Map(id → name),
 *                                   gone: Map(id → why it is not a tool, e.g. planned) }
 */
function createToolsApi(o) {
    const cache = new Map();
    let cacheVersion = null;

    function entry(version, key, build) {
        if (cacheVersion !== version) { cache.clear(); cacheVersion = version; }
        let e = cache.get(key);
        if (!e) {
            const body = JSON.stringify(build());
            e = { body, etag: `"${crypto.createHash('sha1').update(body).digest('base64url').slice(0, 27)}"` };
            if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
            cache.set(key, e);
        }
        return e;
    }

    function send(req, res, e, type) {
        openCors(res);
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.setHeader('ETag', e.etag);
        if (matches(req.headers['if-none-match'], e.etag)) { res.statusCode = 304; return res.end(); }
        res.statusCode = 200;
        res.setHeader('Content-Type', type);
        res.setHeader('Content-Length', Buffer.byteLength(e.body));
        return res.end(req.method === 'HEAD' ? undefined : e.body);
    }

    function problem(req, res, status, code, detail) {
        const body = JSON.stringify({ type: `https://openvibe.network/problems/${code}`, title: TITLES[status], status, code, detail, error: detail });
        openCors(res);
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/problem+json');
        res.setHeader('Cache-Control', status === 404 ? 'public, max-age=60' : 'no-store');
        return res.end(req.method === 'HEAD' ? undefined : body);
    }

    return function toolRegistry(req, res, next) {
        const m = PATH_RE.exec(req.path);
        if (!m) return next();
        if (req.method === 'OPTIONS') {
            openCors(res);
            res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'If-None-Match, Accept, Authorization');
            res.setHeader('Access-Control-Max-Age', '86400');
            res.statusCode = 204;
            return res.end();
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        const snap = o.snapshot();
        const [, id, schema] = m;

        if (!id) {
            const f = parseFilters(req.originalUrl || req.url);
            if (f.error) return problem(req, res, 400, 'tools.query.invalid', f.error);
            const e = entry(snap.version, `list:${f.key}`, () => {
                const tools = snap.tools.filter(d => f.test(d, snap.meta.get(d.id) || {}));
                const counts = new Map();
                for (const d of tools) counts.set(d.family, (counts.get(d.family) || 0) + 1);
                return {
                    tools: tools.map(refForm), count: tools.length, updated_at: snap.updatedAt,
                    families: [...counts].map(([fid, count]) => ({ id: fid, name: snap.families.get(fid) || fid, count })),
                };
            });
            return send(req, res, e, 'application/json; charset=utf-8');
        }

        const d = snap.tools.find(t => t.id === id);
        if (!d) return problem(req, res, 404, 'tools.tool.not_found', snap.gone.get(id) || `No tool is called "${id}". GET /api/v1/tools lists them all.`);
        if (schema) return send(req, res, entry(snap.version, `schema:${id}`, () => schemaDoc(d)), 'application/schema+json; charset=utf-8');
        return send(req, res, entry(snap.version, `tool:${id}`, () => d), 'application/json; charset=utf-8');
    };
}

module.exports = { createToolsApi, exceptRegistry, isRegistryPath, isPublicApiPath, parseFilters, PATH_RE };
