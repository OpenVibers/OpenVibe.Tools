'use strict';

// ═══════════════════════════════════════════════════════════════
// Img.OpenVibe — Main Server Entry Point
// Unified image processing hub serving all format subdomains.
// One backend, many hostnames, dynamic branding per domain.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');

const config = require('./config');
const { optionalAuth } = require('./auth');
const { resolveContext } = require('./domain-map');
const { getTool, listTools } = require('./tools');
const { uploadSingle } = require('./middleware/upload');
const { apiLimiter, processLimiter, burstLimiter } = require('./middleware/rate-limit');
const retention = require('./retention/manager');

// ── Analytics ────────────────────────────────────────────────
const Database = require('better-sqlite3');
const { AnalyticsTracker } = require('openvibe-shared/analytics');
const INTERNAL_SECRET = 'openvibe-internal-2026';
const analyticsDbPath = path.join(__dirname, '..', 'data', 'analytics.db');
fs.mkdirSync(path.dirname(analyticsDbPath), { recursive: true });
const analyticsDb = new Database(analyticsDbPath);
analyticsDb.pragma('journal_mode = WAL');
const analytics = new AnalyticsTracker(analyticsDb, 'openvibe-img');

const app = express();

// ── Security ─────────────────────────────────────────────────
app.set('trust proxy', 2); // Cloudflare → Nginx → Node
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com", "https://openvibe.network"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com", "https://fonts.gstatic.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "blob:"],
            connectSrc: ["'self'", "https://openvibe.network", "https://*.openvibe.tools"],
            workerSrc: ["'self'", "blob:"],
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
        // Allow any *.openvibe.tools subdomain + openvibe.tools itself
        if (/^https:\/\/([a-z0-9-]+\.)?openvibe\.tools$/.test(origin)) return callback(null, true);
        if (process.env.NODE_ENV === 'development' && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return callback(null, true);
        return callback(new Error('Origin not allowed by CORS'));
    },
    credentials: true,
}));

// ── Rate Limiting ────────────────────────────────────────────
app.use('/api/', apiLimiter);

// ── Analytics Middleware ─────────────────────────────────────
app.use(analytics.middleware());

// ── Auth (optional on all routes) ────────────────────────────
app.use(optionalAuth);

// ── Attach domain context to every request ───────────────────
app.use((req, _res, next) => {
    req.ctx = resolveContext(req.headers.host);
    next();
});

// ── API Routes ───────────────────────────────────────────────

// Health check
app.get('/api/health', (_req, res) => {
    const stats = retention.getStats();
    res.json({ status: 'ok', service: 'openvibe-img', version: '1.0.0', files: stats });
});

// Domain context (frontend calls this on load to get branding)
app.get('/api/context', (req, res) => {
    const ctx = req.ctx;
    const tools = listTools();
    res.json({
        toolId: ctx.toolId,
        brandName: ctx.brandName,
        defaultOp: ctx.defaultOp,
        defaultFormat: ctx.defaultFormat || null,
        faIcon: ctx.faIcon,
        seoTitle: ctx.seoTitle,
        seoDescription: ctx.seoDescription,
        tools,
        user: req.user ? { username: req.user.username, display_name: req.user.display_name } : null,
    });
});

// List tools
app.get('/api/tools', (_req, res) => {
    res.json({ tools: listTools() });
});

// ── Main Processing Endpoint ─────────────────────────────────
app.post('/api/process', burstLimiter, processLimiter, uploadSingle, async (req, res) => {
    try {
        const toolId = req.body.tool || req.ctx.defaultOp || 'convert';
        const tool = getTool(toolId);
        if (!tool) {
            return res.status(400).json({ error: `Unknown tool: ${toolId}` });
        }

        // Build options from body params
        const options = {
            format: req.body.format || req.ctx.defaultFormat || undefined,
            quality: req.body.quality || undefined,
            width: req.body.width || undefined,
            height: req.body.height || undefined,
            percentage: req.body.percentage || undefined,
            fit: req.body.fit || undefined,
            background: req.body.background || undefined,
            left: req.body.left || undefined,
            top: req.body.top || undefined,
            aspect: req.body.aspect || undefined,
            inputFormat: req.file.mimetype.split('/')[1],
        };

        // Execute the tool
        const result = await tool.handler(req.file.buffer, options);

        // Save to retention
        const saved = retention.saveOutput(
            result.buffer,
            result.ext,
            result.mime,
            !!req.user,
            req.file.originalname,
        );

        res.json({
            success: true,
            tool: toolId,
            download: saved,
            output: {
                mime: result.mime,
                ext: result.ext,
                size: result.buffer.length,
                sizeKB: Math.round(result.buffer.length / 1024 * 10) / 10,
            },
            // Include tool-specific metadata
            ...(result.savings && { savings: result.savings }),
            ...(result.dimensions && { dimensions: result.dimensions }),
            ...(result.crop && { crop: result.crop }),
        });
    } catch (err) {
        console.error('[Process] Error:', err.message);
        res.status(422).json({ error: err.message || 'Image processing failed' });
    }
});

// ── Direct Download (inline preview) ─────────────────────────
app.post('/api/process/direct', burstLimiter, processLimiter, uploadSingle, async (req, res) => {
    try {
        const toolId = req.body.tool || req.ctx.defaultOp || 'convert';
        const tool = getTool(toolId);
        if (!tool) return res.status(400).json({ error: `Unknown tool: ${toolId}` });

        const options = {
            format: req.body.format || req.ctx.defaultFormat || undefined,
            quality: req.body.quality || undefined,
            width: req.body.width || undefined,
            height: req.body.height || undefined,
            percentage: req.body.percentage || undefined,
            fit: req.body.fit || undefined,
            left: req.body.left || undefined,
            top: req.body.top || undefined,
            aspect: req.body.aspect || undefined,
            inputFormat: req.file.mimetype.split('/')[1],
        };

        const result = await tool.handler(req.file.buffer, options);
        const baseName = path.basename(req.file.originalname, path.extname(req.file.originalname));

        res.set({
            'Content-Type': result.mime,
            'Content-Disposition': `attachment; filename="${baseName}.${result.ext}"`,
            'Content-Length': result.buffer.length,
        });
        res.send(result.buffer);
    } catch (err) {
        console.error('[Process/Direct] Error:', err.message);
        res.status(422).json({ error: err.message || 'Image processing failed' });
    }
});

// ── File Download ────────────────────────────────────────────
app.get('/api/download/:id', (req, res) => {
    const entry = retention.getFile(req.params.id);
    if (!entry) {
        return res.status(404).json({ error: 'File not found or expired' });
    }
    const baseName = entry.originalName
        ? path.basename(entry.originalName, path.extname(entry.originalName))
        : 'openvibeimg-output';

    res.set({
        'Content-Type': entry.mime,
        'Content-Disposition': `attachment; filename="${baseName}.${entry.ext}"`,
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

// Public assets
app.use(express.static(path.join(__dirname, '..', 'public'), {
    index: false, // '/' goes through the per-host SEO renderer below
    setHeaders(res, filePath) {
        if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
            res.setHeader('Cache-Control', 'no-cache');
        }
    },
}));

// SPA fallback — every host gets index.html stamped with its own title, canonical, social
// tags and structured data (server/seo.js); the raw file carries only the hub's.
const { sendIndex } = require('./seo');
app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'Not found' });
    }
    return sendIndex(req, res);
});

// ── Start ────────────────────────────────────────────────────
const server = app.listen(config.port, config.host, () => {
    retention.startCleanup();
    console.log(`\n╔═══════════════════════════════════════╗`);
    console.log(`║   🖼️  Img.OpenVibe — Image Conversion Hub   ║`);
    console.log(`╠═══════════════════════════════════════╣`);
    console.log(`║  Port: ${String(config.port).padEnd(30)}║`);
    console.log(`║  Host: ${config.host.padEnd(30)}║`);
    console.log(`╚═══════════════════════════════════════╝\n`);
});

// ── Graceful Shutdown ────────────────────────────────────────
function shutdown() {
    console.log('[Img.OpenVibe] Shutting down...');
    analytics.destroy();
    analyticsDb.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
