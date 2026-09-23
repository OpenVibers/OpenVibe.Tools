'use strict';

// ═══════════════════════════════════════════════════════════════
// Audio.OpenVibe — Main Server Entry Point
// Unified audio processing hub serving all format subdomains.
// One backend, many hostnames, dynamic branding per domain.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');

const config = require('./config');
const auth = require('./auth');
const { optionalAuth } = auth;
const { resolveContext, DOMAIN_MAP } = require('./domain-map');
const { getTool, listTools } = require('./tools');
const { readMetadata } = require('./tools/metadata');
const { uploadSingle, uploadMultiple } = require('./middleware/upload');
const { apiLimiter, processLimiter, burstLimiter } = require('./middleware/rate-limit');
const retention = require('./retention/manager');
const { probe, getDuration, cleanTmp } = require('./tools/ffmpeg-helper');
const { buildOptions, describe, defineJobs } = require('./process');
const { hostGuard, ownHost } = require('../../_shared/host-role');
const jobsRuntime = require('../../_shared/jobs');
const contracts = require('openvibe-contracts');

// ── Analytics ────────────────────────────────────────────────
const Database = require('better-sqlite3');
const { AnalyticsTracker } = require('openvibe-shared/analytics');
const { internalOk } = require('../../_shared/internal-auth');
const analyticsDbPath = path.resolve(__dirname, '..', config.dataDir, 'analytics.db');
fs.mkdirSync(path.dirname(analyticsDbPath), { recursive: true });
const analyticsDb = new Database(analyticsDbPath);
analyticsDb.pragma('journal_mode = WAL');
const analytics = new AnalyticsTracker(analyticsDb, 'openvibe-audio');

const app = express();
// What this deploy runs (ADR-016); the shared navbar's release-watch polls it on every tool host.
{ const release = require('openvibe-shared/release').createRelease({ service: 'tools', root: require('path').join(__dirname, '..', '..', '..') }); app.get('/release.json', release.handler); }

// Legal documents live on the apex; every tool host points there instead of answering 404.
app.get(['/terms', '/privacy', '/dmca', '/tos'], (req, res) => res.redirect(301, 'https://openvibe.tools' + (req.path === '/tos' ? '/terms' : req.path)));

// ── Security ─────────────────────────────────────────────────
app.set('trust proxy', 2); // Cloudflare → Nginx → Node
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com", "https://openvibe.network"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com", "https://fonts.gstatic.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "blob:", jobsRuntime.mediaOrigin()],     // job result previews are 302s to Media
            mediaSrc: ["'self'", "blob:", jobsRuntime.mediaOrigin()],
            connectSrc: ["'self'", "https://openvibe.network", "https://*.openvibe.tools"],
            workerSrc: ["'self'", "blob:"],
            scriptSrcAttr: ["'unsafe-inline'"],
        },
    },
    crossOriginEmbedderPolicy: false,
}));
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(contracts.http.middleware());   // traceparent + X-OpenVibe-Request-Id on every response

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
app.use('/api/', apiLimiter);

// ── Analytics Middleware ─────────────────────────────────────
app.use(analytics.middleware());

// ── Auth (optional on all routes) ────────────────────────────
app.use(optionalAuth);

// ── Hosts ────────────────────────────────────────────────────
// Through the gateway the X-OV-* headers name the tool and its canonical host (a custom domain
// included); aliases the gateway missed are redirected. Hosts this app does not serve go to the
// tools index. API paths are never redirected.
const knowsHost = (h) => !!DOMAIN_MAP[h];
app.use(hostGuard({ knows: knowsHost }));

// ── Attach domain context to every request ───────────────────
app.use((req, _res, next) => {
    req.ctx = resolveContext(ownHost(req, knowsHost));
    next();
});

// ── API Routes ───────────────────────────────────────────────

// Health check
app.get('/api/health', (_req, res) => {
    const stats = retention.getStats();
    res.json({ status: 'ok', service: 'openvibe-audio', version: '1.0.0', files: stats, jobs: jobs.stats() });
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

// ── Probe / Metadata Endpoint ────────────────────────────────
app.post('/api/probe', burstLimiter, processLimiter, uploadSingle, async (req, res) => {
    try {
        const info = await probe(req.file.path);
        const meta = await readMetadata(req.file.path);
        cleanTmp(req.file.path);
        res.json({ success: true, ...meta, probe: info.format });
    } catch (err) {
        cleanTmp(req.file?.path);
        res.status(422).json({ error: err.message || 'Failed to read audio file' });
    }
});

// ── Main Processing Endpoint ─────────────────────────────────
app.post('/api/process', burstLimiter, processLimiter, uploadSingle, async (req, res) => {
    try {
        const toolId = req.body.tool || req.ctx.defaultOp || 'convert';
        const tool = getTool(toolId);
        if (!tool) {
            cleanTmp(req.file.path);
            return res.status(400).json({ error: `Unknown tool: ${toolId}` });
        }

        // Execute the tool (same options and code path as the audio.process job)
        const result = await tool.handler(req.file.path, buildOptions(req.body, toolId, req.ctx));

        // Clean up the uploaded input file
        cleanTmp(req.file.path);

        // Save to retention
        const saved = retention.saveOutputFromFile(
            result.outputPath,
            result.ext,
            result.mime,
            !!req.user,
            req.file.originalname,
        );

        // Probe input for size comparison
        const inputSize = req.file.size;

        res.json({ success: true, download: saved, ...describe(toolId, result, saved.size, inputSize) });
    } catch (err) {
        cleanTmp(req.file?.path);
        console.error('[Process] Error:', err.message);
        res.status(422).json({ error: err.message || 'Audio processing failed' });
    }
});

// ── Jobs (/api/v1/jobs) ──────────────────────────────────────
// The same operation as /api/process, asynchronous and durable: accepted into data/jobs.db,
// followed over SSE (ffmpeg's own progress), cancellable (ffmpeg is killed), reattachable by id
// after a reload or a restart (apps/_shared/jobs).
const jobs = jobsRuntime.setupJobs({
    app, service: 'audio', dataDir: path.resolve(__dirname, '..', config.dataDir), Database, contracts,
    getPublicKey: auth.getPublicKey, issuer: auth.ISSUER,
    define: defineJobs,
    receive: uploadSingle,
    limiters: [burstLimiter, processLimiter],
    defaults(req, input) {
        const out = { ...input };
        if (!out.tool) out.tool = req.ctx.defaultOp || 'convert';
        if (req.ctx.defaultFormat && out.tool === 'convert') out.format = req.ctx.defaultFormat;
        return out;
    },
});

// ── File Download ────────────────────────────────────────────
app.get('/api/download/:id', (req, res) => {
    const entry = retention.getFile(req.params.id);
    if (!entry) {
        return res.status(404).json({ error: 'File not found or expired' });
    }
    const baseName = entry.originalName
        ? path.basename(entry.originalName, path.extname(entry.originalName))
        : 'openvibeaudio-output';

    res.set({
        'Content-Type': entry.mime,
        'Content-Disposition': `attachment; filename="${baseName}.${entry.ext}"`,
        'Content-Length': entry.size,
    });
    res.sendFile(entry.filePath);
});

// ── Preview / Stream ─────────────────────────────────────────
app.get('/api/preview/:id', (req, res) => {
    const entry = retention.getFile(req.params.id);
    if (!entry) {
        return res.status(404).json({ error: 'File not found or expired' });
    }

    res.set({
        'Content-Type': entry.mime,
        'Content-Length': entry.size,
        'Accept-Ranges': 'bytes',
    });

    // Support range requests for audio seeking
    const range = req.headers.range;
    if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : entry.size - 1;
        const chunkSize = end - start + 1;

        res.status(206).set({
            'Content-Range': `bytes ${start}-${end}/${entry.size}`,
            'Content-Length': chunkSize,
        });
        fs.createReadStream(entry.filePath, { start, end }).pipe(res);
    } else {
        fs.createReadStream(entry.filePath).pipe(res);
    }
});

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
    console.log(`║   🎵  Audio.OpenVibe — Audio Processing Hub ║`);
    console.log(`╠═══════════════════════════════════════╣`);
    console.log(`║  Port: ${String(config.port).padEnd(30)}║`);
    console.log(`║  Host: ${config.host.padEnd(30)}║`);
    console.log(`╚═══════════════════════════════════════╝\n`);
});

// ── Graceful Shutdown ────────────────────────────────────────
function shutdown() {
    console.log('[Audio.OpenVibe] Shutting down...');
    analytics.destroy();
    analyticsDb.close();
    jobs.close();   // running jobs stay 'running' in data/jobs.db; the next boot re-queues them
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
