/**
 * food.openvibe.tools — Lightweight frontend server
 * Proxies food API calls to openvibe-maps backend (port 4010)
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const http = require('http');
const fs = require('fs');
const cookieParser = require('cookie-parser');

// ── Analytics ────────────────────────────────────────────────
const { AnalyticsTrackerPg } = require('openvibe-shared/analytics/pg'); // ADR-021: no IP/user id, route templates, raw rows pruned after 30 days, Sec-GPC/DNT not recorded
const { requireInternalAccess } = require('../../_shared/internal-token');
const { hostGuard, stampedPage } = require('../../_shared/host-role');
const { createToolsApi, exceptRegistry } = require('../../_shared/tools/http');
const { createLocalRegistry, requiresStatus } = require('../../_shared/tools/local');
const { createGuard, TRUST_PROXY } = require('../../_shared/guard');

// ── Guard (apps/_shared/guard) ───────────────────────────────
// Who is asking (Network sign-in with aud openvibe.tools, else the address), the tools-api quota and
// the abuse log (data/guard.db). The data lookups are counted by maps (tools-map), which gets the
// visitor's address from here. TOOLS_GUARD=enforce (default) refuses; report records what it would refuse.
const NETWORK_URL = process.env.OV_NETWORK_URL || 'https://openvibe.network';
// The one `tools` database and the shared Valkey (plan T8, decisions 3 and 4).
const toolsDb = require('../../_shared/db').openToolsDb({ createDb: require('openvibe-sdk/db').createDb, service: 'tools-food' });
const analytics = new AnalyticsTrackerPg(toolsDb.db, 'openvibe-food', { retention: { days: 30 } }); // ADR-021; PostgreSQL (plan T8)
const toolsValkey = require('../../_shared/db').openToolsValkey({ createValkey: require('openvibe-sdk/valkey').createValkey });
const guard = createGuard({
    app: 'food', db: toolsDb.db, valkey: toolsValkey, specs: require('../../maps/server/descriptors').SPECS.filter(s => s.id === 'food'),
    issuer: NETWORK_URL, networkUrl: NETWORK_URL, networkInternalUrl: process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000',
    publicKeyFiles: [process.env.OV_NETWORK_PUBLIC_KEY].filter(Boolean),
});

const PORT = parseInt(process.env.PORT) || 4011;
const MAPS_API = process.env.MAPS_API || 'http://127.0.0.1:4010';

const app = express();
// What this deploy runs (ADR-016); the shared navbar's release-watch polls it on every tool host.
const release = require('../../_shared/release').toolsRelease('food', require);   // its components: apps/_shared/release.js
// Metrics (GET /metrics, direct loopback callers only) and GET /api/ready from this server's real
// dependencies (roadmap Track O). First, so the HTTP metrics see every request.
const { observe, checks: ready } = require('../../_shared/observe');
// Serve only once the schema is in: the first PGlite migration must not run inside a request (it
// would block the event loop and time out a satellite's readiness check).
app.use((req, res, next) => toolsDb.ready.then(() => next(), next));
const obs = observe({
    app, metrics: require('openvibe-shared/metrics'), ready: require('openvibe-shared/ready'),
    service: 'tools-food', release: release.release,
    checks: [
        // Every food API answer comes from the maps satellite; without it this server only has its page.
        ready.postgres('tools_db', () => toolsDb.db, { description: 'the one tools database (guard_abuse, analytics, revocations)' }),
        ready.upstream('maps', `${MAPS_API}/api/ready`, { required: true, cacheMs: 5000, description: 'food APIs are proxied to the maps satellite' }),
    ],
});
guard.attachMetrics(obs.registry);
// GET /release.json (ADR-016) and POST /release-metrics, which the shared navbar's release-watch reports
// its update outcomes to (release_client_updates_total on /metrics): openvibe-shared release.mount.
release.mount(app, { registry: obs.registry });

// Legal documents live on the apex; every tool host points there instead of answering 404.
app.get(['/terms', '/privacy', '/dmca', '/tos'], (req, res) => res.redirect(301, 'https://openvibe.tools' + (req.path === '/tos' ? '/terms' : req.path)));

// One hop on loopback (the host's nginx, or the gateway) is the proxy: req.ip is the address it gives,
// which is what maps is told below. A client's own X-Forwarded-For is never believed.
app.set('trust proxy', TRUST_PROXY);
app.use(exceptRegistry(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (/^https:\/\/[a-z0-9-]+\.openvibe\.tools$/.test(origin)) return callback(null, true);
    if (/^https:\/\/(openvibelive\.com|openvibe\.quest)$/.test(origin)) return callback(null, true);
    if (process.env.NODE_ENV === 'development' && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return callback(null, true);
    return callback(new Error('Origin not allowed'));
  },
  credentials: true,
})));
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'https://openvibe.network'],
      styleSrc: ["'self'", "'unsafe-inline'", 'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'],
      fontSrc: ["'self'", 'fonts.gstatic.com', 'cdnjs.cloudflare.com'],
      imgSrc: ["'self'", 'data:', 'image.tmdb.org', '*.tile.openstreetmap.org', '*.basemaps.cartocdn.com', 'server.arcgisonline.com'],
      // events.openvibe.network: release notifications (release-watch's EventSource, openvibe-shared 1.17).
      connectSrc: ["'self'", 'nominatim.openstreetmap.org', 'https://openvibe.network', 'https://events.openvibe.network'],
      scriptSrcAttr: ["'unsafe-inline'"],
    },
  },
}));
// Sign-in first, so limits know who is asking; everyone else counts by address (IPv6 /64).
app.use(cookieParser());
app.use(guard.identify);
app.use('/api/', guard.apiQuota);

// ── Tool registry (ADR-027): GET /api/v1/tools[/:id[/schema]] for this app's food finder ──
// Public (Access-Control-Allow-Origin *), cacheable (ETag), counted by the quota above. The
// gateway (openvibe.tools) answers the same routes for every tool and reads this list for status.
// The food finder is built on the maps backend; its descriptor lives with the maps app's.
const toolRegistry = createLocalRegistry({ specs: require('../../maps/server/descriptors').SPECS.filter(s => s.id === 'food') });
// Per-actor limits (apps/_shared/actor-limits.js, roadmap WS-R task 4): signed-in registry reads (signed-out reads keep
// the per-address limit only).
const actorLimits = require('../../_shared/actor-limits').createToolsLimits({ app: 'food', createActorLimiter: require('openvibe-sdk/limits').createActorLimiter, guard, registry: obs.registry });
app.use(actorLimits.registryReads);
app.use(createToolsApi({ snapshot: toolRegistry.snapshot }));

// ── Analytics Middleware ─────────────────────────────────────
app.use(analytics.middleware());

// ── Hosts + the page ───────────────────────────────────────
// Through the gateway the X-OV-* headers name the canonical host (a custom domain included) and the
// page's canonical / og:url / JSON-LD follow it; aliases are redirected; other hosts go to the tools index.
const HOST = 'food.openvibe.tools';
app.use(hostGuard({ knows: (h) => h === HOST }));
const sendIndex = stampedPage(path.join(__dirname, '..', 'public', 'index.html'), HOST);
app.get(['/', '/index.html'], sendIndex);

// Static files
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1d', index: false }));

// Proxy food-related API calls to openvibe-maps backend. The visitor's address goes along, so maps
// rate-limits each person instead of putting every food visitor in one 127.0.0.1 bucket.
function proxyToMaps(apiPath, allowedParams) {
  return async (req, res) => {
    const incoming = new URL(req.url, 'http://localhost').searchParams;
    const query = new URLSearchParams();
    for (const key of allowedParams) {
      for (const value of incoming.getAll(key)) query.append(key, value);
    }
    const qs = query.toString();
    const url = `${MAPS_API}${apiPath}${qs ? `?${qs}` : ''}`;
    try {
      const headers = req.ip ? { 'X-Forwarded-For': req.ip, 'X-Real-IP': req.ip } : {};
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
      if (response.status >= 500 && response.status < 600) return res.status(502).json({ error: 'Backend unavailable' });
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (e) {
      res.status(502).json({ error: 'Backend unavailable' });
    }
  };
}

// Keep these in step with the query fields read by the matching maps routes.
app.get('/api/food-banks', proxyToMaps('/api/food-banks', ['lat', 'lon', 'radius']));
app.get('/api/stores', proxyToMaps('/api/stores', ['lat', 'lon']));
app.get('/api/foods', proxyToMaps('/api/foods', ['group', 'campFriendly', 'shelfStable', 'search']));
app.get('/api/meal-plan', proxyToMaps('/api/meal-plan', ['budget', 'days', 'campFriendly', 'shelfStable', 'randomize']));
app.get('/api/geocode', proxyToMaps('/api/geocode', ['q']));

// ── Internal Analytics API ────────────────────────────────────
const internalAccess = requireInternalAccess({ keys: guard.keys, issuer: guard.issuer, audience: guard.audience });
app.get('/api/internal/analytics', internalAccess, async (req, res) => {
    try { const d = Math.min(parseInt(req.query.days) || 30, 365); const h = req.query.hours ? Math.min(parseInt(req.query.hours), 8760) : null; res.json({ ok: true, analytics: await analytics.getStats({ days: d, hours: h }) }); }
    catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.get('/api/internal/analytics/bots', internalAccess, async (req, res) => {
    try { res.json({ ok: true, bots: await analytics.getBotAnalysis(Math.min(parseInt(req.query.days) || 30, 365)) }); }
    catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// SPA fallback
app.get('*', (req, res) => sendIndex(req, res));

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`[Food.OpenVibe] 🍽️  food.openvibe.tools listening on 127.0.0.1:${PORT}`);
});

// ── Graceful stop (roadmap WS-P lifecycle; apps/_shared/graceful.js) ──
// SIGTERM: the server stops taking connections and lets requests in flight finish (4 s at most);
// then the analytics and the guard close, and the process exits 0, within the manifest's 5 s.
require('../../_shared/graceful').gracefulStop({
    name: 'Food.OpenVibe', server,
    close: [
        () => analytics.destroy(),
        () => guard.close(),
        () => toolsDb.db.close(),
        () => toolsValkey && toolsValkey.close(),
    ],
});
