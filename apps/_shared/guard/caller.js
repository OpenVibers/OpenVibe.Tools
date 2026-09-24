'use strict';
// ═══════════════════════════════════════════════════════════════
// Who is asking — the one resolver for the gateway and every satellite (it replaces the four copied
// auth.js files and the job routes' own owner logic).
//
//   principal  Authorization: Bearer <service or app token>, aud openvibe.tools (tier service; a
//              developer app's sandbox token: tier sandbox, job routes only take it from apps)
//   user       a Network sign-in (the ov_token cookie or a Bearer user token, aud openvibe.tools)
//   session    this browser's ov_tools_jobs cookie (only its hash is ever kept)
//   anonymous  nobody: counted by address, an IPv6 address by its /64
//
// Addresses are req.ip only (`trust proxy` is one loopback hop, ./ip.js). A first-party service on
// loopback is not special: it is identified by its service token, and without one it is anonymous,
// counted by the address it forwarded (as the one trusted hop) or else by its own.
//
// → { kind, tier, key, ipKey, ipHash, owner, id, claims, env, error? }
//   key     what quotas count (session hash, user:usr_…, the principal's sub, ip:<hash>)
//   ipKey   ip:<HMAC-SHA256(today's salt, address or /64)>, never the address itself
//   owner   the job owner (user:usr_…, the principal's sub, session:<hash>) or null
//   error   [status, code, detail] for a bad principal token on the job routes
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');
const { ipBucket } = require('./ip');
const tokens = require('./tokens');

const SESSION_RE = /^[A-Za-z0-9_-]{32,64}$/;
const USER_ID_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const JOB_CAPS = { create: 'tools.job.create', read: 'tools.job.read', cancel: 'tools.job.cancel' };
const COOKIE = 'ov_tools_jobs';

/**
 * @param {object} o
 * @param {() => string|null} o.getPublicKey
 * @param {string} o.issuer
 * @param {string} [o.audience='openvibe.tools']
 * @param {object} [o.contracts]            openvibe-contracts, when the app has it
 * @param {() => string} [o.salt]           today's salt (guard.db); a process-local one otherwise
 * @param {string} [o.cookieName='ov_tools_jobs']
 * @param {boolean} [o.secureCookie]
 */
function createCallerResolver(o) {
    const audience = o.audience || tokens.AUDIENCE;
    const cookieName = o.cookieName || COOKIE;
    const contracts = o.contracts || null;
    let localSalt = null;
    const salt = o.salt || (() => {
        const day = new Date().toISOString().slice(0, 10);
        if (!localSalt || localSalt.day !== day) localSalt = { day, salt: crypto.randomBytes(32).toString('hex') };
        return localSalt.salt;
    });
    const isUserId = (sid) => (contracts ? contracts.ids.isSubjectId('user', sid) : USER_ID_RE.test(String(sid || '')));

    function hashIp(ip) {
        return crypto.createHmac('sha256', salt()).update(ipBucket(ip) || 'unknown').digest('hex').slice(0, 32);
    }

    function sessionOwner(value) {
        return `session:${crypto.createHash('sha256').update(value).digest('hex').slice(0, 40)}`;
    }

    /** Mint the browser-session cookie now (pages call this so their first job already has one). */
    function ensureSession(req, res) {
        let v = req.cookies && req.cookies[cookieName];
        if (SESSION_RE.test(String(v || ''))) return v;
        v = crypto.randomBytes(24).toString('base64url');
        res.cookie(cookieName, v, {
            httpOnly: true, sameSite: 'lax', path: '/', maxAge: 7 * 24 * 60 * 60 * 1000,
            secure: o.secureCookie != null ? o.secureCookie : process.env.NODE_ENV === 'production',
        });
        if (req.cookies) req.cookies[cookieName] = v; else req.cookies = { [cookieName]: v };
        return v;
    }

    /**
     * @param {object} req
     * @param {object} [res]           needed with create
     * @param {object} [opt]
     * @param {boolean} [opt.create]   mint a session cookie for an anonymous caller
     * @param {string} [opt.action]    job routes: create | read | cancel (a principal needs tools.job.<action>)
     * @param {boolean} [opt.jobs]     job routes: a bad principal token is an error, not anonymity
     */
    function resolve(req, res, opt = {}) {
        const ipHash = hashIp(req.ip || (req.socket && req.socket.remoteAddress));
        const base = { ipKey: `ip:${ipHash}`, ipHash, claims: null, env: 'production' };

        // 1. A principal's token (service or developer app).
        const h = String((req.headers && req.headers.authorization) || '');
        if (h.startsWith('Bearer ')) {
            const token = h.slice(7).trim();
            if (tokens.looksLikePrincipal(tokens.peek(token))) {
                const r = tokens.verifyServiceToken(token, { publicKey: o.getPublicKey(), issuer: o.issuer, audience, acceptSandbox: true, contracts });
                let error = null;
                if (!r.ok) error = [401, r.code, r.reason];
                else if (r.claims.env === 'sandbox' && !(r.claims.actor_type === 'app' && /^app:/.test(String(r.claims.sub || '')))) error = [401, 'token.sandbox_refused', 'sandbox tokens are accepted only from developer apps'];
                if (!error && opt.action) {
                    const cap = JOB_CAPS[opt.action] || JOB_CAPS.read;
                    const denied = tokens.capabilityDenied(r.claims, cap, contracts);
                    if (denied) error = [403, denied, `${cap} not granted`];
                }
                if (error && opt.jobs) return { ...base, kind: 'anonymous', tier: 'anonymous', key: base.ipKey, owner: null, id: null, error };
                if (!error) {
                    const sandbox = r.claims.env === 'sandbox';
                    return { ...base, kind: 'principal', tier: sandbox ? 'sandbox' : 'service', key: r.claims.sub, owner: r.claims.sub, id: r.claims.sub, claims: r.claims, env: sandbox ? 'sandbox' : 'production' };
                }
                // Elsewhere a token that does not verify is simply not believed: the caller is anonymous.
            }
        }

        // 2. A signed-in person (req.user comes from the guard's identify(): signature, issuer, audience).
        const user = req.user || null;
        const sid = user && user.subject_id;
        let session = req.cookies && req.cookies[cookieName];
        if (!SESSION_RE.test(String(session || ''))) session = null;
        if (user) {
            const id = isUserId(sid) ? `user:${sid}` : `user:${String(user.sub || user.id || 'unknown')}`;
            // A job belongs to the person's subject; a token without one (older sign-ins) keeps its jobs in the browser session.
            let owner = isUserId(sid) ? `user:${sid}` : null;
            if (!owner) {
                if (!session && opt.create && res) session = ensureSession(req, res);
                owner = session ? sessionOwner(session) : null;
            }
            return { ...base, kind: 'user', tier: 'user', key: id, owner, id, claims: user };
        }

        // 3. This browser's session, 4. nobody.
        if (!session && opt.create && res) session = ensureSession(req, res);
        if (session) {
            const owner = sessionOwner(session);
            return { ...base, kind: 'session', tier: 'session', key: owner, owner, id: null };
        }
        return { ...base, kind: 'anonymous', tier: 'anonymous', key: base.ipKey, owner: null, id: null };
    }

    return { resolve, ensureSession, hashIp, sessionOwner, cookieName };
}

/**
 * The job routes' owner resolver (apps/_shared/jobs/http.js), on top of the one caller resolver:
 * → { owner, kind: 'principal'|'user'|'session', claims?, env } | { error } | null (anonymous, not creating).
 */
function jobOwnerResolver(callers) {
    return function resolveOwner(req, res, { create = false, action = 'read' } = {}) {
        const c = callers.resolve(req, res, { create, action, jobs: true });
        if (c.error) return { error: c.error };
        if (!c.owner) return null;
        const kind = c.kind === 'principal' ? 'principal' : c.owner.startsWith('user:') ? 'user' : 'session';
        return { owner: c.owner, kind, claims: c.claims || undefined, env: c.env, caller: c };
    };
}

module.exports = { createCallerResolver, jobOwnerResolver, JOB_CAPS, SESSION_RE, COOKIE };
