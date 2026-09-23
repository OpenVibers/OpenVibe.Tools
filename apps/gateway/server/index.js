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
const { createAuthClient, createAuthRoutes, extractToken, fedcmCors } = require('./auth/routes');
const createNetRoutes = require('./net/routes');
const { NET_TOOL_MAP, NET_ALIASES } = require('./net/config');
const createDevRoutes = require('./dev/routes');
const { DEV_TOOL_MAP, DEV_ALIASES } = require('./dev/config');

const app = express();
// What this deploy runs (ADR-016); the shared navbar's release-watch polls it on every tool host.
const release = require('openvibe-shared/release').createRelease({ service: 'tools', root: require('path').join(__dirname, '..', '..', '..') });

// The satellites on this host (ports), for readiness and the analytics roll-up.
// TOOLS_SATELLITE_PORTS="img=5012,yt=5013" overrides single entries (tests, a moved unit).
const SATELLITES = { maps: 4010, food: 4011, img: 4012, yt: 4013, audio: 4014, text: 4015, docs: 4016 };
for (const pair of String(process.env.TOOLS_SATELLITE_PORTS || '').split(',')) {
    const [name, port] = pair.split('=').map(x => String(x || '').trim());
    if (SATELLITES[name] && /^\d{2,5}$/.test(port)) SATELLITES[name] = Number(port);
}
const SATELLITE_BY_PORT = new Map(Object.entries(SATELLITES).map(([name, port]) => [port, name]));

// Metrics (GET /metrics, direct loopback callers only) and readiness (roadmap Track O). The metrics
// middleware goes first so it sees every request, proxied ones included; /api/ready is mounted after
// the host router, so on a satellite's host it is the satellite's own.
const { observe, checks: ready } = require('../../_shared/observe');
const registry = require('./registry');
let auth = null;   // created below; the key check reads it at request time
const obs = observe({
    app, metrics: require('openvibe-shared/metrics'), ready: require('openvibe-shared/ready'),
    service: 'tools', release: release.release, mountReady: false,
    normalize: (req) => {
        if (req.ovHost && req.ovHost.port) return `proxy:${SATELLITE_BY_PORT.get(req.ovHost.port) || 'other'}`;
        if (req.baseUrl === '/api/pastes') return '/api/pastes/*';
        if (isNetHost(req)) return 'page:net';
        if (isDevHost(req)) return 'page:dev';
        return null;
    },
    checks: [
        {
            name: 'catalog', required: true, description: 'the tool catalog every apex page, host route and proxy decision is built from',
            check: () => { const n = registry.get().tools.length; return n > 0 ? { ok: true, detail: { tools: n } } : 'catalog is empty'; },
        },
        ready.networkKey('network_key', () => auth && auth.client.publicKey, { description: 'verifies signed-in visitors offline; signed-out use works without it' }),
        {
            name: 'service_directory', required: false, description: 'other services\' origins from the Network registry (a built-in fallback list is used without it)',
            check: () => { const s = registry.services.status(); return s.source === 'registry' ? { ok: true, detail: { as_of: s.as_of, last_ok: s.last_ok } } : `using the built-in fallback list${s.last_error ? ` (${s.last_error})` : ''}`; },
        },
        ready.upstream('community', `${config.communityUrl}/api/ready`, { description: 'paste API proxy (pastes.openvibe.tools)' }),
        ...Object.entries(SATELLITES).map(([name, port]) => ready.upstream(`satellite_${name}`, `http://127.0.0.1:${port}/api/ready`, { description: `${name} satellite (port ${port}); its hosts fail without it` })),
    ],
});
app.get('/release.json', release.handler);

function getRequestHost(req) {
    return String(req.headers.host || '').split(':')[0].toLowerCase();
}

// ── Security ─────────────────────────────────────────────────
// One hop: the host's nginx, which applies Cloudflare's real IP (real_ip_header CF-Connecting-IP) and
// sets X-Forwarded-For to $remote_addr. req.ip is that address; anything a client put in its own
// X-Forwarded-For stays to the left of it and is never believed (myip, rate limits, forwarded IPs).
app.set('trust proxy', 1);

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://openvibe.network", "https://openvibe.live", "cdnjs.cloudflare.com", "cdn.jsdelivr.net", "fonts.googleapis.com", "https://static.cloudflareinsights.com"],
            styleSrc: ["'self'", "'unsafe-inline'", "cdnjs.cloudflare.com", "fonts.googleapis.com", "fonts.gstatic.com"],
            fontSrc: ["'self'", "fonts.gstatic.com", "cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "blob:", "https://openvibe.network", "https://openvibe.media"],
            connectSrc: ["'self'", "https://cloudflareinsights.com", "https://openvibe.network", "https://openvibe.tools", "https://*.openvibe.tools", "https://openvibe.media", "https://openvibe.live", "https://openvibe.games"],
            frameSrc: ["https://openvibe.network"], // the hidden /sso/check sign-in probe
            scriptSrcAttr: ["'unsafe-inline'"],
        },
    },
    crossOriginEmbedderPolicy: false,
}));
// ── Host roles: aliases redirect, unknown hosts leave, satellite hosts are proxied ──
const { hostRoles } = require('./registry/host-middleware');
registry.start();
app.use(hostRoles({
    hostOf: getRequestHost,
    enforce: config.isProduction || process.env.OV_ENFORCE_HOSTS === '1',
    // Gateway-served subdomains that predate the catalog (tool aliases, the pastes hand-off).
    isLegacyHost: (sub) => NET_TOOL_MAP.has(sub) || !!NET_ALIASES[sub] || DEV_TOOL_MAP.has(sub) || !!DEV_ALIASES[sub] || ['pastes', 'paste', 'my', 'login'].includes(sub),
}));

app.get('/api/ready', obs.readiness.handler);

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

// POST /auth/fedcm is the one credentialed cross-origin call satellites make to the apex;
// it gets its own, stricter gate (openvibe.tools zone only) and must answer its own
// preflight before the wider allow-list below gets a chance to.
app.use('/auth/fedcm', fedcmCors);

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
auth = createAuthClient(config);
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
    res.json({ status: 'ok', service: 'openvibe-tools-gateway', version: '2.0.0', registry: registry.services.status() });
});

app.get('/api/brand', (_req, res) => res.json(BRAND));

// ── Paste.OpenVibe → OpenVibe.Community proxy ────────────────
// The paste front-end talks to /api/pastes/* on this gateway; we proxy server-side to OpenVibe.Community,
// which owns pastes (roadmap Wave 5). The visitor's Network JWT goes along: Community verifies it and
// files writes under the person's canonical subject, so no site has to translate ids any more. The
// client address goes along too, for Community's anonymous-write limits.
app.use('/api/pastes', rateLimit({ windowMs: 60_000, max: 120 }), async (req, res) => {
    try {
        const target = `${config.communityUrl}/api/pastes${req.url}`;
        const fetchOpts = { method: req.method, headers: {} };
        // Forward the visitor's JWT — Community verifies it and maps it to their subject.
        const userToken = extractToken(req);
        if (userToken) fetchOpts.headers['Authorization'] = `Bearer ${userToken}`;
        // Community rate-limits anonymous writes by client address. Without this every
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
        return res.status(502).json({ error: 'Could not reach the paste service' });
    }
});

// ── Net.OpenVibe — Network Tools API ─────────────────────────
app.use('/api/net', rateLimit({ windowMs: 60_000, max: 60 }), createNetRoutes(null, requireAuth));

// ── Dev.OpenVibe — Developer & SEO Tools API ─────────────────
app.use('/api/dev', rateLimit({ windowMs: 60_000, max: 60 }), createDevRoutes(null, requireAuth));

// ── Host-header subdomain routing ────────────────────────────
function subdomainOf(req) {
    // A mirror or custom domain is the tool it points at.
    if (req.ovHost && req.ovHost.tool) return req.ovHost.tool;   // descriptive hosts, mirrors and custom domains all resolve to a tool id
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
    return /\.(js|css|ico|png|svg|jpg|xml|txt|woff2?|webmanifest)$/.test(reqPath);
}

// Every tool subdomain gets its OWN title, description, canonical, structured data and a
// crawlable content block (server/seo). They used to share the hub's <head>, which told search
// engines that ~65 distinct tools were one page.
const { renderTool } = require('./seo/render');
const NET_HTML = path.join(__dirname, '..', 'public', 'net.html');
const DEV_HTML = path.join(__dirname, '..', 'public', 'dev.html');
function sendTool(req, res, file) {
    try {
        res.set('Content-Type', 'text/html; charset=utf-8');
        return res.send(renderTool(file, subdomainOf(req), req.ovHost && req.ovHost.canonicalHost));
    } catch (err) {
        console.error('[SEO] render failed:', err.message);
        return res.sendFile(file);
    }
}

// ── Internal analytics (Network admin + ranking) ─────────────
// The gateway keeps no analytics of its own; it adds up the satellites'. Internal key + loopback only.
{
    const { requireInternal } = require('../../_shared/internal-auth');
    app.get('/api/internal/analytics', requireInternal, async (req, res) => {
        const days = Math.min(parseInt(req.query.days, 10) || 30, 365);
        const hours = req.query.hours ? Math.min(parseInt(req.query.hours, 10), 8760) : null;
        const key = String(req.headers['x-internal-key']);
        const parts = await Promise.all(Object.entries(SATELLITES).map(async ([name, port]) => {
            try {
                const r = await fetch(`http://127.0.0.1:${port}/api/internal/analytics?days=${days}${hours ? '&hours=' + hours : ''}`, { headers: { 'X-Internal-Key': key }, signal: AbortSignal.timeout(5000) });
                const j = r.ok ? await r.json() : null;
                return j && j.analytics ? { name, analytics: j.analytics } : null;
            } catch { return null; }
        }));
        const live = parts.filter(Boolean);
        const summary = {};
        for (const p of live) for (const [k, v] of Object.entries(p.analytics.summary || {})) if (typeof v === 'number' && !/^avg_/.test(k)) summary[k] = (summary[k] || 0) + v;
        const avg = live.map(p => Number(p.analytics.summary && p.analytics.summary.avg_response_ms) || 0).filter(Boolean);
        if (avg.length) summary.avg_response_ms = Math.round(avg.reduce((a, b) => a + b, 0) / avg.length);
        const realtime = {};
        for (const p of live) for (const [k, v] of Object.entries(p.analytics.realtime || {})) if (typeof v === 'number') realtime[k] = (realtime[k] || 0) + v;
        // The busiest satellite's detail tables stand in for the family; per-app numbers are listed beside them.
        const lead = live.slice().sort((a, b) => (b.analytics.summary?.total_pageviews || 0) - (a.analytics.summary?.total_pageviews || 0))[0];
        res.set('Cache-Control', 'no-store').json({ ok: true, analytics: Object.assign({}, lead ? lead.analytics : {}, { summary, realtime, apps: live.map(p => ({ name: p.name, ...(p.analytics.summary || {}) })) }) });
    });
}

// Terms, Privacy and DMCA — the same documents on the apex and on every tool host.
{ const legal = require('openvibe-shared/legal'); app.get(legal.PATHS, legal.handler({ id: 'tools', service: 'tools', host: 'openvibe.tools', name: 'OpenVibe.Tools', profile: 'tools' })); app.get('/tos', (_req, res) => res.redirect(301, '/terms')); }

// The apex is server-rendered from the registry: index, families, tool pages, search,
// sitemap.xml, robots.txt, llms.txt and /api/catalog.json (server/pages/site.js).
app.use(require('./pages/site').createSiteRouter());

// Net tool subdomains → net.html SPA
app.use((req, res, next) => {
    if (!isNetHost(req)) return next();
    if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) return next();
    if (isStaticPath(req.path)) return next();
    return sendTool(req, res, NET_HTML);
});

// Paste subdomain → hands over to openvibe.community
app.use((req, res, next) => {
    if (getRequestHost(req) !== 'pastes.openvibe.tools') return next();
    if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) return next();
    if (isStaticPath(req.path)) return next();
    // Pastes live on openvibe.community. Old links keep their paste: /<slug> and /p/<slug> → /p/<slug> there
    // (the page used to drop the slug and show the index). Signed-in visitors go through its silent sign-in.
    const COMMUNITY = (process.env.OV_COMMUNITY_URL || registry.services.origin('community', 'https://openvibe.community')).replace(/\/$/, '');   // Community's origin from Network's registry
    const m = /^\/(?:p\/)?([A-Za-z0-9][A-Za-z0-9_-]{1,80})\/?$/.exec(req.path);
    const target = m && !['new', 'my', 'pastes'].includes(m[1]) ? `/p/${m[1]}` : (req.path === '/new' ? '/new' : req.path === '/my' ? '/my' : '/pastes');
    if (/(?:^|;\s*)ov_sso_hint=account(?:;|$)/.test(String(req.headers.cookie || ''))) {
        res.set({ 'Cache-Control': 'private, no-store', Vary: 'Cookie' });
        return res.redirect(302, `${COMMUNITY}/auth/login?silent=1&next=${encodeURIComponent(target)}`);
    }
    return res.redirect(301, COMMUNITY + target);
});

// Dev tool subdomains → dev.html SPA
app.use((req, res, next) => {
    if (!isDevHost(req)) return next();
    if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) return next();
    if (isStaticPath(req.path)) return next();
    return sendTool(req, res, DEV_HTML);
});

// ── Web-push service worker (same-origin, scope "/") ─────────
app.get('/openvibe-sw.js', (req, res) => {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Service-Worker-Allowed', '/');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(require('openvibe-shared/files').path('openvibe-sw.js'));
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
    // Unknown page: a real 404 that still helps (search + every family), never a soft-200 copy of the index.
    res.status(404).set('Cache-Control', 'no-store').type('html').send(require('./pages/site').renderNotFound());
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
