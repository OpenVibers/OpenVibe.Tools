'use strict';
// ═══════════════════════════════════════════════════════════════
// The guard's numbers, in one place. Everything per tool comes from its descriptor (tools.tool@1:
// cost, quotaClass, limits.perTargetPerMinute, limits.maxDurationSec, limits.timeoutMs, files.accept);
// everything per caller tier and every host-wide bound is here. Pure data, no dependencies.
//
// Quotas count weight, not requests: a run costs its descriptor's `cost` (1 = a cheap lookup, 5 an
// image conversion, 10 an audio effect, 50 a video download). Each quota class × caller tier has
//   perMinute  a token bucket refilled at this many units a minute (kept in memory)
//   burst      the bucket's size: what may be spent at once after a quiet spell
//   perDay     units per UTC day, persisted in the app's guard.db (0 = no day allowance)
// Tiers: anonymous (keyed by IP, IPv6 by /64) < session (the ov_tools_jobs browser cookie) < user
// (a Network sign-in) < service (a first-party service or a developer app's production token).
// sandbox is a developer app's sandbox token: the smallest allowance, keyed by the app.
//
// The anonymous numbers start from the per-app limits the satellites had (img 10 conversions a
// minute, audio 6, docs 10, net/dev 60 lookups, maps 30 calls, yt 5 downloads an hour); signed-in
// and service tiers get multiples. Normal use of a page stays well inside them.
//
// Class names describe the work, never a tier or a price (decision 6): a paid tier later adds a
// column, not a class. tools-api is the guard's own class for every /api/ request (cost 1).
//
// Overrides (one /etc/openvibe/tools.env for every unit):
//   TOOLS_GUARD_LIMITS='{"tools-job":{"anonymous":{"perDay":800}}}'   merged into QUOTAS
//   and the TOOLS_* variables named below for the host-wide bounds.
// ═══════════════════════════════════════════════════════════════

const TIERS = ['anonymous', 'session', 'user', 'service', 'sandbox'];

const q = (perMinute, burst, perDay) => ({ perMinute, burst, perDay });

const QUOTAS = {
    // Every /api/ request of an app (registry reads, job polls, page context…).
    'tools-api': {
        anonymous: q(120, 60, 0), session: q(180, 90, 0), user: q(480, 240, 0), service: q(2400, 1200, 0), sandbox: q(60, 30, 0),
    },
    // Pure transforms (text and dev engines): cheap, run inline.
    'tools-run': {
        anonymous: q(120, 60, 5000), session: q(180, 90, 10000), user: q(480, 240, 50000), service: q(2400, 1200, 500000), sandbox: q(60, 30, 1000),
    },
    // Lookups that reach a host the caller chose (DNS, WHOIS, headers, Open Graph…); also throttled per target.
    'tools-fetch': {
        anonymous: q(60, 30, 2000), session: q(90, 45, 4000), user: q(240, 120, 20000), service: q(1200, 600, 200000), sandbox: q(30, 15, 500),
    },
    // Network probes (port, ping, latency): traffic to the target itself; also throttled per target.
    'tools-probe': {
        anonymous: q(30, 15, 600), session: q(45, 25, 1000), user: q(120, 60, 5000), service: q(600, 300, 50000), sandbox: q(15, 10, 200),
    },
    // Uploads processed by sharp, ffmpeg, pdf-lib, qpdf, poppler (sync /api/process and job submits).
    'tools-job': {
        anonymous: q(60, 30, 1500), session: q(90, 45, 3000), user: q(240, 120, 20000), service: q(1200, 600, 200000), sandbox: q(30, 15, 300),
    },
    // The map and food finder pages' own lookups (OpenStreetMap, weather), cost 2 a call.
    'tools-map': {
        anonymous: q(60, 40, 6000), session: q(90, 60, 8000), user: q(240, 120, 20000), service: q(1200, 600, 200000), sandbox: q(30, 20, 500),
    },
    // Server downloads (yt: cost 50 each, so anonymous = two at once, one a minute, 30 a day).
    'tools-download': {
        anonymous: q(50, 100, 1500), session: q(75, 150, 2500), user: q(150, 300, 5000), service: q(300, 600, 10000), sandbox: q(25, 50, 100),
    },
};

// All browser sessions from one address together may use this many times one session's allowance:
// dropping the cookie starts a new session, never a new allowance.
const SESSION_IP_SHARE = 3;

// The apps' older per-route limiters (express-rate-limit, requests per window per address, or per
// person when signed in). They stay in force in report mode and step aside with TOOLS_GUARD=enforce,
// where the tiered quotas above take over. [anonymous or session, signed in or service].
const LEGACY = {
    img: { api: [60, 120], process: [10, 30], burst: 4 },
    audio: { api: [60, 120], process: [6, 20], burst: 3 },
    docs: { api: [60, 120], process: [10, 30], burst: 4 },
};

function envInt(name, fallback, env = process.env) {
    const v = parseInt(env[name], 10);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** The host-wide bounds, read from the environment at call time (tests set it per process). */
function bounds(env = process.env) {
    return {
        // Synchronous heavy calls (img, audio, docs /api/process…) running at once per satellite, and
        // how many may wait for a slot, and for how long, before 503 tools.busy.
        sync: {
            concurrency: Math.max(1, envInt('TOOLS_SYNC_CONCURRENCY', 2, env)),
            queue: envInt('TOOLS_SYNC_QUEUE', 8, env),
            waitMs: envInt('TOOLS_SYNC_WAIT_MS', 30_000, env),
        },
        // Every satellite's job store: queued jobs (all owners) and bytes under <dataDir>/jobs.
        jobs: {
            maxQueued: envInt('TOOLS_JOBS_MAX_QUEUED', 200, env),
            diskBudgetBytes: envInt('TOOLS_DISK_BUDGET_MB', 8192, env) * 1024 * 1024,
        },
        // Largest image input decoded by sharp (width × height); OpenVibe.Media uses the same value.
        maxInputPixels: envInt('TOOLS_MAX_INPUT_PIXELS', 40_000_000, env),
        // The port checker: ports per request, and per caller in a rolling window.
        ports: {
            perRequest: 20,
            windowMs: 10 * 60_000,
            perCaller: envInt('TOOLS_PORTS_PER_CALLER', 100, env),
            targetsPerCaller: envInt('TOOLS_PORT_TARGETS_PER_CALLER', 10, env),
        },
        // Webhook request bins (in memory, one hour): per owner, per address, in all.
        webhook: { perOwner: 5, perIp: 10, total: 500 },
        // The abuse log (guard.db) keeps rows this long.
        abuseRetentionDays: 30,
    };
}

function merge(base, over) {
    const out = JSON.parse(JSON.stringify(base));
    for (const [cls, tiers] of Object.entries(over || {})) {
        if (!out[cls]) out[cls] = {};
        for (const [tier, v] of Object.entries(tiers || {})) out[cls][tier] = { ...(out[cls][tier] || q(0, 0, 0)), ...v };
    }
    return out;
}

/** QUOTAS with TOOLS_GUARD_LIMITS merged in (a bad value is reported and ignored). */
function quotas(env = process.env, log = console) {
    const raw = env.TOOLS_GUARD_LIMITS;
    if (!raw) return QUOTAS;
    try { return merge(QUOTAS, JSON.parse(raw)); } catch (err) {
        log.warn(`[Guard] TOOLS_GUARD_LIMITS is not valid JSON (${err.message}); using the defaults`);
        return QUOTAS;
    }
}

module.exports = { TIERS, QUOTAS, SESSION_IP_SHARE, LEGACY, bounds, quotas, merge };
