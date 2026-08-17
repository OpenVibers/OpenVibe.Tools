'use strict';

// ═══════════════════════════════════════════════════════════════
// YT.OpenVibe — Main Server Entry Point
// YouTube downloader with yt-dlp backend.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const config = require('./config');
const { optionalAuth } = require('./auth');
const downloader = require('./downloader');

// ── Analytics ────────────────────────────────────────────────
const Database = require('better-sqlite3');
const { AnalyticsTracker } = require('openvibe-shared/analytics');
const INTERNAL_SECRET = 'openvibe-internal-2026';
const analyticsDbPath = path.join(__dirname, '..', 'data', 'analytics.db');
fs.mkdirSync(path.dirname(analyticsDbPath), { recursive: true });
const analyticsDb = new Database(analyticsDbPath);
analyticsDb.pragma('journal_mode = WAL');
const analytics = new AnalyticsTracker(analyticsDb, 'openvibe-yt');

const app = express();

// ── Security ─────────────────────────────────────────────────
app.set('trust proxy', 2);
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com", "https://openvibe.network"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com", "https://fonts.gstatic.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "https://i.ytimg.com", "https://img.youtube.com", "https://*.ggpht.com"],
            connectSrc: ["'self'", "https://openvibe.network", "https://*.openvibe.tools"],
            scriptSrcAttr: ["'unsafe-inline'"],
        },
    },
    crossOriginEmbedderPolicy: false,
}));
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));

// ── CORS ─────────────────────────────────────────────────────
app.use(cors({
    origin(origin, callback) {
        if (!origin) return callback(null, true);
        if (/^https:\/\/([a-z0-9-]+\.)?openvibe\.tools$/.test(origin)) return callback(null, true);
        if (process.env.NODE_ENV === 'development' && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return callback(null, true);
        return callback(new Error('Origin not allowed by CORS'));
    },
    credentials: true,
}));

// ── Rate Limiting ────────────────────────────────────────────
app.use('/api/', rateLimit({ windowMs: 60_000, max: 60 }));

// ── Analytics Middleware ─────────────────────────────────────
app.use(analytics.middleware());

const downloadLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: (req) => req.user ? config.rateLimit.authedPerHour : config.rateLimit.anonPerHour,
    keyGenerator: (req) => req.user?.sub || req.user?.id || req.ip,
    message: { error: 'Download limit reached. Sign in for more downloads or wait an hour.' },
});

// ── Auth ─────────────────────────────────────────────────────
app.use(optionalAuth);

// ── API Routes ───────────────────────────────────────────────

// Health check
app.get('/api/health', (_req, res) => {
    const stats = downloader.getStats();
    res.json({ status: 'ok', service: 'openvibe-yt', version: '1.0.0', stats });
});

// Get video info
app.post('/api/info', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });
    if (!downloader.isValidUrl(url)) return res.status(400).json({ error: 'Only YouTube URLs are supported (youtube.com, youtu.be)' });

    try {
        const info = await downloader.getInfo(url);
        res.json({ success: true, video: info });
    } catch (err) {
        console.error('[Info] Error:', err.message);
        res.status(422).json({ error: err.message });
    }
});

// Start download
app.post('/api/download', downloadLimiter, async (req, res) => {
    const { url, quality } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });
    if (!downloader.isValidUrl(url)) return res.status(400).json({ error: 'Only YouTube URLs are supported' });

    try {
        const { id } = await downloader.startDownload(url, quality || 'best');
        res.json({ success: true, id, statusUrl: `/api/status/${id}` });
    } catch (err) {
        console.error('[Download] Error:', err.message);
        res.status(422).json({ error: err.message });
    }
});

// Download status (poll for progress)
app.get('/api/status/:id', (req, res) => {
    const status = downloader.getStatus(req.params.id);
    if (!status) return res.status(404).json({ error: 'Download not found' });
    res.json(status);
});

// Download status via SSE (real-time progress)
app.get('/api/status/:id/stream', (req, res) => {
    const id = req.params.id;

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    const interval = setInterval(() => {
        const status = downloader.getStatus(id);
        if (!status) {
            res.write(`data: ${JSON.stringify({ error: 'Not found' })}\n\n`);
            clearInterval(interval);
            res.end();
            return;
        }

        res.write(`data: ${JSON.stringify(status)}\n\n`);

        if (status.status === 'done' || status.status === 'error') {
            clearInterval(interval);
            setTimeout(() => res.end(), 500);
        }
    }, 1000);

    req.on('close', () => clearInterval(interval));
});

// Serve downloaded file
app.get('/api/download/:id', (req, res) => {
    const entry = downloader.getFile(req.params.id);
    if (!entry) return res.status(404).json({ error: 'File not found or expired' });

    res.set({
        'Content-Type': entry.mime,
        'Content-Disposition': `attachment; filename="openvibeyt-download.${entry.ext}"`,
        'Content-Length': entry.size,
    });
    res.sendFile(entry.filePath);
});

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

// ── Static Files ─────────────────────────────────────────────
// (shared client-side libs are loaded absolutely from https://openvibe.network/shared/)
app.use(express.static(path.join(__dirname, '..', 'public'), {
    setHeaders(res, filePath) {
        if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
            res.setHeader('Cache-Control', 'no-cache');
        }
    },
}));

// SPA fallback
app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ── Start ────────────────────────────────────────────────────
const server = app.listen(config.port, config.host, () => {
    downloader.startCleanup();
    console.log(`\n╔═══════════════════════════════════════╗`);
    console.log(`║   📺 YT.OpenVibe — YouTube Downloader       ║`);
    console.log(`╠═══════════════════════════════════════╣`);
    console.log(`║  Port: ${String(config.port).padEnd(30)}║`);
    console.log(`║  Host: ${config.host.padEnd(30)}║`);
    console.log(`╚═══════════════════════════════════════╝\n`);
});

// ── Graceful Shutdown ────────────────────────────────────────
function shutdown() {
    console.log('[YT.OpenVibe] Shutting down...');
    analytics.destroy();
    analyticsDb.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
