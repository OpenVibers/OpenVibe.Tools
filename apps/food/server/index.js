/**
 * food.openvibe.tools — Lightweight frontend server
 * Proxies food API calls to openvibe-maps backend (port 4010)
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const http = require('http');
const fs = require('fs');
const cookieParser = require('cookie-parser');

// ── Analytics ────────────────────────────────────────────────
const Database = require('better-sqlite3');
const { AnalyticsTracker } = require('openvibe-shared/analytics'); // ADR-021: no IP/user id, route templates, raw rows pruned after 30 days, Sec-GPC/DNT not recorded
const { internalOk } = require('../../_shared/internal-auth');
const { hostGuard, stampedPage } = require('../../_shared/host-role');
const { createToolsApi, exceptRegistry } = require('../../_shared/tools/http');
const { createLocalRegistry, requiresStatus } = require('../../_shared/tools/local');
const { createGuard, TRUST_PROXY } = require('../../_shared/guard');
const analyticsDbPath = path.join(__dirname, '..', 'data', 'analytics.db');
fs.mkdirSync(path.dirname(analyticsDbPath), { recursive: true });
const analyticsDb = new Database(analyticsDbPath);
analyticsDb.pragma('journal_mode = WAL');
const analytics = new AnalyticsTracker(analyticsDb, 'openvibe-food', { retention: { days: 30 } });

// ── Guard (apps/_shared/guard) ───────────────────────────────
// Who is asking (Network sign-in with aud openvibe.tools, else the address), the tools-api quota and
// the abuse log (data/guard.db). The data lookups are counted by maps (tools-map), which gets the
// visitor's address from here. TOOLS_GUARD=report (default) records what it would refuse.
const NETWORK_URL = process.env.OV_NETWORK_URL || 'https://openvibe.network';
const guard = createGuard({
    app: 'food', dataDir: path.join(__dirname, '..', 'data'), Database, specs: require('../../maps/server/descriptors').SPECS.filter(s => s.id === 'food'),
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
const obs = observe({
    app, metrics: require('openvibe-shared/metrics'), ready: require('openvibe-shared/ready'),
    service: 'tools-food', release: release.release,
    checks: [
        // Every food API answer comes from the maps satellite; without it this server only has its page.
        ready.upstream('maps', `${MAPS_API}/api/ready`, { required: true, cacheMs: 5000, description: 'food APIs are proxied to the maps satellite' }),
        ready.sqlite('analytics_db', analyticsDb, { required: false, description: 'visit analytics only' }),
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
app.use(guard.legacyLimiter(rateLimit, { windowMs: 60000, anonymous: 60, signedIn: 120, message: 'Too many requests. Please try again later.' }));
app.use('/api/', guard.apiQuota);

// ── Tool registry (ADR-027): GET /api/v1/tools[/:id[/schema]] for this app's food finder ──
// Public (Access-Control-Allow-Origin *), cacheable (ETag), counted by the limiter above. The
// gateway (openvibe.tools) answers the same routes for every tool and reads this list for status.
// The food finder is built on the maps backend; its descriptor lives with the maps app's.
const toolRegistry = createLocalRegistry({ specs: require('../../maps/server/descriptors').SPECS.filter(s => s.id === 'food') });
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
function proxyToMaps(apiPath) {
  return async (req, res) => {
    const qs = new URL(req.url, `http://localhost`).search;
    const url = `${MAPS_API}${apiPath}${qs}`;
    try {
      const headers = req.ip ? { 'X-Forwarded-For': req.ip, 'X-Real-IP': req.ip } : {};
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (e) {
      res.status(502).json({ error: 'Backend unavailable' });
    }
  };
}

app.get('/api/food-banks', proxyToMaps('/api/food-banks'));
app.get('/api/stores', proxyToMaps('/api/stores'));
app.get('/api/foods', proxyToMaps('/api/foods'));
app.get('/api/meal-plan', proxyToMaps('/api/meal-plan'));
app.get('/api/geocode', proxyToMaps('/api/geocode'));

// ── Internal Analytics API ────────────────────────────────────
app.get('/api/internal/analytics', (req, res) => {
    if (!internalOk(req)) return res.status(404).json({ error: 'Not found' });
    try { const d = Math.min(parseInt(req.query.days) || 30, 365); const h = req.query.hours ? Math.min(parseInt(req.query.hours), 8760) : null; res.json({ ok: true, analytics: analytics.getStats({ days: d, hours: h }) }); }
    catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.get('/api/internal/analytics/bots', (req, res) => {
    if (!internalOk(req)) return res.status(404).json({ error: 'Not found' });
    try { res.json({ ok: true, bots: analytics.getBotAnalysis(Math.min(parseInt(req.query.days) || 30, 365)) }); }
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
        () => analyticsDb.close(),
        () => guard.close(),
    ],
});
