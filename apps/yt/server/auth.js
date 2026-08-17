'use strict';

// ═══════════════════════════════════════════════════════════════
// YT.OpenVibe — JWT Auth (OpenVibe Network RS256 verification)
// Lightweight auth — no DB, no linked_accounts.
// Verifies the shared ov_token cookie offline against the
// Network's public key and attaches decoded claims to req.user.
// Key source: OV_NETWORK_PUBLIC_KEY file override, otherwise
// fetched from the Network's /api/.well-known/jwks endpoint.
// ═══════════════════════════════════════════════════════════════

const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const config = require('./config');

let publicKey = null;
let retryTimer = null;

const ISSUER = config.networkUrl;
const JWKS_PATH = '/api/.well-known/jwks';
const FETCH_TIMEOUT_MS = 5000;
const RETRY_INTERVAL_MS = 60 * 1000;

function loadKeyFromFile() {
    for (const p of config.publicKeyPaths) {
        try {
            const resolved = path.resolve(p);
            if (fs.existsSync(resolved)) {
                publicKey = fs.readFileSync(resolved, 'utf8');
                console.log(`[Auth] Loaded OpenVibe Network public key from ${resolved}`);
                return true;
            }
        } catch { /* try next */ }
    }
    return false;
}

async function fetchKeyFromNetwork() {
    for (const base of [config.networkInternalUrl, config.networkUrl]) {
        try {
            const res = await fetch(`${base}${JWKS_PATH}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
            if (!res.ok) continue;
            const body = await res.json();
            if (body && body.public_key) {
                publicKey = body.public_key;
                console.log(`[Auth] Loaded OpenVibe Network public key from ${base}${JWKS_PATH}`);
                return true;
            }
        } catch { /* try next base */ }
    }
    return false;
}

function loadPublicKey() {
    if (loadKeyFromFile()) return;
    fetchKeyFromNetwork().then((loaded) => {
        if (loaded || retryTimer) return;
        console.warn(`[Auth] OpenVibe Network unreachable — will retry every ${RETRY_INTERVAL_MS / 1000}s (users treated as anonymous until the key loads)`);
        retryTimer = setInterval(async () => {
            if (await fetchKeyFromNetwork()) {
                clearInterval(retryTimer);
                retryTimer = null;
            }
        }, RETRY_INTERVAL_MS);
        if (retryTimer.unref) retryTimer.unref();
    });
}
loadPublicKey();

function extractToken(req) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) return authHeader.slice(7);
    if (req.cookies?.ov_token) return req.cookies.ov_token;
    if (req.cookies?.token) return req.cookies.token;
    return null;
}

function verifyToken(token) {
    if (!publicKey || !token) return null;
    try {
        return jwt.verify(token, publicKey, { algorithms: ['RS256'], issuer: ISSUER });
    } catch {
        return null;
    }
}

/**
 * Optional auth — attaches req.user if valid token present.
 * Never blocks the request; anonymous users get req.user = null.
 */
function optionalAuth(req, _res, next) {
    const token = extractToken(req);
    if (token) {
        const decoded = verifyToken(token);
        if (decoded) {
            req.user = decoded;
            req.token = token;
        }
    }
    next();
}

/**
 * Required auth — 401 if no valid token.
 */
function requireAuth(req, res, next) {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    const decoded = verifyToken(token);
    if (!decoded) return res.status(401).json({ error: 'Invalid or expired token' });
    req.user = decoded;
    req.token = token;
    next();
}

module.exports = { extractToken, verifyToken, optionalAuth, requireAuth, loadPublicKey };
