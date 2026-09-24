'use strict';
// ═══════════════════════════════════════════════════════════════
// The gateway's run API: POST /api/v1/tools/:id/run for every tool (ADR-027; the protocol is
// apps/_shared/tools/run.js). Where each tool runs:
//
//   engines   dev and text tools with a server engine (execution client, api true): in the gateway's
//             engine pool (worker threads: the descriptor's timeoutMs terminates a runaway input, a heap
//             limit applies), the same code the pages run. Cached for 10 minutes unless the spec says
//             cacheTtlMs: 0 (random or time-dependent output).
//   routes    the net tools and Open Graph (execution sync): the /api/net and /api/dev route that already
//             answers the page, called in this process with the run's input as its query (spec.route),
//             so both give the same answer. The per-target throttle applies; answers are cached only
//             where the spec gives a cacheTtlMs (slow-moving lookups, never probes or myip).
//   jobs      img, audio and docs tools: the run is streamed to the satellite that owns the tool
//             (POST /api/v1/tools/:id/run there, uploads and all) and its answer streamed back; the job
//             id is remembered for the /api/v1/jobs facade.
// ═══════════════════════════════════════════════════════════════

const path = require('path');
const { createRunApi, createInputValidator, Refusal } = require('../../../_shared/tools/run');
const { forward } = require('../../../_shared/tools/proxy');
const { poolFromEnv } = require('../../../_shared/jobs/pool');

const ENGINE_TTL_MS = 10 * 60 * 1000;

/** A response stand-in that captures what an Express route handler answers. */
function capture() {
    let settle;
    const done = new Promise((r) => { settle = r; });
    const headers = {};
    const res = {
        statusCode: 200, headersSent: false, locals: {}, writableFinished: false,
        status(n) { this.statusCode = n; return this; },
        set(k, v) { if (k && typeof k === 'object') for (const [a, b] of Object.entries(k)) headers[a.toLowerCase()] = b; else headers[String(k).toLowerCase()] = v; return this; },
        header(k, v) { return this.set(k, v); },
        setHeader(k, v) { headers[String(k).toLowerCase()] = v; },
        getHeader(k) { return headers[String(k).toLowerCase()]; },
        removeHeader(k) { delete headers[String(k).toLowerCase()]; },
        cookie() { return this; },
        on() { return this; }, once() { return this; }, removeListener() { return this; },
        json(body) { this.headersSent = true; settle({ status: this.statusCode, headers, body }); return this; },
        send(body) { let b = body; if (typeof b === 'string' || Buffer.isBuffer(b)) { try { b = JSON.parse(String(b)); } catch { /* text */ } } return this.json(b); },
        end(body) { let b = body; try { b = body == null ? null : JSON.parse(String(body)); } catch { b = String(body); } this.headersSent = true; settle({ status: this.statusCode, headers, body: b }); },
    };
    return { res, done, settle };
}

/** The route handler a router serves for `method path` (path relative to the router, e.g. /dns). */
function routeHandler(router, method, rel) {
    for (const layer of router.stack) {
        if (!layer.route || !layer.route.methods[method.toLowerCase()]) continue;
        const p = layer.route.path;
        if (p === rel || p === `${rel}/:target?`) return layer.route.stack[layer.route.stack.length - 1].handle;
    }
    return null;
}

/** '{target}' templates from the input, falling back to the input schema's defaults. */
function fill(template, input, schema) {
    return String(template).replace(/\{([a-z_]+)\}/gi, (_, k) => {
        const v = input[k] !== undefined ? input[k] : schema && schema.properties && schema.properties[k] && schema.properties[k].default;
        return v === undefined || v === null ? '' : String(v);
    });
}

/** What a legacy route answered → the run's data, or a thrown tool error / refusal. */
function fromRoute(out) {
    if (out.error) throw out.error;
    const body = out.body && typeof out.body === 'object' ? out.body : {};
    if (/problem\+json/.test(String(out.headers['content-type'] || ''))) {
        // A guard refusal inside the route (the port checker's caps): the answer to the request itself.
        const { type, title, status, code, detail, error, request_id, trace_id, ...extra } = body;
        const headers = out.headers['retry-after'] ? { 'Retry-After': String(out.headers['retry-after']) } : undefined;
        throw new Refusal(out.status, code || 'tools.run.invalid', detail || error, extra, headers);
    }
    if (out.status < 400 && body.ok !== false) {
        const { ok, ...data } = body;
        return { data };
    }
    const own = /^tools\.[a-z0-9_.]+$/.test(String(body.code || '')) ? body.code : null;
    const status = out.status === 400 ? 422 : out.status || 500;
    const code = own || (out.status === 400 ? 'tools.input.invalid' : 'tools.job.failed');
    throw Object.assign(new Error(body.error || 'The tool failed'), { status, code });
}

/**
 * @param {object} o
 * @param {object} o.guard  @param {object} o.contracts
 * @param {object} o.toolRegistry        ../registry/descriptors (snapshot, internal)
 * @param {object} o.routers             { net: express.Router, dev: express.Router }
 * @param {() => object} o.ports         satellite ports
 * @param {Function} o.parseJson         express.json() for local runs
 * @param {object} o.jobIndex            job id → satellite (the facade's)
 * @param {object} [o.Ajv] [o.addFormats]
 */
function createGatewayRun(o) {
    const internal = (id) => o.toolRegistry.internal(id);
    const pool = o.pool || poolFromEnv('gateway', path.join(__dirname, 'engine-worker.js'), { size: 2, memoryMb: 256 });
    const handlers = new Map();

    function kind(d) {
        const s = internal(d.id);
        if (!s) return null;
        if (s.engines && s.spec.engine) return 'engine';
        if ((s.app === 'net' || s.app === 'dev') && s.spec.route) return 'route';
        if (s.satellite && d.execution === 'job') return 'satellite';
        return null;
    }

    function handlerFor(d, s) {
        if (handlers.has(d.id)) return handlers.get(d.id);
        const router = o.routers[s.app];
        const base = s.app === 'net' ? '/api/net' : '/api/dev';
        const rel = s.spec.route.path.slice(base.length);
        const h = router ? routeHandler(router, s.spec.route.method, rel) : null;
        handlers.set(d.id, h);
        return h;
    }

    /** Call the tool's route in this process with the run's input as its request. */
    async function viaRoute(d, s, input, ctx) {
        const h = handlerFor(d, s);
        if (!h) throw Object.assign(new Error(`${d.id} has no route here`), { status: 500 });
        const r = s.spec.route;
        const query = {};
        for (const [k, v] of Object.entries(input)) if (k !== 'target') query[k] = Array.isArray(v) ? v.join(',') : String(v);
        for (const [k, v] of Object.entries(r.query || {})) query[k] = fill(v, input, d.input);
        const target = input.target === undefined ? undefined : r.target ? fill(r.target, input, d.input) : String(input.target);
        if (target !== undefined) query.target = target;
        const rel = r.path.replace(/^\/api\/(net|dev)/, '');
        const fake = Object.create(ctx.req);
        Object.defineProperty(fake, 'path', { value: target !== undefined ? `${rel}/${encodeURIComponent(target)}` : rel, enumerable: true });
        fake.params = target !== undefined ? { target } : {};
        fake.query = query;
        fake.method = r.method;
        fake.netTool = d.id;
        fake.body = {};
        const cap = capture();
        Promise.resolve(h(fake, cap.res, (err) => cap.settle({ error: err || new Error('not handled'), headers: {} }))).catch(err => cap.settle({ error: err, headers: {} }));
        return fromRoute(await cap.done);
    }

    const api = createRunApi({
        guard: o.guard, contracts: o.contracts,
        snapshot: () => o.toolRegistry.snapshot(),
        validate: createInputValidator(o.Ajv, o.addFormats),
        parseJson: o.parseJson,
        runs(d) {
            const k = kind(d);
            return k === 'engine' || k === 'route' ? 'inline' : null;
        },
        async inline(d, input, ctx) {
            const s = internal(d.id);
            if (kind(d) === 'engine') {
                try {
                    return await pool.run('run', { module: s.engines, name: s.spec.engine, input }, { timeoutMs: ctx.timeoutMs, signal: ctx.signal });
                } catch (err) {
                    if (err.code === 'tools.busy') throw new Refusal(503, 'tools.busy', err.message, undefined, { 'Retry-After': String(err.retryAfter || 10) });
                    throw err;
                }
            }
            return viaRoute(d, s, input, ctx);
        },
        cacheTtl(d) {
            const s = internal(d.id);
            if (s.spec.cacheTtlMs !== undefined) return s.spec.cacheTtlMs;
            return kind(d) === 'engine' ? ENGINE_TTL_MS : 0;
        },
        // Open Graph throttles its own target inside the route; the net routes' throttle is a router
        // middleware, which a run does not pass through, so it is applied here.
        targetOf: (d, input) => (internal(d.id).app === 'net' && d.egress ? (input.target || null) : null),
        proxy(d, req, res) {
            if (kind(d) !== 'satellite') return false;
            const s = internal(d.id);
            const port = o.ports()[s.satellite];
            if (!port) return false;
            forward(req, res, {
                port,
                onJson: (body) => { const id = body && body.job && body.job.id; if (id) o.jobIndex.set(id, s.satellite); },
            });
            return true;
        },
    });

    return { handle: api.handle, stats: () => ({ ...api.stats(), engines: pool.stats() }), pool, api, kind };
}

module.exports = { createGatewayRun, capture, routeHandler, fromRoute, fill };
