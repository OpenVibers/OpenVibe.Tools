'use strict';
// ═══════════════════════════════════════════════════════════════
// Tools job runtime (roadmap Wave 11). Shared by the satellites the way apps/_shared always is:
// required by relative path, no dependencies of its own — each app passes its better-sqlite3 and
// openvibe-contracts. See system.js (lifecycle), http.js (routes), media.js (results in Media),
// client.js (browser helper).
//
// Environment (one /etc/openvibe/tools.env for every unit):
//   TOOLS_JOBS_CONCURRENCY           jobs running at once per satellite (default 2)
//   TOOLS_JOBS_CONCURRENCY_<APP>     per-satellite override, e.g. TOOLS_JOBS_CONCURRENCY_AUDIO=1
//   TOOLS_JOBS_MAX_ACTIVE            unfinished jobs per owner (default 10)
//   TOOLS_JOB_RESULTS                local (default) | media — where result files go
//   TOOLS_MEDIA_NAMESPACE            Media namespace for results (default tools)
//   OV_MEDIA_INTERNAL_URL            Media on this host (default http://127.0.0.1:4100; MEDIA_URL is read as a fallback)
//   OV_MEDIA_URL                     Media's public origin, for the CSP of previews (default https://openvibe.media)
//   OV_NETWORK_INTERNAL_URL          token endpoint host (default http://127.0.0.1:4000)
//   OV_OAUTH_CLIENT_ID / OV_OAUTH_CLIENT_SECRET   the tools client (client_credentials for Media)
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { createJobSystem, JobError } = require('./system');
const { mountJobRoutes, createOwnerResolver, contentDisposition, CAPS } = require('./http');
const { createMediaResults } = require('./media');

function envInt(name, fallback) {
    const v = parseInt(process.env[name], 10);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** Result storage from the environment → { media, mode, reason } (media is null for local). */
function mediaFromEnv(contracts, env = process.env) {
    const want = String(env.TOOLS_JOB_RESULTS || 'local').toLowerCase();
    if (want !== 'media') return { media: null, mode: 'local', reason: 'TOOLS_JOB_RESULTS is not "media"' };
    const secret = env.OV_OAUTH_CLIENT_SECRET || '';
    if (!secret) return { media: null, mode: 'local', reason: 'TOOLS_JOB_RESULTS=media but OV_OAUTH_CLIENT_SECRET is not set' };
    const network = (env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
    const tokens = contracts.serviceAuth.createTokenClient({
        tokenUrl: `${network}/oauth/token`,
        clientId: env.OV_OAUTH_CLIENT_ID || 'tools',
        clientSecret: secret,
        audience: 'openvibe.media',
        scope: 'media.object.upload media.object.read',
    });
    const media = createMediaResults({
        internalUrl: env.OV_MEDIA_INTERNAL_URL || env.MEDIA_URL || 'http://127.0.0.1:4100',
        namespace: env.TOOLS_MEDIA_NAMESPACE || 'tools',
        tokens,
    });
    return { media, mode: 'media', reason: null };
}

/** Media's public origin (previews are 302s to it, so the CSP must allow it). */
function mediaOrigin(env = process.env) {
    try { return new URL(env.OV_MEDIA_URL || env.MEDIA_PUBLIC_URL || 'https://openvibe.media').origin; } catch { return 'https://openvibe.media'; }
}

/**
 * One call per satellite: open <dataDir>/jobs.db, build the system, let the app define its job
 * types, mount the routes and start (boot recovery happens here).
 *
 * @param {object} o
 * @param {object} o.app            Express app
 * @param {string} o.service        'img' | 'audio' | 'docs'
 * @param {string} o.dataDir
 * @param {Function} o.Database     require('better-sqlite3')
 * @param {object} o.contracts      require('openvibe-contracts')
 * @param {() => string|null} o.getPublicKey
 * @param {string} o.issuer
 * @param {(system) => void} o.define   registers the app's job types
 * @param {Function} [o.receive]    multipart middleware (the app's multer)
 * @param {Function[]} [o.limiters]
 * @param {Function} [o.defaults]   (req, input) → input with host defaults
 */
function setupJobs(o) {
    fs.mkdirSync(o.dataDir, { recursive: true });
    const db = new o.Database(path.join(o.dataDir, 'jobs.db'));
    const results = mediaFromEnv(o.contracts);
    if (results.reason && String(process.env.TOOLS_JOB_RESULTS || '').toLowerCase() === 'media') console.warn(`[Jobs] ${o.service}: results stay local — ${results.reason}`);
    const system = createJobSystem({
        db, contracts: o.contracts, service: o.service, dataDir: o.dataDir,
        concurrency: envInt(`TOOLS_JOBS_CONCURRENCY_${o.service.toUpperCase()}`, envInt('TOOLS_JOBS_CONCURRENCY', 2)),
        maxActivePerOwner: envInt('TOOLS_JOBS_MAX_ACTIVE', 10) || 10,
        media: results.media,
    });
    o.define(system);
    const resolveOwner = createOwnerResolver({ contracts: o.contracts, getPublicKey: o.getPublicKey, issuer: o.issuer });
    mountJobRoutes(o.app, { system, contracts: o.contracts, resolveOwner, receive: o.receive, limiters: o.limiters, defaults: o.defaults });
    system.start();
    system.db = db;
    system.close = () => { system.stop(); try { db.close(); } catch { /* already closed */ } };
    return system;
}

/**
 * Readiness checks the job runtime adds to a satellite's /api/ready (apps/_shared/observe.js):
 * with TOOLS_JOB_RESULTS=media, whether results really go to Media and Media answers (optional —
 * a failure there is reported as degraded, never hidden).
 */
function readyChecks(getSystem, env = process.env) {
    if (String(env.TOOLS_JOB_RESULTS || 'local').toLowerCase() !== 'media') return [];
    const url = `${String(env.OV_MEDIA_INTERNAL_URL || env.MEDIA_URL || 'http://127.0.0.1:4100').replace(/\/+$/, '')}/healthz`;
    return [{
        name: 'media_results', required: false, cacheMs: 15000, timeoutMs: 1500,
        description: 'TOOLS_JOB_RESULTS=media: finished job files are uploaded to OpenVibe.Media (liveness of Media, not its readiness)',
        check: async () => {
            const sys = getSystem();
            if (!sys) return 'job runtime not set up yet';
            if (!sys.media) return 'TOOLS_JOB_RESULTS=media, but results stay local (OV_OAUTH_CLIENT_SECRET is not set)';
            const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
            return res.ok ? true : `Media answered HTTP ${res.status}`;
        },
    }];
}

module.exports = { setupJobs, readyChecks, createJobSystem, mountJobRoutes, createOwnerResolver, createMediaResults, mediaFromEnv, mediaOrigin, contentDisposition, JobError, CAPS };
