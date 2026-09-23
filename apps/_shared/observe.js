'use strict';
// ═══════════════════════════════════════════════════════════════
// Observability for the gateway and every satellite (roadmap Track O): Prometheus metrics at
// GET /metrics (direct loopback callers only) and a truthful GET /api/ready built from each server's
// real dependencies. Like the rest of apps/_shared it has no dependencies of its own: the app passes
// openvibe-shared/metrics and openvibe-shared/ready.
//
//   const obs = require('../../_shared/observe').observe({
//       app, metrics: require('openvibe-shared/metrics'), ready: require('openvibe-shared/ready'),
//       service: 'tools-img', release: release.release,
//       checks: [ checks.sqlite('analytics_db', analyticsDb, { required: false }), … ],
//       jobs: () => jobs,          // the satellite's job system, once it exists (tools_jobs{app,state})
//   });
//
// Call it right after `const app = express()`, before any other middleware: the HTTP metrics must
// see every request, and /metrics and /api/ready answer before CORS, host guards and rate limits.
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

/**
 * @param {object} o
 * @param {object} o.app
 * @param {object} o.metrics     require('openvibe-shared/metrics')
 * @param {object} o.ready       require('openvibe-shared/ready')
 * @param {string} o.service     'tools' (gateway) | 'tools-<app>'
 * @param {string} o.release
 * @param {object[]} [o.checks]  openvibe-shared/ready checks
 * @param {() => object|null} [o.jobs]  the job system (apps/_shared/jobs), read lazily
 * @param {Function} [o.normalize]      route label for requests no Express route matched
 * @param {Function} [o.skip]           requests never recorded (long-lived streams)
 * @param {Function} [o.details]        extra readiness fields
 * @param {boolean} [o.mountReady]      false: the caller mounts readiness.handler where it belongs
 */
function observe(o) {
    const app = o.app;
    const inst = o.metrics.instrument(app, {
        service: o.service,
        release: o.release,
        // Requests no route matched (static files, SPA pages, the gateway's proxied satellites) get a
        // fixed label from the app, never their URL.
        normalize: (req, res) => {
            if (req.route) return null;
            if (o.normalize) { const l = o.normalize(req, res); if (l) return l; }
            return res.statusCode === 404 ? null : 'static';
        },
        // Job progress streams (SSE) last as long as the job; their duration is not a latency.
        skip: (req) => /^\/api\/v1\/jobs\/[^/]+\/events$/.test(req.path) || (o.skip ? o.skip(req) : false),
    });
    const appName = o.service.replace(/^tools-?/, '') || 'gateway';
    if (o.jobs) {
        inst.registry.gauge({
            name: 'tools_jobs', help: 'Jobs in this satellite\'s job store by state', labelNames: ['app', 'state'],
            collect: () => {
                const sys = o.jobs();
                if (!sys) return null;
                return Object.entries(sys.store.counts()).map(([state, n]) => ({ labels: { app: appName, state }, value: n }));
            },
        });
        inst.registry.gauge({
            name: 'tools_jobs_executing', help: 'Jobs executing in this process now, and the concurrency limit', labelNames: ['app', 'kind'],
            collect: () => {
                const sys = o.jobs();
                if (!sys) return null;
                const s = sys.stats();
                return [{ labels: { app: appName, kind: 'executing' }, value: s.executing }, { labels: { app: appName, kind: 'limit' }, value: s.concurrency }];
            },
        });
    }
    const readiness = o.ready.createReadiness({ service: o.service, release: o.release, checks: o.checks || [], details: o.details });
    // The gateway mounts it itself, after its host router: on a satellite's host /api/ready is the satellite's.
    if (o.mountReady !== false) app.get('/api/ready', readiness.handler);
    return { registry: inst.registry, readiness, stop: inst.stop };
}

// ── Check builders ──────────────────────────────────────────────

const checks = {
    /** A real query on a better-sqlite3 handle (or a function returning one). */
    sqlite(name, db, { required = true, sql = 'SELECT 1 AS ok', description } = {}) {
        return {
            name, required, description,
            check: () => {
                const h = typeof db === 'function' ? db() : db;
                if (!h) return 'database not open';
                const row = h.prepare(sql).get();
                return row ? true : 'query returned no row';
            },
        };
    },

    /** This process can write to the directory (a real create + remove). A missing directory is
     *  created first, as the app itself does on first use (mkdir -p). */
    writableDir(name, dir, { required = true, description } = {}) {
        return {
            name, required, description,
            check: () => {
                fs.mkdirSync(dir, { recursive: true });
                const p = path.join(dir, `.ready-${process.pid}-${Date.now()}`);
                fs.writeFileSync(p, '');
                fs.unlinkSync(p);
                return true;
            },
        };
    },

    /** The job runtime: started and not stopped, its store answering (counts are a real query). */
    jobRuntime(name, getSystem, { required = true, description = 'job runtime: worker started, jobs.db answering' } = {}) {
        return {
            name, required, description,
            check: () => {
                const sys = getSystem();
                if (!sys) return 'job runtime not set up yet';
                if (!sys.isRunning()) return 'job runtime is not running';
                const s = sys.stats();   // store.counts() inside: a real query on jobs.db
                return { ok: true, detail: { queued: s.queued, running: s.running, executing: s.executing, concurrency: s.concurrency, results: s.results } };
            },
        };
    },

    /** An executable on PATH (or at an explicit path). Looked up, not run. */
    binary(name, bin, { required = false, description, env = process.env } = {}) {
        return {
            name, required, description, cacheMs: 60_000,
            check: () => {
                const found = which(bin, env);
                return found ? { ok: true, detail: { path: found } } : `${bin} not found`;
            },
        };
    },

    /** A file this process must be able to read (cookies, keys). */
    readableFile(name, file, { required = false, description } = {}) {
        return {
            name, required, description,
            check: () => { fs.accessSync(file, fs.constants.R_OK); return true; },
        };
    },

    /** The Network public key used to verify tokens offline is loaded. */
    networkKey(name, getKey, { required = false, description } = {}) {
        return {
            name, required, description,
            check: () => (getKey() ? true : 'Network public key not loaded'),
        };
    },

    /** Another server's /api/ready (or any URL): up when it answers 2xx within the timeout. */
    upstream(name, url, { required = false, description, cacheMs = 15_000, timeoutMs = 1500, fetchImpl = (...a) => globalThis.fetch(...a) } = {}) {
        return {
            name, required, description, cacheMs, timeoutMs,
            check: async () => {
                const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
                let body = null;
                try { body = await res.json(); } catch { /* not JSON */ }
                const status = body && typeof body.status === 'string' ? body.status : null;
                if (!res.ok) return `answered HTTP ${res.status}${status ? ` (${status}${body.failed && body.failed.length ? `: ${body.failed.join(', ')}` : ''})` : ''}`;
                return { ok: true, detail: { http_status: res.status, status: status || 'up', degraded: body && Array.isArray(body.degraded) ? body.degraded : [] } };
            },
        };
    },
};

function which(bin, env = process.env) {
    const exe = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };
    if (bin.includes('/')) return exe(bin) ? bin : null;
    for (const dir of String(env.PATH || '').split(path.delimiter)) {
        if (!dir) continue;
        const p = path.join(dir, bin);
        if (exe(p)) return p;
    }
    return null;
}

module.exports = { observe, checks, which };
