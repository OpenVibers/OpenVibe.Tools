'use strict';

// ═══════════════════════════════════════════════════════════════
// openvibe.tools — Gateway Server
//
// Serves the apex directory page plus the Host-header-routed tool
// subdomains: Net.OpenVibe (38 network tools), Dev.OpenVibe
// (26 developer tools), and Paste.OpenVibe (backed by OpenVibe.Media).
//
// Identity lives on OpenVibe.Network — this service is an OAuth2
// CLIENT (`tools`). See server/auth/routes.js for the session layer.
// No local database: config falls back to defaults and auth is
// verified offline against the Network's public key.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');

const config = require('./config');
const { BRAND } = require('openvibe-shared/brand');
const { createAuthClient, createAuthRoutes, extractToken } = require('./auth/routes');
const createNetRoutes = require('./net/routes');
const { NET_TOOL_MAP, NET_ALIASES } = require('./net/config');
const createDevRoutes = require('./dev/routes');
const { DEV_TOOL_MAP, DEV_ALIASES } = require('./dev/config');

const app = express();

function getRequestHost(req) {
    return String(req.headers.host || '').split(':')[0].toLowerCase();
}

// ── Security ─────────────────────────────────────────────────
app.set('trust proxy', 2); // Cloudflare → Nginx → Node

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://openvibe.network", "https://openvibe.live", "cdnjs.cloudflare.com", "cdn.jsdelivr.net", "fonts.googleapis.com"],
            styleSrc: ["'self'", "'unsafe-inline'", "cdnjs.cloudflare.com", "fonts.googleapis.com", "fonts.gstatic.com"],
            fontSrc: ["'self'", "fonts.gstatic.com", "cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "blob:", "https://openvibe.network", "https://openvibe.media"],
            connectSrc: ["'self'", "https://openvibe.network", "https://openvibe.tools", "https://*.openvibe.tools", "https://openvibe.media", "https://openvibe.live", "https://openvibe.games"],
            frameSrc: ["'none'"],
            scriptSrcAttr: ["'unsafe-inline'"],
        },
    },
    crossOriginEmbedderPolicy: false,
}));
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ── CORS ─────────────────────────────────────────────────────
// Every *.openvibe.tools subdomain (satellites included) may call the
// gateway APIs with credentials, as may the sibling network services.
const STATIC_ORIGINS = new Set([
    'https://openvibe.tools',
    'https://openvibe.network',
    'https://openvibe.media',
    'https://openvibe.live', 'https://www.openvibe.live',
    'https://openvibe.games', 'https://www.openvibe.games',
]);

function isAllowedOrigin(origin) {
    if (STATIC_ORIGINS.has(origin)) return true;
    try {
        const u = new URL(origin);
        if (u.protocol === 'https:' && u.hostname.endsWith('.openvibe.tools')) return true;
        if (!config.isProduction && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true;
    } catch { /* ignore */ }
    return false;
}

app.use(cors({
    origin(origin, callback) {
        if (!origin) return callback(null, true); // curl / server-to-server
        if (isAllowedOrigin(origin)) return callback(null, true);
        return callback(new Error('Origin not allowed by CORS'));
    },
    credentials: true,
}));

// ── Rate Limiting ────────────────────────────────────────────
app.use('/api/', rateLimit({ windowMs: 60_000, max: 120 }));
app.use('/auth/', rateLimit({ windowMs: 15 * 60_000, max: 60 }));

// ── Auth (OAuth2 client of OpenVibe.Network) ─────────────────
const auth = createAuthClient(config);
app.locals.auth = auth;
app.locals.config = config;

app.use('/auth', createAuthRoutes(config, auth));

/** 401 unless a valid ov_token is presented. */
async function requireAuth(req, res, next) {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    const claims = await auth.verify(token);
    if (!claims) return res.status(401).json({ error: 'Invalid or expired token' });
    req.user = claims;
    req.token = token;
    next();
}

// ── Basic API ────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'openvibe-tools-gateway', version: '2.0.0' });
});

app.get('/api/brand', (_req, res) => res.json(BRAND));

// ── Paste.OpenVibe → OpenVibe.Live proxy ─────────────────────
// The paste front-end talks to /api/pastes/* on this gateway; we proxy server-side to
// the same API the streaming site's own paste pages use. Keeping the proxy avoids CORS
// headaches and hides the upstream from the browser.
//
// This used to call Media's tenant API directly, forwarding the visitor's JWT for Media
// to identify them by. That was wrong: the JWT names the account by its NETWORK id,
// while the user_id Media stores for these pastes is Live's own — different numbers for
// the same person, so a comment posted here was filed under whichever unrelated Live
// account happened to hold that number. Live resolves the visitor against its own
// accounts before writing, which is a thing only Live can do, and this inherits its
// author names and permission checks rather than reimplementing them.
app.use('/api/pastes', rateLimit({ windowMs: 60_000, max: 120 }), async (req, res) => {
    try {
        const target = `${config.liveUrl}/api/pastes${req.url}`;
        const fetchOpts = { method: req.method, headers: {} };
        // Forward the visitor's JWT — Live verifies it and maps it to a local account.
        const userToken = extractToken(req);
        if (userToken) fetchOpts.headers['Authorization'] = `Bearer ${userToken}`;
        // Live rate-limits, bans and records by client address. Without this every
        // visitor arriving through this gateway would share one bucket and one identity.
        if (req.ip) fetchOpts.headers['X-Forwarded-For'] = req.ip;
        if (req.method !== 'GET' && req.method !== 'HEAD' && req.body && Object.keys(req.body).length) {
            fetchOpts.headers['Content-Type'] = 'application/json';
            fetchOpts.body = JSON.stringify(req.body);
        }
        const upstream = await fetch(target, fetchOpts);
        const ct = upstream.headers.get('content-type') || '';
        res.status(upstream.status);
        if (ct) res.setHeader('Content-Type', ct);
        const raw = Buffer.from(await upstream.arrayBuffer());
        return res.send(raw);
    } catch (err) {
        console.error('[PasteProxy]', err.message);
        return res.status(502).json({ error: 'Could not reach the media service' });
    }
});

// ── Net.OpenVibe — Network Tools API ─────────────────────────
app.use('/api/net', rateLimit({ windowMs: 60_000, max: 60 }), createNetRoutes(null, requireAuth));

// ── Dev.OpenVibe — Developer & SEO Tools API ─────────────────
app.use('/api/dev', rateLimit({ windowMs: 60_000, max: 60 }), createDevRoutes(null, requireAuth));

// ── Host-header subdomain routing ────────────────────────────
function subdomainOf(req) {
    return getRequestHost(req).replace(/\.openvibe\.tools$/, '');
}

function isNetHost(req) {
    const sub = subdomainOf(req);
    return NET_TOOL_MAP.has(sub) || NET_ALIASES[sub];
}

function isDevHost(req) {
    const sub = subdomainOf(req);
    return DEV_TOOL_MAP.has(sub) || DEV_ALIASES[sub];
}

function isStaticPath(reqPath) {
    return /\.(js|css|ico|png|svg|jpg|xml|txt|woff2?)$/.test(reqPath);
}

// Net tool subdomains → net.html SPA
app.use((req, res, next) => {
    if (!isNetHost(req)) return next();
    if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) return next();
    if (isStaticPath(req.path)) return next();
    return res.sendFile(path.join(__dirname, '..', 'public', 'net.html'));
});

// Paste subdomain → paste.html SPA
app.use((req, res, next) => {
    if (getRequestHost(req) !== 'pastes.openvibe.tools') return next();
    if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) return next();
    if (isStaticPath(req.path)) return next();
    return res.sendFile(path.join(__dirname, '..', 'public', 'paste.html'));
});

// Dev tool subdomains → dev.html SPA
app.use((req, res, next) => {
    if (!isDevHost(req)) return next();
    if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) return next();
    if (isStaticPath(req.path)) return next();
    return res.sendFile(path.join(__dirname, '..', 'public', 'dev.html'));
});

// ── Web-push service worker (same-origin, scope "/") ─────────
app.get('/openvibe-sw.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Service-Worker-Allowed', '/');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.resolve(__dirname, '..', '..', '..', 'vendor', 'openvibe-shared', 'openvibe-sw.js'));
});

// ── Static Files ─────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public'), {
    setHeaders(res, filePath) {
        if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
            res.setHeader('Cache-Control', 'no-cache');
        }
    },
}));

// ── Fallback ─────────────────────────────────────────────────
app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'Not found' });
    }
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ── Start ────────────────────────────────────────────────────
app.listen(config.port, config.host, () => {
    console.log(`\n╔════════════════════════════════════════════╗`);
    console.log(`║   🔧 openvibe.tools — Tools Gateway         ║`);
    console.log(`╠════════════════════════════════════════════╣`);
    console.log(`║  Port:    ${String(config.port).padEnd(32)}║`);
    console.log(`║  URL:     ${config.baseUrl.padEnd(32)}║`);
    console.log(`║  SSO:     ${config.networkUrl.padEnd(32)}║`);
    console.log(`║  Live:    ${config.liveUrl.padEnd(32)}║`);
    console.log(`╚════════════════════════════════════════════╝\n`);
});
