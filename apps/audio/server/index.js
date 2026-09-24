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

const rateLimit = require('express-rate-limit');
const config = require('./config');
const { resolveContext, DOMAIN_MAP } = require('./domain-map');
const { getTool, listTools } = require('./tools');
const { readMetadata } = require('./tools/metadata');
const { uploadSingle, uploadMultiple, uploadAny } = require('./middleware/upload');
const retention = require('./retention/manager');
const { probe, getDuration, cleanTmp } = require('./tools/ffmpeg-helper');
const { buildOptions, describe, defineJobs, runSync, jobContext, limitsFor } = require('./process');
const { hostGuard, ownHost } = require('../../_shared/host-role');
const { createToolsApi, exceptRegistry } = require('../../_shared/tools/http');
const { satelliteRunApi, ajvFrom } = require('../../_shared/tools/run');
const { satellitePorts } = require('../../_shared/tools/satellites');
const { deprecated, runPath } = require('../../_shared/tools/deprecation');
const { createLocalRegistry, requiresStatus } = require('../../_shared/tools/local');
const jobsRuntime = require('../../_shared/jobs');
const { createGuard, TRUST_PROXY } = require('../../_shared/guard');
const contracts = require('openvibe-contracts');
const sdk = require('openvibe-sdk');

// ── Analytics ────────────────────────────────────────────────
const Database = require('better-sqlite3');
const { AnalyticsTracker } = require('openvibe-shared/analytics'); // ADR-021: no IP/user id, route templates, raw rows pruned after 30 days, Sec-GPC/DNT not recorded
const { internalOk } = require('../../_shared/internal-auth');
const analyticsDbPath = path.resolve(__dirname, '..', config.dataDir, 'analytics.db');
fs.mkdirSync(path.dirname(analyticsDbPath), { recursive: true });
const analyticsDb = new Database(analyticsDbPath);
analyticsDb.pragma('journal_mode = WAL');
const analytics = new AnalyticsTracker(analyticsDb, 'openvibe-audio', { retention: { days: 30 } });

// ── Guard (apps/_shared/guard) ───────────────────────────────
// Who is asking (Network sign-in with aud openvibe.tools, service tokens, the browser session, else
// the address), tiered quotas by each tool's descriptor, upload sniffing, the sync semaphore and the
// abuse log (data/guard.db). TOOLS_GUARD=report (default) records what it would refuse. Every audio
// tool needs a browser session, a sign-in or a token (descriptor auth.anonymous false).
const SPECS = require('./descriptors').SPECS;
const guard = createGuard({
    app: 'audio', dataDir: path.resolve(__dirname, '..', config.dataDir), Database, contracts, specs: SPECS,
    issuer: config.networkUrl, networkUrl: config.networkUrl, networkInternalUrl: config.networkInternalUrl, publicKeyFiles: config.publicKeyPaths,
});
const { apiLimiter, processLimiter, burstLimiter } = guard.legacyLimiters(rateLimit);
/** The tool a request is for before its body is read: the host's own, else the operation it defaults to. */
const hostTool = (req) => (guard.tool(req.ctx.toolId) ? req.ctx.toolId : (guard.toolForJob('audio.process', req.ctx.defaultOp || 'convert', null) || { id: null }).id);
/** The tool a parsed request runs: its `tool` (operation) on this host. */
const toolOf = (req) => { const d = guard.toolForJob('audio.process', String((req.body && req.body.tool) || req.ctx.defaultOp || 'convert'), req.ctx.toolId); return d ? d.id : hostTool(req); };

const app = express();
// What this deploy runs (ADR-016); the shared navbar's release-watch polls it on every tool host.
const release = require('../../_shared/release').toolsRelease('audio', require);   // its components: apps/_shared/release.js
// Metrics (GET /metrics, direct loopback callers only) and GET /api/ready from this server's real
// dependencies (roadmap Track O). First, so the HTTP metrics see every request.
const { observe, checks: ready, which } = require('../../_shared/observe');
const obs = observe({
    app, metrics: require('openvibe-shared/metrics'), ready: require('openvibe-shared/ready'),
    service: 'tools-audio', release: release.release,
    checks: [
        ready.sqlite('jobs_db', () => jobs.db, { sql: 'SELECT COUNT(*) AS n FROM tool_jobs', description: 'job store (jobs.db)' }),
        ready.jobRuntime('job_runtime', () => jobs),
        ready.writableDir('data_dir', path.resolve(__dirname, '..', config.dataDir), { description: 'jobs.db and job inputs/results' }),
        ready.writableDir('uploads_dir', path.resolve(config.uploadsDir), { description: 'synchronous uploads' }),
        ready.writableDir('output_dir', path.resolve(config.outputDir), { description: 'synchronous results' }),
        ready.sqlite('analytics_db', analyticsDb, { required: false, description: 'visit analytics only; tools work without it' }),
        ready.networkKey('network_key', guard.keys.get, { description: 'verifies signed-in users and service tokens on the job API; anonymous use works without it' }),
        ...jobsRuntime.readyChecks(() => jobs),
        ready.binary('ffmpeg', process.env.FFMPEG_PATH || 'ffmpeg', { description: 'every audio tool runs ffmpeg; without it jobs and conversions fail' }),
    ],
    jobs: () => jobs,
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
app.use(exceptRegistry(cors({
    origin(origin, callback) {
        if (!origin) return callback(null, true);
        if (/^https:\/\/([a-z0-9-]+\.)?openvibe\.tools$/.test(origin)) return callback(null, true);
        if (process.env.NODE_ENV === 'development' && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return callback(null, true);
        return callback(new Error('Origin not allowed by CORS'));
    },
    credentials: true,
}), { isFirstParty: (origin) => /^https:\/\/([a-z0-9-]+\.)?openvibe\.tools$/.test(origin) || (process.env.NODE_ENV === 'development' && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) }));

// ── Who is asking, then rate limits (sign-in first, so a signed-in tier applies) ──
app.use(guard.identify);
app.use('/api/', apiLimiter, guard.apiQuota);

// ── Tool registry (ADR-027): GET /api/v1/tools[/:id[/schema]] for this app's audio tools ──
// Public (Access-Control-Allow-Origin *), cacheable (ETag), counted by the limiter above. The
// gateway (openvibe.tools) answers the same routes for every tool and reads this list for status.
const toolRegistry = createLocalRegistry({ specs: require('./descriptors').SPECS, statusOf: requiresStatus((p) => (p === 'ffmpeg' ? !!which(process.env.FFMPEG_PATH || 'ffmpeg') : true)) });
app.use(createToolsApi({ snapshot: toolRegistry.snapshot }));

// ── Analytics Middleware ─────────────────────────────────────
app.use(analytics.middleware());

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

// Domain context (frontend calls this on load to get branding). It also starts this browser's session
// (ov_tools_jobs): audio tools need one (or a sign-in, or a token) before the first upload.
app.get('/api/context', (req, res) => {
    guard.ensureSession(req, res);
    res.set('Cache-Control', 'private, no-store');
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
app.post('/api/probe', guard.originCheck(), burstLimiter, processLimiter, guard.toolQuota('metadata'), uploadSingle, guard.admitUpload(() => 'metadata'), async (req, res) => {
    try {
        // Hardened like every run: local files only, audio demuxers only.
        const { info, meta } = await jobContext.run(limitsFor('metadata'), async () => ({ info: await probe(req.file.path), meta: await readMetadata(req.file.path) }));
        cleanTmp(req.file.path);
        res.json({ success: true, ...meta, probe: info.format });
    } catch (err) {
        cleanTmp(req.file?.path);
        res.status(422).json({ error: err.message || 'Failed to read audio file' });
    }
});

// ── Main Processing Endpoint ─────────────────────────────────
app.post('/api/process', deprecated((req) => runPath(hostTool(req))), guard.originCheck(), burstLimiter, processLimiter, guard.toolQuota(hostTool), uploadSingle, guard.admitUpload(toolOf), guard.heavy(toolOf), async (req, res) => {
    try {
        const toolId = req.body.tool || req.ctx.defaultOp || 'convert';
        const tool = getTool(toolId);
        if (!tool) {
            cleanTmp(req.file.path);
            return res.status(400).json({ error: `Unknown tool: ${toolId}` });
        }
        if (tool.multiFile) {
            cleanTmp(req.file.path);
            return res.status(400).json({ error: `${tool.label} takes several files: send them in "files" to /api/process/multi` });
        }

        // Execute the tool (same options, hardening and code path as the audio.process job; killed at its timeout)
        const result = await runSync(res, toolId, req.file.path, buildOptions(req.body, toolId, req.ctx));

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
        if (guard.toolRefused(req, res, err, toolOf(req))) return;
        console.error('[Process] Error:', err.message);
        res.status(422).json({ error: err.message || 'Audio processing failed' });
    }
});

// ── Multi-File Processing Endpoint (merge) ───────────────────
app.post('/api/process/multi', deprecated((req) => runPath(hostTool(req))), guard.originCheck(), burstLimiter, processLimiter, guard.toolQuota(hostTool), uploadMultiple, guard.admitUpload(toolOf), guard.heavy(toolOf), async (req, res) => {
    const paths = req.files.map(f => f.path);
    try {
        const toolId = req.body.tool || req.ctx.defaultOp;
        const tool = getTool(toolId);
        if (!tool || !tool.multiFile) {
            cleanTmp(...paths);
            return res.status(400).json({ error: tool ? `Tool "${toolId}" takes one file: use /api/process` : `Unknown tool: ${toolId}` });
        }
        const result = await runSync(res, toolId, req.files.map(f => f.path), buildOptions(req.body, toolId, req.ctx));
        cleanTmp(...paths);
        const first = req.files[0].originalname || 'audio';
        const saved = retention.saveOutputFromFile(result.outputPath, result.ext, result.mime, !!req.user,
            `${path.basename(first, path.extname(first))}-merged${path.extname(first)}`);
        const inputSize = req.files.reduce((n, f) => n + f.size, 0);
        res.json({ success: true, download: saved, ...describe(toolId, result, saved.size, inputSize), fileCount: req.files.length });
    } catch (err) {
        cleanTmp(...req.files.map(f => f.path));
        if (guard.toolRefused(req, res, err, toolOf(req))) return;
        console.error('[Process/Multi] Error:', err.message);
        res.status(422).json({ error: err.message || 'Audio processing failed' });
    }
});

// ── Jobs (/api/v1/jobs) ──────────────────────────────────────
// The same operation as /api/process, asynchronous and durable: accepted into data/jobs.db,
// followed over SSE (ffmpeg's own progress), cancellable (ffmpeg is killed), reattachable by id
// after a reload or a restart (apps/_shared/jobs).
const jobs = jobsRuntime.setupJobs({
    app, service: 'audio', dataDir: path.resolve(__dirname, '..', config.dataDir), Database, contracts, sdk,
    getPublicKey: guard.keys.get, issuer: config.networkUrl, guard,
    define: defineJobs,
    receive: uploadAny,
    limiters: [burstLimiter, processLimiter, guard.toolQuota(hostTool)],
    jobTool: (req, type, input) => { const d = guard.toolForJob('audio.process', String((input && input.tool) || req.ctx.defaultOp || 'convert'), req.ctx.toolId); return d ? d.id : null; },
    defaults(req, input) {
        const out = { ...input };
        if (!out.tool) out.tool = req.ctx.defaultOp || 'convert';
        if (req.ctx.defaultFormat && out.tool === 'convert') out.format = req.ctx.defaultFormat;
        return out;
    },
});

// ── Run API (ADR-027): POST /api/v1/tools/:id/run for this app's tools ──
// tools.run-request@1 (JSON, or multipart with `file` parts and the text parts input, files, wait_ms)
// → tools.run@1: each tool runs as a job of this satellite (the preset and operation from its
// descriptor), answered finished within wait_ms or 202 with the job. The gateway streams runs here.
const runApi = satelliteRunApi({
    app: 'audio', guard, contracts, snapshot: toolRegistry.snapshot, system: () => jobs,
    multer: require('multer'), uploadsDir: path.resolve(config.uploadsDir), ...ajvFrom(require), ports: () => satellitePorts(),
    limiters: [burstLimiter, processLimiter],
});
app.use(runApi.handle);

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
    guard.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
