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
const auth = require('./auth');
const { optionalAuth } = auth;
const { resolveContext, DOMAIN_MAP } = require('./domain-map');
const { getTool, listTools } = require('./tools');
const { uploadSingle } = require('./middleware/upload');
const { apiLimiter, processLimiter, burstLimiter } = require('./middleware/rate-limit');
const retention = require('./retention/manager');
const { buildOptions, describe, processBuffer, defineJobs } = require('./process');
const { hostGuard, ownHost } = require('../../_shared/host-role');
const jobsRuntime = require('../../_shared/jobs');
const contracts = require('openvibe-contracts');

// ── Analytics ────────────────────────────────────────────────
const Database = require('better-sqlite3');
const { AnalyticsTracker } = require('../../_shared/analytics'); // ADR-021: no IP/user id, route templates, raw rows pruned after 30 days
const { internalOk } = require('../../_shared/internal-auth');
const analyticsDbPath = path.resolve(__dirname, '..', config.dataDir, 'analytics.db');
fs.mkdirSync(path.dirname(analyticsDbPath), { recursive: true });
const analyticsDb = new Database(analyticsDbPath);
analyticsDb.pragma('journal_mode = WAL');
const analytics = new AnalyticsTracker(analyticsDb, 'openvibe-img', { retention: { days: 30 } });

const app = express();
// What this deploy runs (ADR-016); the shared navbar's release-watch polls it on every tool host.
const release = require('openvibe-shared/release').createRelease({ service: 'tools', root: require('path').join(__dirname, '..', '..', '..') });
// Metrics (GET /metrics, direct loopback callers only) and GET /api/ready from this server's real
// dependencies (roadmap Track O). First, so the HTTP metrics see every request.
const { observe, checks: ready } = require('../../_shared/observe');
observe({
    app, metrics: require('openvibe-shared/metrics'), ready: require('openvibe-shared/ready'),
    service: 'tools-img', release: release.release,
    checks: [
        ready.sqlite('jobs_db', () => jobs.db, { sql: 'SELECT COUNT(*) AS n FROM tool_jobs', description: 'job store (jobs.db)' }),
        ready.jobRuntime('job_runtime', () => jobs),
        ready.writableDir('data_dir', path.resolve(__dirname, '..', config.dataDir), { description: 'jobs.db and job inputs/results' }),
        ready.writableDir('uploads_dir', path.resolve(config.uploadsDir), { description: 'synchronous uploads' }),
        ready.writableDir('output_dir', path.resolve(config.outputDir), { description: 'synchronous results' }),
        ready.sqlite('analytics_db', analyticsDb, { required: false, description: 'visit analytics only; tools work without it' }),
        ready.networkKey('network_key', auth.getPublicKey, { description: 'verifies signed-in users and service tokens on the job API; anonymous use works without it' }),
        ...jobsRuntime.readyChecks(() => jobs),
    ],
    jobs: () => jobs,
});
app.get('/release.json', release.handler);

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
            imgSrc: ["'self'", "data:", "blob:", jobsRuntime.mediaOrigin()],   // job result previews are 302s to Media
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
    res.json({ status: 'ok', service: 'openvibe-img', version: '1.0.0', files: stats, jobs: jobs.stats() });
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

        // Execute the tool (the same code the img.process job runs)
        const result = await processBuffer(req.file.buffer, toolId, buildOptions(req.body, req.ctx, req.file.mimetype));

        // Save to retention
        const saved = retention.saveOutput(
            result.buffer,
            result.ext,
            result.mime,
            !!req.user,
            req.file.originalname,
        );

        res.json({ success: true, download: saved, ...describe(toolId, result) });
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

        const result = await processBuffer(req.file.buffer, toolId, buildOptions(req.body, req.ctx, req.file.mimetype));
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

// ── Jobs (/api/v1/jobs) ──────────────────────────────────────
// The same operation as /api/process, asynchronous and durable: accepted into data/jobs.db,
// followed over SSE, reattachable by id after a reload or a restart (apps/_shared/jobs).
const jobs = jobsRuntime.setupJobs({
    app, service: 'img', dataDir: path.resolve(__dirname, '..', config.dataDir), Database, contracts,
    getPublicKey: auth.getPublicKey, issuer: auth.ISSUER,
    define: defineJobs,
    receive: uploadSingle,
    limiters: [burstLimiter, processLimiter],
    defaults(req, input) {
        const out = { ...input };
        if (!out.tool) out.tool = req.ctx.defaultOp || 'convert';
        if (!out.format && req.ctx.defaultFormat) out.format = req.ctx.defaultFormat;
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
    jobs.close();   // running jobs stay 'running' in data/jobs.db; the next boot re-queues them
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
