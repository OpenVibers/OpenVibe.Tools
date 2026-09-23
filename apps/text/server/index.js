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
const analyticsDbPath = path.resolve(__dirname, '..', process.env.DATA_DIR || 'data', 'analytics.db');
fs.mkdirSync(path.dirname(analyticsDbPath), { recursive: true });
const analyticsDb = new Database(analyticsDbPath);
analyticsDb.pragma('journal_mode = WAL');
const analytics = new AnalyticsTracker(analyticsDb, 'openvibe-text', { retention: { days: 30 } });

const app = express();
// What this deploy runs (ADR-016); the shared navbar's release-watch polls it on every tool host.
const release = require('openvibe-shared/release').createRelease({ service: 'tools', root: require('path').join(__dirname, '..', '..', '..') });
// Metrics (GET /metrics, direct loopback callers only) and GET /api/ready from this server's real
// dependencies (roadmap Track O). First, so the HTTP metrics see every request.
const { observe, checks: ready } = require('../../_shared/observe');
observe({
    app, metrics: require('openvibe-shared/metrics'), ready: require('openvibe-shared/ready'),
    service: 'tools-text', release: release.release,
    checks: [
        ready.sqlite('analytics_db', analyticsDb, { required: false, description: 'visit analytics only; the text tools run in the browser and on this process' }),
    ],
});
app.get('/release.json', release.handler);

// Legal documents live on the apex; every tool host points there instead of answering 404.
app.get(['/terms', '/privacy', '/dmca', '/tos'], (req, res) => res.redirect(301, 'https://openvibe.tools' + (req.path === '/tos' ? '/terms' : req.path)));

// ── Security ─────────────────────────────────────────────────
app.set('trust proxy', 2);
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

// ── Rate Limiting ────────────────────────────────────────────
app.use(rateLimit({ windowMs: 60_000, max: 200 }));

// ── Analytics Middleware ─────────────────────────────────────
app.use(analytics.middleware());

// ── Hostname → HTML file mapping ─────────────────────────────
// Each subdomain gets its own static HTML page for SEO + focused UX.
// Every host here must also be in deploy/nginx/text.openvibe.tools.conf, and must not be
// claimed by another app's vhost or by the gateway's net/dev catalogs: json., markdown.,
// escape., diff., compare. and slug. are ours (the gateway's generic versions moved to
// jsonfmt., md., entities., codediff. and slugify.).
const HOSTNAME_MAP = {
    // Text hubs
    'text.openvibe.tools':       'index.html',
    'type.openvibe.tools':       'index.html',
    'fonts.openvibe.tools':      'index.html',
    // Fancy text generators
    'fancy.openvibe.tools':      'fancy.html',
    'zalgo.openvibe.tools':      'zalgo.html',
    'ascii.openvibe.tools':      'ascii.html',
    'symbols.openvibe.tools':    'symbols.html',
    'unicode.openvibe.tools':    'unicode.html',
    'bubble.openvibe.tools':     'bubble.html',
    'glitch.openvibe.tools':     'zalgo.html',
    'smallcaps.openvibe.tools':  'fancy.html',
    'cursive.openvibe.tools':    'fancy.html',
    'gothic.openvibe.tools':     'fancy.html',
    'wide.openvibe.tools':       'fancy.html',
    'monospaced.openvibe.tools': 'fancy.html',
    'braille.openvibe.tools':    'braille.html',
    'morse.openvibe.tools':      'morse.html',
    'binary.openvibe.tools':     'binary.html',
    // Quick-action text tools
    'case.openvibe.tools':       'case.html',
    'caps.openvibe.tools':       'case.html',
    'titlecase.openvibe.tools':  'case.html',
    // reverse.openvibe.tools is the Audio app's (reverse an audio file); the text flipper
    // lives on reversetext. + mirror. instead. Keep this in step with deploy/nginx.
    'reversetext.openvibe.tools':'reverse.html',
    'mirror.openvibe.tools':     'reverse.html',
    'clean.openvibe.tools':      'clean.html',
    'strip.openvibe.tools':      'clean.html',
    'count.openvibe.tools':      'count.html',
    'lines.openvibe.tools':      'count.html',
    'sort.openvibe.tools':       'sort.html',
    'dedupe.openvibe.tools':     'sort.html',
    'slug.openvibe.tools':       'slug.html',
    'compare.openvibe.tools':    'compare.html',
    'diff.openvibe.tools':       'compare.html',
    'markdown.openvibe.tools':   'markdown.html',
    'json.openvibe.tools':       'json.html',
    'escape.openvibe.tools':     'escape.html',
    // Identity / social
    'bio.openvibe.tools':        'bio.html',
    'nickname.openvibe.tools':   'nickname.html',
    'username.openvibe.tools':   'nickname.html',
    'gamertag.openvibe.tools':   'nickname.html',
    'kaomoji.openvibe.tools':    'kaomoji.html',
    'emojis.openvibe.tools':     'kaomoji.html',
    'copypaste.openvibe.tools':  'symbols.html',
    // ASCII art / banners
    'banner.openvibe.tools':     'ascii.html',
    'textart.openvibe.tools':    'ascii.html',
    'figlet.openvibe.tools':     'ascii.html',
    // Logo / title / design
    'logo.openvibe.tools':       'logo-hub.html',
    'title.openvibe.tools':      'title.html',
    'wordmark.openvibe.tools':   'wordmark.html',
    'textlogo.openvibe.tools':   'wordmark.html',
    'transparent.openvibe.tools':'transparent.html',
    'badge.openvibe.tools':      'badge.html',
    'sticker.openvibe.tools':    'badge.html',
    'thumbnail.openvibe.tools':  'thumbnail.html',
    'cover.openvibe.tools':      'thumbnail.html',
    'channelart.openvibe.tools': 'thumbnail.html',
    'watermark.openvibe.tools':  'watermark.html',
    'neon.openvibe.tools':       'wordmark.html',
    'overlay.openvibe.tools':    'watermark.html',
    'lowerthird.openvibe.tools': 'watermark.html',
    // Community / Mexican tools
    'ice.openvibe.tools':        'ice.html',
    'peso.openvibe.tools':       'peso.html',
    'currency.openvibe.tools':   'peso.html',
    'mxn.openvibe.tools':        'peso.html',
    'spanish.openvibe.tools':    'spanish.html',
    'espanol.openvibe.tools':    'spanish.html',
    'slang.openvibe.tools':      'slang.html',
};

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

// ── Graceful Shutdown ────────────────────────────────────────
function shutdown() {
    console.log('[Text.OpenVibe] Shutting down...');
    analytics.destroy();
    analyticsDb.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
