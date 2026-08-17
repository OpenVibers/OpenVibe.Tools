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
const { AnalyticsTracker } = require('openvibe-shared/analytics');
const INTERNAL_SECRET = 'openvibe-internal-2026';
const analyticsDbPath = path.join(__dirname, '..', 'data', 'analytics.db');
fs.mkdirSync(path.dirname(analyticsDbPath), { recursive: true });
const analyticsDb = new Database(analyticsDbPath);
analyticsDb.pragma('journal_mode = WAL');
const analytics = new AnalyticsTracker(analyticsDb, 'openvibe-food');

const PORT = parseInt(process.env.PORT) || 4011;
const MAPS_API = process.env.MAPS_API || 'http://127.0.0.1:4010';

const app = express();

app.set('trust proxy', 2); // Cloudflare → Nginx → Node
app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (/^https:\/\/[a-z0-9-]+\.openvibe\.tools$/.test(origin)) return callback(null, true);
    if (/^https:\/\/(openvibelive\.com|openvibe\.quest)$/.test(origin)) return callback(null, true);
    if (process.env.NODE_ENV === 'development' && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return callback(null, true);
    return callback(new Error('Origin not allowed'));
  },
  credentials: true,
}));
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'https://openvibe.network'],
      styleSrc: ["'self'", "'unsafe-inline'", 'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'],
      fontSrc: ["'self'", 'fonts.gstatic.com', 'cdnjs.cloudflare.com'],
      imgSrc: ["'self'", 'data:', 'image.tmdb.org', '*.tile.openstreetmap.org', '*.basemaps.cartocdn.com', 'server.arcgisonline.com'],
      connectSrc: ["'self'", 'nominatim.openstreetmap.org', 'https://openvibe.network'],
      scriptSrcAttr: ["'unsafe-inline'"],
    },
  },
}));
app.use(rateLimit({ windowMs: 60000, max: 60 }));
app.use(cookieParser());

// ── Analytics Middleware ─────────────────────────────────────
app.use(analytics.middleware());

// Static files
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1d' }));

// Proxy food-related API calls to openvibe-maps backend
function proxyToMaps(apiPath) {
  return async (req, res) => {
    const qs = new URL(req.url, `http://localhost`).search;
    const url = `${MAPS_API}${apiPath}${qs}`;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
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
    if (req.headers['x-internal-secret'] !== INTERNAL_SECRET) return res.status(403).json({ error: 'Forbidden' });
    try { const d = Math.min(parseInt(req.query.days) || 30, 365); const h = req.query.hours ? Math.min(parseInt(req.query.hours), 8760) : null; res.json({ ok: true, analytics: analytics.getStats({ days: d, hours: h }) }); }
    catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.get('/api/internal/analytics/bots', (req, res) => {
    if (req.headers['x-internal-secret'] !== INTERNAL_SECRET) return res.status(403).json({ error: 'Forbidden' });
    try { res.json({ ok: true, bots: analytics.getBotAnalysis(Math.min(parseInt(req.query.days) || 30, 365)) }); }
    catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// SPA fallback
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`[Food.OpenVibe] 🍽️  food.openvibe.tools listening on 127.0.0.1:${PORT}`);
});

// ── Graceful Shutdown ────────────────────────────────────────
function shutdown() {
    console.log('[Food.OpenVibe] Shutting down...');
    analytics.destroy();
    analyticsDb.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
