'use strict';

// ═══════════════════════════════════════════════════════════════
// openvibe.tools — OAuth2 CLIENT session layer
//
// The identity provider is OpenVibe.Network (https://openvibe.network).
// This gateway is registered there as OAuth client `tools`.
//
//   GET  /auth/login     → redirect to Network /oauth/authorize
//                          (?silent=1 adds prompt=none: no login UI, the
//                          Network answers login_required when nobody is
//                          signed in there). A browser that already holds a
//                          valid ov_token skips the Network and goes to next.
//   GET  /auth/callback  → server-side code exchange, set cookies
//   POST /auth/fedcm     → browser-native FedCM sign-in: the page posts the
//                          Network's assertion JWT + its nonce, we exchange it
//                          (jwt-bearer grant) and set the same cookies
//   GET  /auth/logout    → clear cookies (+ best-effort refresh revoke)
//   GET  /auth/me        → offline-verify ov_token, return profile
//   POST /auth/refresh   → rotate tokens via refresh_token grant
//
// Cookies:
//   ov_token   — access JWT, Domain=.openvibe.tools, SameSite=Lax,
//                Secure, JS-readable (every tool subdomain reads it)
//   ov_refresh — opaque refresh token, httpOnly, Path=/auth,
//                host-only (never leaves the gateway)
//   ov_sso_hint — 'account' after a sign-in, 'guest' after a sign-out.
//                One year, JS-readable, Domain=.openvibe.tools. The shared
//                navbar reads it: only when it says 'account' does a page
//                with no session attempt ONE silent (prompt=none) login.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const crypto = require('crypto');
const { OpenVibeAuthClient } = require('openvibe-shared/auth-client');

const ACCESS_COOKIE = 'ov_token';
const REFRESH_COOKIE = 'ov_refresh';
const STATE_COOKIE = 'ov_oauth_state';
const NEXT_COOKIE = 'ov_oauth_next';
const SILENT_COOKIE = 'ov_oauth_silent';
const SSO_HINT_COOKIE = 'ov_sso_hint';

// Origin of the identity provider's own "sign you in everywhere" chain. The Network hops
// through /auth/login?silent=1&next=https://openvibe.network/sso/fanout?… and back, so
// its URLs are valid post-login targets alongside our own hosts.
const NETWORK_ORIGIN = 'https://openvibe.network';

// OAuth errors that mean "nobody is signed in at the Network" rather than "something broke".
// A silent attempt that ends here just goes back where it came from.
const NO_SESSION_ERRORS = new Set(['login_required', 'interaction_required', 'consent_required']);

// RFC 7523: the FedCM assertion is presented to /oauth/token as a JWT bearer grant.
const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

/** True for https://openvibe.tools and any https://*.openvibe.tools origin, nothing else. */
function isToolsZoneOrigin(origin) {
    try {
        const u = new URL(origin);
        return u.protocol === 'https:' && (u.hostname === 'openvibe.tools' || u.hostname.endsWith('.openvibe.tools'));
    } catch {
        return false;
    }
}

/**
 * CORS for POST /auth/fedcm only. Satellites (yt.openvibe.tools, …) post the assertion
 * cross-origin to the apex with credentials, so the reply must name their exact origin and
 * allow credentials; any origin outside the *.openvibe.tools zone is refused outright (403,
 * no CORS headers) for both the preflight and the request itself. Requests without an
 * Origin header (same-origin form of the call, curl) pass through untouched.
 * Mounted in index.js ahead of the gateway-wide CORS so the wider allow-list never answers
 * this path's preflight.
 */
function fedcmCors(req, res, next) {
    const origin = req.headers.origin;
    res.vary('Origin');
    if (origin) {
        if (!isToolsZoneOrigin(origin)) {
            res.removeHeader('Access-Control-Allow-Origin');
            return res.status(403).json({ error: 'origin_not_allowed', error_description: 'Origin is not part of the openvibe.tools zone' });
        }
        res.set('Access-Control-Allow-Origin', origin);
        res.set('Access-Control-Allow-Credentials', 'true');
    }
    if (req.method === 'OPTIONS') {
        res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.set('Access-Control-Allow-Headers', 'Content-Type');
        res.set('Access-Control-Max-Age', '600');
        return res.status(204).end();
    }
    return next();
}

/**
 * Read a JWT's payload WITHOUT checking its signature. Only used to compare the FedCM
 * assertion's nonce with the one the page posted; the Network verifies the signature when
 * the assertion is exchanged. Returns null when the token is not a three-part JWT.
 */
function decodeJwtPayload(token) {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        return payload && typeof payload === 'object' ? payload : null;
    } catch {
        return null;
    }
}

/** Constant-time string comparison; unequal lengths short-circuit (the length is not secret). */
function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Create the auth client + JWKS fetcher shared by the whole gateway.
 * Verification is OFFLINE: we cache Network's RS256 public key from
 * GET /api/.well-known/jwks and verify JWTs locally on every request.
 */
function createAuthClient(config) {
    const client = new OpenVibeAuthClient({
        clientId: config.oauth.clientId,
        clientSecret: config.oauth.clientSecret,
        redirectUri: config.oauth.redirectUri,
        publicKey: null, // filled by ensureKey()
        authBase: config.networkUrl,
        internalBase: config.networkInternalUrl,
    });

    let lastFetch = 0;
    async function ensureKey() {
        if (client.publicKey) return client.publicKey;
        // Don't hammer the Network if it's down — retry at most every 30s
        if (Date.now() - lastFetch < 30_000) return null;
        lastFetch = Date.now();
        for (const base of [config.networkInternalUrl, config.networkUrl]) {
            if (!base) continue;
            try {
                const res = await fetch(`${base}/api/.well-known/jwks`, { signal: AbortSignal.timeout(5000) });
                if (!res.ok) continue;
                const jwks = await res.json();
                if (jwks.public_key) {
                    client.publicKey = jwks.public_key;
                    console.log(`[Auth] Network public key loaded from ${base} (${jwks.algorithm || 'RS256'})`);
                    return client.publicKey;
                }
            } catch (err) {
                console.warn(`[Auth] JWKS fetch failed from ${base}: ${err.message}`);
            }
        }
        return null;
    }

    /** Offline JWT verification. Returns decoded claims or null. */
    async function verify(token) {
        if (!token) return null;
        await ensureKey();
        return client.verifyToken(token);
    }

    // Warm the key cache at boot (non-fatal if Network is down)
    ensureKey().catch(() => {});

    return { client, ensureKey, verify };
}

/** Token from Authorization header or the shared ov_token cookie. */
function extractToken(req) {
    const h = req.headers.authorization;
    if (h && h.startsWith('Bearer ')) return h.slice(7);
    return req.cookies?.[ACCESS_COOKIE] || null;
}

function createAuthRoutes(config, auth) {
    const router = express.Router();

    const accessCookieOpts = () => ({
        domain: config.cookies.domain || undefined,
        sameSite: 'lax',
        secure: config.cookies.secure,
        httpOnly: false, // JS-readable by design — satellites read it client-side
        path: '/',
        maxAge: 24 * 60 * 60 * 1000, // matches the 24h access JWT
    });

    const refreshCookieOpts = () => ({
        // Domain-wide so same-origin /auth/refresh also works on net./dev./pastes. hosts.
        domain: config.cookies.domain || undefined,
        sameSite: 'lax',
        secure: config.cookies.secure,
        httpOnly: true,
        path: '/auth', // only ever sent back to this session layer
        maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    function setSessionCookies(res, accessToken, refreshToken) {
        res.cookie(ACCESS_COOKIE, accessToken, accessCookieOpts());
        if (refreshToken) res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOpts());
    }

    function clearSessionCookies(res) {
        res.clearCookie(ACCESS_COOKIE, { ...accessCookieOpts(), maxAge: undefined });
        res.clearCookie(ACCESS_COOKIE, { path: '/' }); // host-only leftovers
        res.clearCookie(REFRESH_COOKIE, { ...refreshCookieOpts(), maxAge: undefined });
    }

    /**
     * Remember across the whole *.openvibe.tools zone whether this browser has an account
     * here ('account') or explicitly signed out ('guest'). Not a credential — just the hint
     * that tells the navbar whether a silent login is worth one round trip.
     */
    function setSsoHint(res, value) {
        res.cookie(SSO_HINT_COOKIE, value, {
            domain: config.cookies.domain || undefined,
            sameSite: 'lax',
            secure: config.cookies.secure,
            httpOnly: false, // read client-side by the shared navbar
            path: '/',
            maxAge: 365 * 24 * 60 * 60 * 1000,
        });
    }

    /** Short-lived flags that carry login options across the OAuth round trip. */
    function flowCookieOpts() {
        return {
            domain: config.cookies.domain || undefined,
            sameSite: 'lax', secure: config.cookies.secure, httpOnly: true,
            path: '/auth', maxAge: 10 * 60 * 1000,
        };
    }

    /** A cookie only clears when domain and path match the ones it was set with. */
    function clearFlowCookie(res, name) {
        res.clearCookie(name, { ...flowCookieOpts(), maxAge: undefined });
        res.clearCookie(name, { path: '/auth' }); // host-only leftovers from older sessions
    }

    /**
     * Only allow same-site relative paths, *.openvibe.tools URLs, or the Network's own
     * https://openvibe.network/... URLs as post-login / post-logout targets.
     */
    function sanitizeNext(next) {
        if (!next || typeof next !== 'string') return '/';
        if (/^\/(?!\/)/.test(next)) return next; // relative path, not protocol-relative
        try {
            const u = new URL(next);
            const base = 'openvibe.tools';
            if (u.protocol !== 'https:') return '/';
            if (u.hostname === base || u.hostname.endsWith('.' + base)) return next;
            if (u.origin === NETWORK_ORIGIN) return next;
        } catch { /* fall through */ }
        return '/';
    }

    /** Append a query parameter to a target that may already carry a query string or a hash. */
    function withParam(target, key, value) {
        const hashAt = target.indexOf('#');
        const hash = hashAt >= 0 ? target.slice(hashAt) : '';
        const base = hashAt >= 0 ? target.slice(0, hashAt) : target;
        const sep = base.includes('?') ? '&' : '?';
        return `${base}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}${hash}`;
    }

    /** Exchange at the Network — internal URL first, public as fallback. */
    async function tokenGrant(body) {
        let lastErr = null;
        for (const base of [config.networkInternalUrl, config.networkUrl]) {
            if (!base) continue;
            try {
                const res = await fetch(`${base}/oauth/token`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        client_id: config.oauth.clientId,
                        client_secret: config.oauth.clientSecret,
                        ...body,
                    }),
                    signal: AbortSignal.timeout(10_000),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                    const err = new Error(data.error_description || data.error || `token grant failed (${res.status})`);
                    err.status = res.status;
                    err.code = typeof data.error === 'string' ? data.error : null;
                    err.description = typeof data.error_description === 'string' ? data.error_description : null;
                    throw err;
                }
                return data;
            } catch (err) {
                lastErr = err;
                // 4xx = the grant itself is bad; retrying against another base won't help
                if (err.status && err.status < 500) throw err;
            }
        }
        throw lastErr || new Error('Network unreachable');
    }

    // ── GET /auth/login ──────────────────────────────────────
    router.get('/login', async (req, res) => {
        // Silent mode (?silent=1): the shared navbar uses it when a page has no session but
        // the browser carries an ov_sso_hint=account cookie. prompt=none tells the Network to
        // answer without any UI — a code if the user is signed in there, login_required if not.
        const silent = String(req.query.silent || '') === '1';
        if (silent) {
            // Already signed in here (a valid ov_token rode along)? Then the round trip to the
            // Network would only hand back the session this browser already has: go straight
            // to the page that asked.
            const existing = req.cookies?.[ACCESS_COOKIE];
            if (existing && await auth.verify(existing)) {
                return res.redirect(sanitizeNext(req.query.next));
            }
        }
        let { url, state } = auth.client.getAuthorizationUrl(config.oauth.scope);
        if (silent) url += '&prompt=none';
        // Domain-wide: a login can start on net./dev./pastes. but the OAuth
        // redirect_uri is pinned to the apex — the callback must see these cookies.
        res.cookie(STATE_COOKIE, state, flowCookieOpts());
        const next = sanitizeNext(req.query.next);
        if (next !== '/') res.cookie(NEXT_COOKIE, next, flowCookieOpts());
        else clearFlowCookie(res, NEXT_COOKIE);
        if (silent) res.cookie(SILENT_COOKIE, '1', flowCookieOpts());
        else clearFlowCookie(res, SILENT_COOKIE);
        res.redirect(url);
    });

    // ── GET /auth/callback ───────────────────────────────────
    router.get('/callback', async (req, res) => {
        const { code, state, error } = req.query;
        const silent = req.cookies?.[SILENT_COOKIE] === '1';
        clearFlowCookie(res, SILENT_COOKIE);
        if (error) {
            // A prompt=none probe that found no Network session is the expected outcome, not
            // a failure: send the page straight back with ?sso=none so it stops asking.
            if (NO_SESSION_ERRORS.has(String(error)) || silent) {
                const next = sanitizeNext(req.cookies?.[NEXT_COOKIE]);
                clearFlowCookie(res, NEXT_COOKIE);
                clearFlowCookie(res, STATE_COOKIE);
                return res.redirect(withParam(next, 'sso', 'none'));
            }
            return res.redirect(`/?auth_error=${encodeURIComponent(error)}`);
        }
        if (!code) return res.status(400).send('Missing authorization code');

        const expectedState = req.cookies?.[STATE_COOKIE];
        clearFlowCookie(res, STATE_COOKIE);
        if (!expectedState || !state || !crypto.timingSafeEqual(
            Buffer.from(String(state).padEnd(64).slice(0, 64)),
            Buffer.from(String(expectedState).padEnd(64).slice(0, 64))
        )) {
            return res.status(400).send('OAuth state mismatch — please try signing in again.');
        }

        try {
            const data = await tokenGrant({
                grant_type: 'authorization_code',
                redirect_uri: config.oauth.redirectUri,
                code,
            });
            setSessionCookies(res, data.access_token, data.refresh_token);
            setSsoHint(res, 'account');
            const next = sanitizeNext(req.cookies?.[NEXT_COOKIE]);
            clearFlowCookie(res, NEXT_COOKIE);
            return res.redirect(next);
        } catch (err) {
            console.error('[Auth] Code exchange failed:', err.message);
            return res.status(502).send('Sign-in failed — could not reach the OpenVibe.Network. Please try again.');
        }
    });

    // ── POST /auth/fedcm ─────────────────────────────────────
    // Browser-native FedCM sign-in. The shared navbar asks the browser for an identity
    // credential from openvibe.network (with a nonce it generated) and posts the resulting
    // assertion JWT here. We check the nonce claim matches, then present the assertion to
    // the Network as a jwt-bearer grant — same endpoint and response shape as the code
    // exchange — and set up the session exactly like /auth/callback does.
    // Body: { token: '<assertion jwt>', nonce: '<the nonce the page used>' }
    router.post('/fedcm', async (req, res) => {
        if (!req.is('application/json')) {
            return res.status(415).json({ error: 'unsupported_media_type', error_description: 'Send JSON (Content-Type: application/json)' });
        }
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const token = typeof body.token === 'string' ? body.token.trim() : '';
        const nonce = typeof body.nonce === 'string' ? body.nonce : '';
        if (!token) return res.status(400).json({ error: 'invalid_request', error_description: 'Missing token' });
        if (!nonce || nonce.length > 512) return res.status(400).json({ error: 'invalid_request', error_description: 'Missing nonce' });
        if (token.length > 16 * 1024) return res.status(400).json({ error: 'invalid_request', error_description: 'Token too large' });

        // Nonce binding: the assertion must carry the very nonce this page generated, or it
        // was minted for a different request. Signature-less decode is enough for that — the
        // Network verifies the signature when we exchange it.
        const claims = decodeJwtPayload(token);
        if (!claims) return res.status(400).json({ error: 'invalid_request', error_description: 'Token is not a JWT' });
        if (!safeEqual(String(claims.nonce ?? ''), nonce)) {
            return res.status(400).json({ error: 'invalid_request', error_description: 'Nonce mismatch' });
        }

        try {
            const data = await tokenGrant({ grant_type: JWT_BEARER_GRANT, assertion: token });
            if (!data.access_token) {
                return res.status(401).json({ error: 'invalid_grant', error_description: 'The OpenVibe.Network issued no access token' });
            }
            setSessionCookies(res, data.access_token, data.refresh_token);
            setSsoHint(res, 'account');
            let user = data.user || null;
            if (!user) {
                const verified = await auth.verify(data.access_token);
                if (verified) {
                    const { iat, exp, aud, iss, ...rest } = verified;
                    user = rest;
                }
            }
            return res.json({ ok: true, user });
        } catch (err) {
            if (err.status && err.status < 500) {
                // The Network refused the assertion (expired, wrong audience, unknown user…).
                return res.status(401).json({
                    error: err.code || 'invalid_grant',
                    error_description: err.description || err.message,
                });
            }
            console.error('[Auth] FedCM exchange failed:', err.message);
            return res.status(502).json({ error: 'server_error', error_description: 'Could not reach the OpenVibe.Network' });
        }
    });

    // ── GET /auth/logout ─────────────────────────────────────
    router.get('/logout', async (req, res) => {
        // Best-effort refresh revocation. The Network does not currently
        // expose /oauth/revoke; its rotating refresh tokens self-invalidate,
        // so a failure here is harmless.
        const refresh = req.cookies?.[REFRESH_COOKIE];
        if (refresh) {
            try {
                await fetch(`${config.networkInternalUrl}/oauth/revoke`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        client_id: config.oauth.clientId,
                        client_secret: config.oauth.clientSecret,
                        token: refresh,
                    }),
                    signal: AbortSignal.timeout(3000),
                });
            } catch { /* optional */ }
        }
        clearSessionCookies(res);
        // 'guest' stops every tool page from probing the Network for a session it just ended.
        setSsoHint(res, 'guest');
        // next may be a Network URL: the sign-out-everywhere chain hops through here.
        res.redirect(sanitizeNext(req.query.next));
    });

    // ── GET /auth/me ─────────────────────────────────────────
    router.get('/me', async (req, res) => {
        const token = extractToken(req);
        if (!token) return res.status(401).json({ error: 'Not authenticated' });
        const claims = await auth.verify(token);
        if (!claims) return res.status(401).json({ error: 'Invalid or expired token' });
        const { iat, exp, aud, iss, ...user } = claims;
        res.json({ user, expires_at: exp ? exp * 1000 : null });
    });

    // ── POST /auth/refresh ───────────────────────────────────
    // Small endpoint the shared navbar can call when ov_token expires.
    router.post('/refresh', async (req, res) => {
        const refresh = req.cookies?.[REFRESH_COOKIE];
        if (!refresh) return res.status(401).json({ error: 'No refresh token' });
        try {
            const data = await tokenGrant({ grant_type: 'refresh_token', refresh_token: refresh });
            setSessionCookies(res, data.access_token, data.refresh_token);
            const claims = await auth.verify(data.access_token);
            let user = null;
            if (claims) {
                const { iat, exp, aud, iss, ...rest } = claims;
                user = rest;
            }
            return res.json({ token: data.access_token, user });
        } catch (err) {
            if (err.status && err.status < 500) {
                clearSessionCookies(res);
                return res.status(401).json({ error: 'Refresh token rejected — please sign in again' });
            }
            console.error('[Auth] Refresh failed:', err.message);
            return res.status(502).json({ error: 'Could not reach the OpenVibe.Network' });
        }
    });

    return router;
}

module.exports = { createAuthClient, createAuthRoutes, extractToken, fedcmCors };
