'use strict';

// ═══════════════════════════════════════════════════════════════
// Docs.OpenVibe — Main Server Entry Point
// Unified document & PDF processing hub serving all subdomains.
// One backend, many hostnames, dynamic branding per domain.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');

const fsp = require('fs/promises');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const { resolveContext, DOMAIN_MAP } = require('./domain-map');
const { getTool, listTools, BINARIES } = require('./tools');
const { uploadSingle, uploadMultiple, uploadAny } = require('./middleware/upload');
const retention = require('./retention/manager');
const { buildOptions, defineJobs, runTool } = require('./process');
const { poolFromEnv } = require('../../_shared/jobs/pool');
const { hostGuard, ownHost } = require('../../_shared/host-role');
const { createToolsApi, exceptRegistry } = require('../../_shared/tools/http');
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
const analytics = new AnalyticsTracker(analyticsDb, 'openvibe-docs', { retention: { days: 30 } });

// ── Guard (apps/_shared/guard) ───────────────────────────────
// Who is asking (Network sign-in with aud openvibe.tools, service tokens, the browser session, else
// the address), tiered quotas by each tool's descriptor, upload sniffing, the sync semaphore and the
// abuse log (data/guard.db). TOOLS_GUARD=report (default) records what it would refuse. Every PDF
// tool needs a browser session, a sign-in or a token (descriptor auth.anonymous false).
const SPECS = require('./descriptors').SPECS;
const guard = createGuard({
    app: 'docs', dataDir: path.resolve(__dirname, '..', config.dataDir), Database, contracts, specs: SPECS,
    issuer: config.networkUrl, networkUrl: config.networkUrl, networkInternalUrl: config.networkInternalUrl, publicKeyFiles: config.publicKeyPaths,
});
const { apiLimiter, processLimiter, burstLimiter } = guard.legacyLimiters(rateLimit);
/** The tool a request is for before its body is read: the host's own (the hubs: merge, the first). */
const hostTool = (req) => (guard.tool(req.ctx.toolId) ? req.ctx.toolId : (guard.toolForJob('docs.process', req.ctx.defaultOp || 'merge', null) || { id: null }).id);
/** The tool a parsed request runs: its `tool` (operation) on this host. */
const toolOf = (req) => { const op = String((req.body && req.body.tool) || req.ctx.defaultOp || ''); const d = op ? guard.toolForJob('docs.process', op, req.ctx.toolId) : null; return d ? d.id : hostTool(req); };
// ── Worker pool (apps/_shared/jobs/pool.js) ─────────────────
// pdf-lib runs in worker threads, never on the event loop: TOOLS_WORKERS (2) at once for the
// synchronous endpoints and the jobs together, each with a heap limit (TOOLS_WORKER_MEMORY_MB, 512)
// and terminated at its timeout, on cancel, or when the client goes away.
const pool = poolFromEnv('docs', path.join(__dirname, 'worker.js'));
/** The sync endpoints' bounds for a run: the tool's descriptor timeout, and the client leaving. */
function syncRun(req, res) {
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ac.abort(); });
    const d = guard.tool(toolOf(req));
    return { signal: ac.signal, timeoutMs: (d && d.limits && d.limits.timeoutMs) || 10 * 60 * 1000 };
}

/** Read the uploaded files (on disk) and delete them. */
async function readUploads(files) {
    try { return await Promise.all(files.map(f => fsp.readFile(f.path))); } finally { for (const f of files) fs.unlink(f.path, () => {}); }
}

const app = express();
// What this deploy runs (ADR-016); the shared navbar's release-watch polls it on every tool host.
const release = require('openvibe-shared/release').createRelease({ service: 'tools', root: require('path').join(__dirname, '..', '..', '..') });
// Metrics (GET /metrics, direct loopback callers only) and GET /api/ready from this server's real
// dependencies (roadmap Track O). First, so the HTTP metrics see every request.
const { observe, checks: ready } = require('../../_shared/observe');
const obs = observe({
    app, metrics: require('openvibe-shared/metrics'), ready: require('openvibe-shared/ready'),
    service: 'tools-docs', release: release.release,
    checks: [
        ready.sqlite('jobs_db', () => jobs.db, { sql: 'SELECT COUNT(*) AS n FROM tool_jobs', description: 'job store (jobs.db)' }),
        ready.jobRuntime('job_runtime', () => jobs),
        ready.writableDir('data_dir', path.resolve(__dirname, '..', config.dataDir), { description: 'jobs.db and job inputs/results' }),
        ready.writableDir('uploads_dir', path.resolve(config.uploadsDir), { description: 'synchronous uploads' }),
        ready.writableDir('output_dir', path.resolve(config.outputDir), { description: 'synchronous results' }),
        ready.sqlite('analytics_db', analyticsDb, { required: false, description: 'visit analytics only; tools work without it' }),
        ready.networkKey('network_key', guard.keys.get, { description: 'verifies signed-in users and service tokens on the job API; anonymous use works without it' }),
        ...BINARIES.map(b => b.readyCheck(b.name === 'qpdf' ? 'Protect and Unlock PDF (package qpdf); the other tools work without it' : 'PDF to image (package poppler-utils); the other tools work without it')),
        ...jobsRuntime.readyChecks(() => jobs),
    ],
    jobs: () => jobs,
});
guard.attachMetrics(obs.registry);
app.get('/release.json', release.handler);

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
})));

// ── Who is asking, then rate limits (sign-in first, so a signed-in tier applies) ──
app.use(guard.identify);
app.use('/api/', apiLimiter, guard.apiQuota);

// ── Tool registry (ADR-027): GET /api/v1/tools[/:id[/schema]] for this app's PDF tools ──
// Public (Access-Control-Allow-Origin *), cacheable (ETag), counted by the limiter above. The
// gateway (openvibe.tools) answers the same routes for every tool and reads this list for status.
const pdfPrograms = require('./tools/pdf');
const toolRegistry = createLocalRegistry({ specs: require('./descriptors').SPECS, statusOf: requiresStatus((p) => (pdfPrograms[p] ? pdfPrograms[p].available() : true)) });
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

/** A tool's error on the synchronous endpoints: 503 problem when a tool is not set up, else { error }. */
function sendToolError(req, res, err, label) {
    if (guard.toolRefused(req, res, err, toolOf(req))) return undefined;
    if (err.status === 503) {
        if (err.retryAfter) res.set('Retry-After', String(err.retryAfter));
        return contracts.http.sendProblem(res, 503, err.code || 'tools.unavailable', { detail: err.message, ctx: req.ov });
    }
    if (!err.expose) console.error(`[${label}] Error:`, err.message);
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 422;
    return res.status(status).json({ error: err.message || 'Document processing failed', ...(err.code && { code: err.code }) });
}

// Health check
app.get('/api/health', (_req, res) => {
    const stats = retention.getStats();
    res.json({ status: 'ok', service: 'openvibe-docs', version: '1.0.0', files: stats, jobs: jobs.stats(), workers: pool.stats() });
});

// Domain context (frontend calls this on load to get branding). It also starts this browser's session
// (ov_tools_jobs): PDF tools need one (or a sign-in, or a token) before the first upload.
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

// ── PDF Info (no file mutation) ──────────────────────────────
app.post('/api/info', burstLimiter, processLimiter, guard.toolQuota(hostTool), uploadSingle, guard.admitUpload(hostTool), guard.heavy(hostTool), async (req, res) => {
    try {
        const tool = getTool('metadata');
        const [buffer] = await readUploads([req.file]);
        const result = await runTool(pool, tool, buffer, { mode: 'view' }, syncRun(req, res));
        res.json({ success: true, ...result });
    } catch (err) {
        sendToolError(req, res, err, 'Info');
    }
});

// ── Main Processing Endpoint (single file) ───────────────────
app.post('/api/process', burstLimiter, processLimiter, guard.toolQuota(hostTool), uploadSingle, guard.admitUpload(toolOf), guard.heavy(toolOf), async (req, res) => {
    try {
        const toolId = req.body.tool || req.ctx.defaultOp;
        if (!toolId) { fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: 'No tool specified.' }); }

        const tool = getTool(toolId);
        if (!tool) { fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: `Unknown tool: ${toolId}` }); }

        // Same options and code path as the docs.process job (the worker pool, its cap and its limits)
        const [buffer] = await readUploads([req.file]);
        const result = await runTool(pool, tool, buffer, buildOptions(req.body, req.ctx, false), syncRun(req, res));

        // Some tools return view-only results (like metadata view)
        if (result.viewOnly) {
            return res.json({ success: true, tool: toolId, ...result });
        }

        // Save output file
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
            ...(result.pageCount !== undefined && { pageCount: result.pageCount }),
            ...(result.savings && { savings: result.savings }),
            ...(result.metadata && { metadata: result.metadata }),
            ...(result.note && { note: result.note }),
        });
    } catch (err) {
        sendToolError(req, res, err, 'Process');
    }
});

// ── Multi-File Processing Endpoint (merge, img2pdf) ──────────
app.post('/api/process/multi', burstLimiter, processLimiter, guard.toolQuota(hostTool), uploadMultiple, guard.admitUpload(toolOf), guard.heavy(toolOf), async (req, res) => {
    try {
        const toolId = req.body.tool || req.ctx.defaultOp;
        const tool = toolId ? getTool(toolId) : null;
        if (!tool || !tool.multiFile) {
            for (const f of req.files) fs.unlink(f.path, () => {});
            if (!toolId) return res.status(400).json({ error: 'No tool specified.' });
            if (!tool) return res.status(400).json({ error: `Unknown tool: ${toolId}` });
            return res.status(400).json({ error: `Tool "${toolId}" does not support multiple files. Use /api/process instead.` });
        }

        const buffers = await readUploads(req.files);
        const result = await runTool(pool, tool, buffers, buildOptions(req.body, req.ctx, true), syncRun(req, res));

        // Save output
        const firstName = req.files[0]?.originalname || 'output';
        const saved = retention.saveOutput(
            result.buffer,
            result.ext,
            result.mime,
            !!req.user,
            firstName,
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
            fileCount: req.files.length,
            ...(result.pageCount !== undefined && { pageCount: result.pageCount }),
        });
    } catch (err) {
        sendToolError(req, res, err, 'Process/Multi');
    }
});

// ── Jobs (/api/v1/jobs) ──────────────────────────────────────
// The same operations as /api/process and /api/process/multi, asynchronous and durable: accepted
// into data/jobs.db, followed over SSE, reattachable by id after a reload or a restart.
const jobs = jobsRuntime.setupJobs({
    app, service: 'docs', dataDir: path.resolve(__dirname, '..', config.dataDir), Database, contracts, sdk,
    getPublicKey: guard.keys.get, issuer: config.networkUrl, guard,
    define: (system) => defineJobs(system, pool),
    receive: uploadAny,
    limiters: [burstLimiter, processLimiter, guard.toolQuota(hostTool)],
    jobTool: (req, type, input) => { const op = String((input && input.tool) || req.ctx.defaultOp || ''); const d = op ? guard.toolForJob('docs.process', op, req.ctx.toolId) : null; return d ? d.id : null; },
    defaults(req, input) {
        const out = { ...input };
        if (!out.tool && req.ctx.defaultOp) out.tool = req.ctx.defaultOp;
        if (!out.format && !out.defaultFormat && req.ctx.defaultFormat) out.defaultFormat = req.ctx.defaultFormat;
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
        : 'openvibedocs-output';

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
    console.log(`║   📄  Docs.OpenVibe — Document Tools Hub    ║`);
    console.log(`╠═══════════════════════════════════════╣`);
    console.log(`║  Port: ${String(config.port).padEnd(30)}║`);
    console.log(`║  Host: ${config.host.padEnd(30)}║`);
    console.log(`╚═══════════════════════════════════════╝\n`);
    for (const b of BINARIES) {
        const st = b.detect();
        console.log(st.available ? `[Docs.OpenVibe] ${b.name}: ${st.path}` : `[Docs.OpenVibe] ${b.name} missing (${st.detail}): its tools answer 503 tools.unavailable until it is installed`);
    }
});

// ── Graceful Shutdown ────────────────────────────────────────
function shutdown() {
    console.log('[Docs.OpenVibe] Shutting down...');
    analytics.destroy();
    analyticsDb.close();
    jobs.close();   // running jobs stay 'running' in data/jobs.db; the next boot re-queues them
    pool.close();
    guard.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
