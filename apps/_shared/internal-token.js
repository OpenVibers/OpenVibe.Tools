'use strict';
// ═══════════════════════════════════════════════════════════════
// Internal analytics access (GET /api/internal/analytics[/bots]), shared by the gateway and every
// satellite. The X-Internal-Key is retired (plan T2): a Network service token alone opens the route
// (contracts v0.79.0, capability tools.analytics.read, ADR-014 service tokens).
// One way in, loopback-only (loopbackOnly below refuses anything that came through the proxy):
//   Authorization: Bearer <Network service token>: aud openvibe.tools, cap tools.analytics.read,
//   never a sandbox token. 401 for a bad or malformed token, 403 without the capability, and 401
//   token.missing when no Bearer is presented at all.
// → { ok: true, via: 'token', bearer, claims } | { ok: false, status, body }
// The gateway forwards the caller's Bearer to the satellites unchanged (same audience).
// ═══════════════════════════════════════════════════════════════
const tokens = require('./guard/tokens');

/** The request came straight from loopback, not through the public proxy (nginx adds the headers). */
function loopbackOnly(req) {
    if (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['cf-connecting-ip']) return false;
    const ip = String(req.socket && req.socket.remoteAddress || '');
    return /^(::1|::ffff:127\.|127\.)/.test(ip);
}

const ANALYTICS_CAPABILITY = 'tools.analytics.read';

const authHeader = (req) => String((req.headers && req.headers.authorization) || '');

/**
 * @param {object} req
 * @param {object} [o]
 * @param {string} [o.publicKey]        the Network's RS256 public key
 * @param {() => string|null} [o.getPublicKey]
 * @param {string} [o.issuer]           the Network issuer URL
 * @param {string} [o.audience]         default openvibe.tools
 * @param {object} [o.contracts]        openvibe-contracts, when the app has it
 * @param {string} [o.capability]       default tools.analytics.read
 */
function checkAccess(req, o = {}) {
    if (!loopbackOnly(req)) return { ok: false, status: 404, body: { error: 'Not found' } };
    const header = authHeader(req);
    if (!header) return { ok: false, status: 401, body: { error: 'Unauthorized', code: 'token.missing' } };
    const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
    if (!m) return { ok: false, status: 401, body: { error: 'Unauthorized', code: 'token.malformed' } };
    const publicKey = o.getPublicKey ? o.getPublicKey() : (o.publicKey || null);
    const r = tokens.verifyServiceToken(m[1], {
        publicKey, issuer: o.issuer, audience: o.audience || tokens.AUDIENCE, acceptSandbox: false, contracts: o.contracts || null,
    });
    if (!r.ok) return { ok: false, status: 401, body: { error: 'Unauthorized', code: r.code } };
    const cap = o.capability || ANALYTICS_CAPABILITY;
    const denied = tokens.capabilityDenied(r.claims, cap, o.contracts || null);
    if (denied) return { ok: false, status: 403, body: { error: 'Forbidden', code: denied, detail: `${cap} not granted` } };
    return { ok: true, via: 'token', bearer: header, claims: r.claims };
}

/**
 * Express middleware. `o.keys` is the app's key source ({ get(), ensure() } — the guard's), so a
 * Bearer request can wait once for the Network key to load before the token is judged.
 */
function requireInternalAccess(o = {}) {
    const getKey = o.getPublicKey || (o.keys && typeof o.keys.get === 'function' ? () => o.keys.get() : () => null);
    const ensure = o.ensureKey || (o.keys && typeof o.keys.ensure === 'function' ? o.keys.ensure : null);
    return function internalAccess(req, res, next) {
        const answer = (key) => {
            const r = checkAccess(req, { ...o, getPublicKey: () => key });
            if (!r.ok) return res.status(r.status).json(r.body);
            req.ovInternal = r;
            return next();
        };
        const key = getKey();
        if (key || !/^\s*Bearer\s/i.test(authHeader(req)) || !ensure) return answer(key);
        Promise.resolve(ensure()).then(answer, () => answer(null));
    };
}

module.exports = { checkAccess, requireInternalAccess, ANALYTICS_CAPABILITY };
