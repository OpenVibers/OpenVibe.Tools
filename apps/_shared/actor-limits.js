'use strict';
// ═══════════════════════════════════════════════════════════════
// Per-actor rate limits (roadmap WS-R task 4; openvibe-sdk/limits), one limiter per app, only where
// the guard (./guard) has no per-caller limit of its own. The guard is not changed: its tiered quotas
// (quotaClass × tier × cost, day allowances), the per-target throttle and TOOLS_GUARD's report/enforce
// mode stay exactly as they are. These limits read the
// guard's resolved caller (guard.caller) and add:
//
//   registry reads   GET/HEAD /api/v1/tools[/:id[/schema]] by a signed-in person or a third-party
//                    principal (app:…, mod:…): TOOLS_LIMITS_MINUTE / TOOLS_LIMITS_HOUR, 120 and 3000.
//                    Signed-out reads (a browser session or nobody) keep only the per-address /api/
//                    limit, since many visitors share a carrier or campus address; a first-party
//                    service (svc:…) reading for itself is not counted, and neither is the gateway's
//                    minute poll of each satellite's list (loopback, no token).
//   backstop         job submits and retries (POST /api/v1/jobs, /api/v1/jobs/:id/retry) and runs
//                    (POST /api/v1/tools/:id/run): a ceiling ABOVE the guard's quotas, so it never
//                    decides a normal caller's allowance (the guard does) and still stops a runaway
//                    one while the guard only reports (TOOLS_GUARD=report, for local debugging).
//   admin            the gateway's /api/internal/analytics (the Network admin's analytics page).
//
// Counted: a person as user:usr_…, a service or app by its principal (svc:…, app:…), a browser session
// or nobody by the guard's hashed address key (ip:<HMAC>), so dropping the session cookie resets
// nothing and no raw address is ever logged. Past a limit: 429 problem+json `rate_limited` with
// Retry-After, one [Limits] log line and tools_rate_limited_total{limit,window}. Counters live in the
// process: a restart forgets them.
//
// Never limited: /api/health, /api/ready, /release.json, /metrics, the pages, /api/internal/jobs/:id
// (the facade's loopback lookup) and the signed /internal/events deliveries (sign-out cutoffs).
//
// apps/_shared takes no dependencies: the app passes openvibe-sdk/limits' createActorLimiter.
//
//   const limits = createToolsLimits({ app: 'img', createActorLimiter: require('openvibe-sdk/limits').createActorLimiter, guard, registry: obs.registry });
//   app.use(limits.registryReads);                            // before createToolsApi
//   setupJobs({ …, limiters: [limits.backstop('tools.job.create'), …] });
// ═══════════════════════════════════════════════════════════════

const REGISTRY_RE = /^\/api\/v1\/tools(?:\/[^/]+(?:\/schema)?)?\/?$/;
const FIRST_PARTY = /^svc:/;

// The backstop, per caller. The guard's highest per-minute allowance is tools-run's: a person 480, a
// principal (service tier) 2400, and all browser sessions of one address together 3 × 180 = 540; its day
// allowances average at most about 2100 an hour for a person and 21 000 for a service. These ceilings sit
// above every one of them, so only a caller far beyond its quota (while the guard reports) meets them.
const BACKSTOP = {
    principal: { minute: 3000, hour: 100000 },
    person: { minute: 600, hour: 20000 },
};

// The Network admin's analytics page: each call reads up to 365 days of analytics in every satellite.
// An admin opens the page now and then; 30 a minute leaves room for reloads.
const ADMIN = { minute: 30, hour: 300 };

const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };

/**
 * @param {object} o
 * @param {string} o.app                    this app's name (the log line)
 * @param {Function} o.createActorLimiter   openvibe-sdk/limits
 * @param {object} o.guard                  this app's guard (guard.caller resolves who is asking)
 * @param {object} [o.registry]             the app's metrics registry (tools_rate_limited_total)
 * @param {object} [o.env]                  TOOLS_LIMITS_MINUTE, TOOLS_LIMITS_HOUR
 * @param {object} [o.log]
 * @param {() => number} [o.now]            the limiter's clock (tests)
 */
function createToolsLimits(o) {
    const env = o.env || process.env;
    const log = o.log || console;
    const guard = o.guard;
    const defaults = { minute: Math.max(1, int(env.TOOLS_LIMITS_MINUTE, 120)), hour: Math.max(1, int(env.TOOLS_LIMITS_HOUR, 3000)) };
    const refused = o.registry
        ? o.registry.counter({ name: 'tools_rate_limited_total', help: 'Requests refused 429 by a per-actor limit, by limit name and window', labelNames: ['limit', 'window'] })
        : null;

    /** user:usr_… or the principal's sub; a session or nobody by the guard's hashed address key. */
    function actor(req) {
        const c = guard.caller(req);
        if (c.kind === 'principal' || c.kind === 'user') return c.key;
        return c.ipKey;
    }

    const limiter = o.createActorLimiter({
        limits: defaults,
        actor,
        now: o.now,
        onLimited(e) {
            // The actor is a subject id, a principal or a hashed address key, never a token or an address.
            log.warn(`[Limits] ${o.app}: ${e.name}: ${e.actor} refused, over ${e.limit} per ${e.window}`);
            if (refused) refused.inc({ limit: e.name, window: e.window });
        },
    });

    /** Counted on registry reads: a signed-in person or a third-party principal. */
    function countedRead(req) {
        const c = guard.caller(req);
        if (c.kind === 'user') return true;
        return c.kind === 'principal' && !FIRST_PARTY.test(String(c.key));
    }

    const read = limiter('tools.tool.read');
    function registryReads(req, res, next) {
        if ((req.method !== 'GET' && req.method !== 'HEAD') || !REGISTRY_RE.test(req.path) || !countedRead(req)) return next();
        // The registry is open to every origin: a refusal must be readable there too.
        res.setHeader('Access-Control-Allow-Origin', '*');
        return read(req, res, next);
    }

    const backstops = new Map();
    /** The ceiling above the guard's quotas for `name` (tools.job.create, tools.tool.run). */
    function backstop(name) {
        if (!backstops.has(name)) {
            const principal = limiter(name, BACKSTOP.principal);
            const person = limiter(name, BACKSTOP.person);
            backstops.set(name, function actorBackstop(req, res, next) {
                return (guard.caller(req).kind === 'principal' ? principal : person)(req, res, next);
            });
        }
        return backstops.get(name);
    }

    const admin = limiter('tools.analytics.read', ADMIN);

    return { registryReads, backstop, admin, limiter, actor, countedRead, defaults };
}

module.exports = { createToolsLimits, REGISTRY_RE, BACKSTOP, ADMIN };
