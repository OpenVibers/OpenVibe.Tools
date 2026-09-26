'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const config = require('./config');

// ── Analytics ────────────────────────────────────────────────
const Database = require('better-sqlite3');
const { AnalyticsTracker } = require('openvibe-shared/analytics'); // ADR-021: no IP/user id, route templates, raw rows pruned after 30 days, Sec-GPC/DNT not recorded
const { internalOk } = require('../../_shared/internal-auth');
const { hostGuard } = require('../../_shared/host-role');
const { createToolsApi, exceptRegistry } = require('../../_shared/tools/http');
const { createLocalRegistry, requiresStatus } = require('../../_shared/tools/local');
const { createGuard, TRUST_PROXY } = require('../../_shared/guard');
const analyticsDbPath = path.resolve(__dirname, '..', process.env.DATA_DIR || 'data', 'analytics.db');
fs.mkdirSync(path.dirname(analyticsDbPath), { recursive: true });
const analyticsDb = new Database(analyticsDbPath);
analyticsDb.pragma('journal_mode = WAL');
const analytics = new AnalyticsTracker(analyticsDb, 'openvibe-text', { retention: { days: 30 } });

// ── Guard (apps/_shared/guard) ───────────────────────────────
// Who is asking (Network sign-in with aud openvibe.tools, else the address), the tools-api quota on
// /api/ and the abuse log (data/guard.db). TOOLS_GUARD=report (default) records what it would refuse.
const NETWORK_URL = process.env.OV_NETWORK_URL || 'https://openvibe.network';
const guard = createGuard({
    app: 'text', dataDir: path.resolve(__dirname, '..', process.env.DATA_DIR || 'data'), Database, specs: require('./descriptors').SPECS,
    issuer: NETWORK_URL, networkUrl: NETWORK_URL, networkInternalUrl: process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000',
    publicKeyFiles: [process.env.OV_NETWORK_PUBLIC_KEY].filter(Boolean),
});

const app = express();
// What this deploy runs (ADR-016); the shared navbar's release-watch polls it on every tool host.
const release = require('../../_shared/release').toolsRelease('text', require);   // its components: apps/_shared/release.js
// Metrics (GET /metrics, direct loopback callers only) and GET /api/ready from this server's real
// dependencies (roadmap Track O). First, so the HTTP metrics see every request.
const { observe, checks: ready } = require('../../_shared/observe');
const obs = observe({
    app, metrics: require('openvibe-shared/metrics'), ready: require('openvibe-shared/ready'),
    service: 'tools-text', release: release.release,
    checks: [
        ready.sqlite('analytics_db', analyticsDb, { required: false, description: 'visit analytics only; the text tools run in the browser and on this process' }),
    ],
});
guard.attachMetrics(obs.registry);
// GET /release.json (ADR-016) and POST /release-metrics, which the shared navbar's release-watch reports
// its update outcomes to (release_client_updates_total on /metrics): openvibe-shared release.mount.
release.mount(app, { registry: obs.registry });

// Legal documents live on the apex; every tool host points there instead of answering 404.
app.get(['/terms', '/privacy', '/dmca', '/tos'], (req, res) => res.redirect(301, 'https://openvibe.tools' + (req.path === '/tos' ? '/terms' : req.path)));

// ── Security ─────────────────────────────────────────────────
app.set('trust proxy', TRUST_PROXY); // one hop: the host's nginx (or the gateway) on loopback; req.ip is the only address
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "cdnjs.cloudflare.com", "cdn.jsdelivr.net", "fonts.googleapis.com", "https://openvibe.network"],
            styleSrc: ["'self'", "'unsafe-inline'", "cdnjs.cloudflare.com", "fonts.googleapis.com", "fonts.gstatic.com"],
            fontSrc: ["'self'", "fonts.gstatic.com", "cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "blob:"],
            connectSrc: ["'self'", "https://openvibe.network", "https://api.exchangerate-api.com"],
            frameSrc: ["'none'"],
            scriptSrcAttr: ["'unsafe-inline'"],
        },
    },
    crossOriginEmbedderPolicy: false,
}));
app.use(cookieParser());
app.use(express.json({ limit: '256kb' }));

// ── CORS ─────────────────────────────────────────────────────
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

// ── Who is asking, then rate limits ──────────────────────────
app.use(guard.identify);
app.use(guard.legacyLimiter(rateLimit, { windowMs: 60_000, anonymous: 200, signedIn: 400, message: 'Too many requests. Please try again later.' }));
app.use('/api/', guard.apiQuota);

// ── Tool registry (ADR-027): GET /api/v1/tools[/:id[/schema]] for this app's text and logo tools ──
// Public (Access-Control-Allow-Origin *), cacheable (ETag), counted by the limiter above. The
// gateway (openvibe.tools) answers the same routes for every tool and reads this list for status.
const toolRegistry = createLocalRegistry({ specs: require('./descriptors').SPECS });
// A signed-in person's page view of a tool goes into their tools.usage module (the launchers' recent tools).
app.use(require('../../_shared/usage').usagePages({ snapshot: toolRegistry.snapshot }));
app.use(createToolsApi({ snapshot: toolRegistry.snapshot }));

// ── Analytics Middleware ─────────────────────────────────────
app.use(analytics.middleware());

// ── Hostname → HTML file mapping (server/hosts.js) ───────────
const { HOSTNAME_MAP } = require('./hosts');

// ── Hosts ────────────────────────────────────────────────────
// Through the gateway the X-OV-* headers name the tool and its canonical host; aliases the gateway
// missed are redirected. Hosts this app does not serve go to the tools index (APIs never redirect).
app.use(hostGuard({ knows: (h) => Object.prototype.hasOwnProperty.call(HOSTNAME_MAP, h) }));

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

// ── Health check ─────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'openvibe-text', version: '1.0.0' });
});

// ── Static assets (CSS/JS) ──────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public'), {
    index: false, // Disable auto index.html — hostname routing handles /
    setHeaders(res, filePath) {
        if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
            res.setHeader('Cache-Control', 'no-cache');
        }
    },
}));

// ── Hostname-based routing ───────────────────────────────────
// Pages are stamped with a canonical + structured data on the way out (server/seo.js). Several
// hosts deliberately share one file (smallcaps/fancy, glitch/zalgo); without a canonical those
// are duplicate pages competing with each other in search results.
const textSeo = require('./seo');
const sendPage = textSeo.pageSender(HOSTNAME_MAP);

app.get('/sitemap.xml', (_req, res) => {
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(textSeo.buildSitemap(HOSTNAME_MAP));
});

app.get('/', sendPage);

// SPA fallback (all non-asset paths → root HTML for that host)
app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'Not found' });
    }
    return sendPage(req, res);
});

// ── Start ────────────────────────────────────────────────────
const server = app.listen(config.port, config.host, () => {
    const toolCount = new Set(Object.values(HOSTNAME_MAP)).size;
    const domainCount = Object.keys(HOSTNAME_MAP).length;
    console.log(`\n╔═══════════════════════════════════════╗`);
    console.log(`║  ✏️  Text.OpenVibe + Logo.OpenVibe                ║`);
    console.log(`╠═══════════════════════════════════════╣`);
    console.log(`║  Port:    ${String(config.port).padEnd(28)}║`);
    console.log(`║  Tools:   ${String(toolCount).padEnd(28)}║`);
    console.log(`║  Domains: ${String(domainCount).padEnd(28)}║`);
    console.log(`╚═══════════════════════════════════════╝\n`);
});

// ── Graceful stop (roadmap WS-P lifecycle; apps/_shared/graceful.js) ──
// SIGTERM: the server stops taking connections and lets requests in flight finish (4 s at most;
// event streams are closed and reconnect); then recent-tool writes are flushed (1 s at most), the
// analytics and the guard close, and the process exits 0, within the manifest's 5 s.
require('../../_shared/graceful').gracefulStop({
    name: 'Text.OpenVibe', server,
    close: [
        () => require('../../_shared/usage').stopRecorder(800),
        () => analytics.destroy(),
        () => analyticsDb.close(),
        () => guard.close(),
    ],
});
