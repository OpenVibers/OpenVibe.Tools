'use strict';
// ═══════════════════════════════════════════════════════════════
// Network tokens, verified offline against the Network's RS256 key (no dependencies: node:crypto).
//
// What the Network issues (OpenVibe.Network server/auth, checked 2026-09-23):
//   user (browser sign-in, OAuth code or FedCM exchange, and the Network's own session tokens)
//        iss = the Network, aud = [openvibe.live, openvibe.tools, openvibe.games, openvibe.media,
//        openvibe.network] (+ registry hosts on white-label installs), 24 h; claims sub/id (the
//        numeric account id), subject_id (usr_…), username, display_name, role, avatar_url,
//        profile_color. No cap.
//   service / app principal (client_credentials, ADR-014 developer apps)
//        aud = [the one audience asked for], sub svc:<client> | app:<id>, actor_type, cap[], ns[],
//        env (apps: production | sandbox), 15 min.
//   /internal/issue-token (Network-side cross-service features) carries no aud and no subject_id:
//        not for Tools, and refused here.
// A user token is accepted only with aud openvibe.tools (the copies this replaces checked the
// issuer alone). A token shaped like a principal (cap[] or an svc:/app:/mod: subject) is never a user.
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const AUDIENCE = 'openvibe.tools';
const JWKS_PATH = '/api/.well-known/jwks';

const fromB64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const json = (part) => { try { const v = JSON.parse(fromB64url(part).toString('utf8')); return v && typeof v === 'object' ? v : null; } catch { return null; } };

/** A JWT's payload, unverified (to route it to the right check). */
function peek(token) {
    const parts = typeof token === 'string' ? token.split('.') : [];
    return parts.length === 3 ? json(parts[1]) : null;
}

function looksLikePrincipal(claims) {
    return !!claims && (Array.isArray(claims.cap) || /^(svc|app|mod):/.test(String(claims.sub || '')));
}

/** RS256 signature check → { header, claims } or null. */
function verifySignature(token, publicKey) {
    if (!publicKey) return null;
    const parts = typeof token === 'string' ? token.split('.') : [];
    if (parts.length !== 3) return null;
    const header = json(parts[0]);
    const claims = json(parts[1]);
    if (!header || !claims || header.alg !== 'RS256') return null;
    let good = false;
    try { good = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, fromB64url(parts[2])); } catch { good = false; }
    return good ? { header, claims } : null;
}

function audiences(claims) { return Array.isArray(claims.aud) ? claims.aud : claims.aud == null ? [] : [claims.aud]; }

function timely(claims, now, skewSec) {
    const t = Math.floor(now / 1000);
    if (typeof claims.exp !== 'number' || claims.exp + skewSec < t) return false;
    if (typeof claims.nbf === 'number' && claims.nbf - skewSec > t) return false;
    if (typeof claims.iat === 'number' && claims.iat - skewSec > t) return false;
    return true;
}

/**
 * A signed-in person's token → its claims, or null (bad signature, expired, wrong issuer, not for
 * openvibe.tools, or a principal's token).
 */
function verifyUserToken(token, { publicKey, issuer, audience = AUDIENCE, now = Date.now(), skewSec = 30 } = {}) {
    const v = verifySignature(token, publicKey);
    if (!v) return null;
    const c = v.claims;
    if (looksLikePrincipal(c)) return null;
    if (issuer && c.iss !== issuer) return null;
    if (!audiences(c).includes(audience)) return null;
    if (!timely(c, now, skewSec)) return null;
    return c;
}

/**
 * A service or app principal's token → { ok: true, claims } | { ok: false, code, reason }.
 * With openvibe-contracts it is contracts.serviceAuth.verifyServiceToken (claims checked against
 * identity.service-token-claims@1); apps without contracts get the same checks minus the schema.
 */
function verifyServiceToken(token, { publicKey, issuer, audience = AUDIENCE, acceptSandbox = false, contracts = null, now = Date.now() } = {}) {
    if (contracts && contracts.serviceAuth) return contracts.serviceAuth.verifyServiceToken(token, { publicKey, issuer, audience, acceptSandbox, now });
    const fail = (code, reason) => ({ ok: false, code, reason });
    if (typeof token !== 'string' || token.split('.').length !== 3) return fail('token.malformed', 'not a JWT');
    const v = verifySignature(token, publicKey);
    if (!v) return fail('token.bad_signature', 'signature does not verify');
    const c = v.claims;
    if (!timely(c, now, 30)) return fail('token.expired', 'expired');
    if (issuer && c.iss !== issuer) return fail('token.wrong_issuer', `issuer ${c.iss}`);
    if (!audiences(c).includes(audience)) return fail('token.wrong_audience', `not for ${audience}`);
    if (!/^(svc|app|mod):[A-Za-z0-9_.-]+$/.test(String(c.sub || '')) || !Array.isArray(c.cap) || !c.cap.every(x => typeof x === 'string')) return fail('token.invalid_claims', 'sub or cap');
    if (c.env === 'sandbox' && !acceptSandbox) return fail('token.sandbox_refused', 'sandbox tokens are not accepted here');
    return { ok: true, claims: c };
}

/**
 * Why a principal may not use `cap` → a problem code (capability.denied, or contracts' own, e.g. an
 * audience or namespace mismatch), or null when it may. contracts' manifest-aware check when available.
 */
function capabilityDenied(claims, cap, contracts = null) {
    if (contracts && contracts.capabilities) {
        const c = contracts.capabilities.check(claims, cap);
        if (c.allowed) return null;
        // A capability the installed contracts do not know yet: an explicit grant (only Network signs) is enough.
        if (c.code === 'capability.unknown' && contracts.capabilities.grants(claims.cap, cap)) return null;
        return c.code === 'capability.unknown' ? 'capability.denied' : c.code;
    }
    return Array.isArray(claims.cap) && claims.cap.includes(cap) ? null : 'capability.denied';
}
const hasCapability = (claims, cap, contracts = null) => !capabilityDenied(claims, cap, contracts);

/** The token a request carries: Authorization: Bearer, else the shared ov_token cookie (or the older token cookie). */
function extractToken(req) {
    const h = String((req.headers && req.headers.authorization) || '');
    if (h.startsWith('Bearer ')) return { token: h.slice(7).trim(), from: 'header' };
    const c = req.cookies || {};
    if (c.ov_token) return { token: c.ov_token, from: 'cookie' };
    if (c.token) return { token: c.token, from: 'cookie' };
    return { token: null, from: null };
}

/**
 * The Network's public key: a PEM file (OV_NETWORK_PUBLIC_KEY, air-gapped setups) or the Network's
 * JWKS endpoint (internal URL first), fetched at start and every `retryMs` until it loads. Until
 * then every caller is anonymous (nothing fails because the Network is down).
 *
 * @returns {{ get(): string|null, ensure(): Promise<string|null>, stop(): void }}
 */
function createKeySource({ networkUrl, networkInternalUrl, files = [], fetchImpl = (...a) => globalThis.fetch(...a), retryMs = 60_000, timeoutMs = 5000, log = console, start = true } = {}) {
    let key = null, timer = null, inflight = null, lastTry = 0;
    for (const p of files.filter(Boolean)) {
        try {
            const resolved = path.resolve(p);
            if (fs.existsSync(resolved)) { key = fs.readFileSync(resolved, 'utf8'); log.log(`[Auth] Network public key from ${resolved}`); break; }
        } catch { /* next */ }
    }
    async function fetchKey() {
        for (const base of [networkInternalUrl, networkUrl].filter(Boolean)) {
            try {
                const res = await fetchImpl(`${String(base).replace(/\/+$/, '')}${JWKS_PATH}`, { signal: AbortSignal.timeout(timeoutMs) });
                if (!res.ok) continue;
                const body = await res.json();
                if (body && body.public_key) { key = body.public_key; log.log(`[Auth] Network public key from ${base}${JWKS_PATH}`); return key; }
            } catch { /* next base */ }
        }
        return null;
    }
    // Requests carrying a token may ask for the key while it is missing; the Network is asked at most
    // every 30 s for them (the retry timer below keeps trying on its own).
    function ensure() {
        if (key) return Promise.resolve(key);
        if (inflight) return inflight;
        if (Date.now() - lastTry < 30_000) return Promise.resolve(null);
        lastTry = Date.now();
        inflight = fetchKey().finally(() => { inflight = null; });
        return inflight;
    }
    if (!key && start) {
        ensure().then((k) => {
            if (k) return;
            log.warn(`[Auth] OpenVibe Network unreachable — retrying every ${retryMs / 1000}s (everyone is anonymous until the key loads)`);
            timer = setInterval(async () => { if (await ensure()) { clearInterval(timer); timer = null; } }, retryMs);
            if (timer.unref) timer.unref();
        });
    }
    return { get: () => key, ensure, stop() { if (timer) clearInterval(timer); timer = null; } };
}

module.exports = { AUDIENCE, peek, looksLikePrincipal, verifySignature, verifyUserToken, verifyServiceToken, hasCapability, capabilityDenied, extractToken, createKeySource };
