'use strict';
// ═══════════════════════════════════════════════════════════════
// Optional command-line tools that some operations need (qpdf, pdftoppm, heif-dec).
//
// Each one is looked for when the satellite boots, on PATH or at an absolute path from its
// environment variable, and checked with an optional probe. An operation that needs a missing one
// throws Unavailable: 503 problem tools.unavailable ("this tool is being set up"), never a
// half-done result. A missing tool is looked for again at most once a minute, so installing the
// package is enough; no restart is needed.
// ═══════════════════════════════════════════════════════════════

const { which } = require('./observe');

const RECHECK_MS = 60_000;
const SETTING_UP = 'This tool is being set up on the server and is not available yet. Please try again later.';

/** The operation needs something this server does not have (yet). → 503 tools.unavailable. */
class Unavailable extends Error {
    constructor(detail = SETTING_UP, extra) {
        super(detail);
        this.status = 503;
        this.code = 'tools.unavailable';
        this.detail = detail;
        this.expose = true;       // an expected state, not a crash: the job runtime does not log it as one
        this.retryable = true;    // it works again once the package is installed
        this.extra = extra;
    }
}

/**
 * @param {object} o
 * @param {string} o.name          what it is called in /api/ready and logs ('qpdf')
 * @param {string[]} o.candidates  executable names to look for on PATH, in order
 * @param {string} [o.envVar]      environment variable with an explicit path (wins over PATH)
 * @param {(path) => true|string} [o.probe]  extra check once found; a string says what is missing
 * @param {object} [o.env]         environment to read (tests)
 */
function createBinary({ name, candidates, envVar, probe, env = process.env }) {
    let state = null;

    function detect() {
        const override = envVar && env[envVar] ? String(env[envVar]) : null;
        let found = null;
        for (const c of override ? [override] : candidates) { found = which(c, env); if (found) break; }
        let available = !!found;
        let detail = found ? null : `${override || candidates.join(' / ')} not found`;
        if (found && probe) {
            let r;
            try { r = probe(found); } catch (err) { r = err.message; }
            if (r !== true) { available = false; detail = String(r || 'probe failed'); }
        }
        state = { name, path: found, available, detail, checkedAt: Date.now() };
        return state;
    }

    /** The current state; a missing tool is looked for again after RECHECK_MS. */
    function get() {
        if (!state || (!state.available && Date.now() - state.checkedAt > RECHECK_MS)) detect();
        return state;
    }

    return {
        name,
        detect,
        get,
        available: () => get().available,
        /** The executable's path, or throws Unavailable. */
        path(extra) {
            const s = get();
            if (!s.available) throw new Unavailable(SETTING_UP, extra);
            return s.path;
        },
        /** An /api/ready check (optional: the rest of the app works without it). */
        readyCheck(description) {
            return {
                name, required: false, description, cacheMs: 60_000,
                check: () => { const s = get(); return s.available ? { ok: true, detail: { path: s.path } } : s.detail; },
            };
        },
    };
}

module.exports = { createBinary, Unavailable, SETTING_UP };
