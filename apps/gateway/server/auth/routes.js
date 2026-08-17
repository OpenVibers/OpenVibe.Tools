'use strict';

// ═══════════════════════════════════════════════════════════════
// openvibe.tools — OAuth2 CLIENT session layer
//
// The identity provider is OpenVibe.Network (https://openvibe.network).
// This gateway is registered there as OAuth client `tools`.
//
//   GET  /auth/login     → redirect to Network /oauth/authorize
//   GET  /auth/callback  → server-side code exchange, set cookies
//   GET  /auth/logout    → clear cookies (+ best-effort refresh revoke)
//   GET  /auth/me        → offline-verify ov_token, return profile
//   POST /auth/refresh   → rotate tokens via refresh_token grant
//
// Cookies:
//   ov_token   — access JWT, Domain=.openvibe.tools, SameSite=Lax,
//                Secure, JS-readable (every tool subdomain reads it)
//   ov_refresh — opaque refresh token, httpOnly, Path=/auth,
//                host-only (never leaves the gateway)
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const crypto = require('crypto');
const { OpenVibeAuthClient } = require('openvibe-shared/auth-client');

const ACCESS_COOKIE = 'ov_token';
const REFRESH_COOKIE = 'ov_refresh';
const STATE_COOKIE = 'ov_oauth_state';
const NEXT_COOKIE = 'ov_oauth_next';

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

    /** Only allow same-site relative paths or *.openvibe.tools URLs as post-login targets. */
    function sanitizeNext(next) {
        if (!next || typeof next !== 'string') return '/';
        if (/^\/(?!\/)/.test(next)) return next; // relative path, not protocol-relative
        try {
            const u = new URL(next);
            const base = 'openvibe.tools';
            if (u.protocol === 'https:' && (u.hostname === base || u.hostname.endsWith('.' + base))) return next;
        } catch { /* fall through */ }
        return '/';
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
    router.get('/login', (req, res) => {
        const { url, state } = auth.client.getAuthorizationUrl(config.oauth.scope);
        res.cookie(STATE_COOKIE, state, {
            sameSite: 'lax', secure: config.cookies.secure, httpOnly: true,
            path: '/auth', maxAge: 10 * 60 * 1000,
        });
        const next = sanitizeNext(req.query.next);
        if (next !== '/') {
            res.cookie(NEXT_COOKIE, next, {
                sameSite: 'lax', secure: config.cookies.secure, httpOnly: true,
                path: '/auth', maxAge: 10 * 60 * 1000,
            });
        }
        res.redirect(url);
    });

    // ── GET /auth/callback ───────────────────────────────────
    router.get('/callback', async (req, res) => {
        const { code, state, error } = req.query;
        if (error) return res.redirect(`/?auth_error=${encodeURIComponent(error)}`);
        if (!code) return res.status(400).send('Missing authorization code');

        const expectedState = req.cookies?.[STATE_COOKIE];
        res.clearCookie(STATE_COOKIE, { path: '/auth' });
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
            const next = sanitizeNext(req.cookies?.[NEXT_COOKIE]);
            res.clearCookie(NEXT_COOKIE, { path: '/auth' });
            return res.redirect(next);
        } catch (err) {
            console.error('[Auth] Code exchange failed:', err.message);
            return res.status(502).send('Sign-in failed — could not reach the OpenVibe.Network. Please try again.');
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

module.exports = { createAuthClient, createAuthRoutes, extractToken };
