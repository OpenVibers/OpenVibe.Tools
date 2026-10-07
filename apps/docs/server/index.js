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
const config = require('./config');
const { resolveContext, DOMAIN_MAP } = require('./domain-map');
const { getTool, listTools, BINARIES } = require('./tools');
// Uploads from the shared runtime (apps/_shared/upload.js, WS-L task 3).
const { uploadSingle, uploadMultiple, uploadAny } = require('../../_shared/upload').createUploads({ multer: require('multer'), config, storage: 'disk', maxFiles: 50 });
const retention = require('./retention/manager');
const { buildOptions, defineJobs, runTool } = require('./process');
const { poolFromEnv } = require('../../_shared/jobs/pool');
const { hostGuard, ownHost } = require('../../_shared/host-role');
const { createToolsApi, exceptRegistry } = require('../../_shared/tools/http');
const { satelliteRunApi, ajvFrom } = require('../../_shared/tools/run');
const { satellitePorts } = require('../../_shared/tools/satellites');
const { createLocalRegistry, requiresStatus } = require('../../_shared/tools/local');
const jobsRuntime = require('../../_shared/jobs');
const { createGuard, TRUST_PROXY } = require('../../_shared/guard');
const contracts = require('openvibe-contracts');
const sdk = require('openvibe-sdk');

// ── Analytics ────────────────────────────────────────────────
const { AnalyticsTrackerPg } = require('openvibe-shared/analytics/pg'); // ADR-021: no IP/user id, route templates, raw rows pruned after 30 days, Sec-GPC/DNT not recorded
const { requireInternalAccess } = require('../../_shared/internal-token');

// ── Guard (apps/_shared/guard) ───────────────────────────────
// Who is asking (Network sign-in with aud openvibe.tools, service tokens, the browser session, else
// the address), tiered quotas by each tool's descriptor, upload sniffing, the sync semaphore and the
// abuse log (data/guard.db). TOOLS_GUARD=enforce (default) refuses; report records what it would
// refuse. Every PDF tool needs a browser session, a sign-in or a token (descriptor auth.anonymous false).
const SPECS = require('./descriptors').SPECS;
// The one `tools` database and the shared Valkey (plan T8, decisions 3 and 4).
const toolsDb = require('../../_shared/db').openToolsDb({ createDb: require('openvibe-sdk/db').createDb, service: 'tools-docs' });
const analytics = new AnalyticsTrackerPg(toolsDb.db, 'openvibe-docs', { retention: { days: 30 } }); // ADR-021; PostgreSQL (plan T8)
const toolsValkey = require('../../_shared/db').openToolsValkey({ createValkey: require('openvibe-sdk/valkey').createValkey });
const guard = createGuard({
    app: 'docs', db: toolsDb.db, valkey: toolsValkey, contracts, specs: SPECS,
    issuer: config.networkUrl, networkUrl: config.networkUrl, networkInternalUrl: config.networkInternalUrl, publicKeyFiles: config.publicKeyPaths,
});
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
const release = require('../../_shared/release').toolsRelease('docs', require);   // its components: apps/_shared/release.js
// Metrics (GET /metrics, direct loopback callers only) and GET /api/ready from this server's real
// dependencies (roadmap Track O). First, so the HTTP metrics see every request.
const { observe, checks: ready } = require('../../_shared/observe');
// Serve only once the schema is in: the first PGlite migration must not run inside a request (it
// would block the event loop and time out a satellite's readiness check).
app.use((req, res, next) => toolsDb.ready.then(() => next(), next));
const obs = observe({
    app, metrics: require('openvibe-shared/metrics'), ready: require('openvibe-shared/ready'),
    service: 'tools-docs', release: release.release,
    checks: [
        ready.postgres('tools_db', () => toolsDb.db, { description: 'the one tools database (guard_abuse, jobs, analytics, revocations)' }),
        ready.jobRuntime('job_runtime', () => jobs),
        ready.writableDir('data_dir', path.resolve(__dirname, '..', config.dataDir), { description: 'job inputs/results' }),
        ready.writableDir('uploads_dir', path.resolve(config.uploadsDir), { description: 'synchronous uploads' }),
        ready.writableDir('output_dir', path.resolve(config.outputDir), { description: 'synchronous results' }),
        ready.networkKey('network_key', guard.keys.get, { description: 'verifies signed-in users and service tokens on the job API; anonymous use works without it' }),
        ...BINARIES.map(b => b.readyCheck(b.name === 'qpdf' ? 'Protect and Unlock PDF (package qpdf); the other tools work without it' : 'PDF to image (package poppler-utils); the other tools work without it')),
        ...jobsRuntime.readyChecks(() => jobs),
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
            imgSrc: ["'self'", "data:", "blob:"],
            // openvibe.events: release notifications (release-watch's EventSource, openvibe-shared 2.13.0).
            connectSrc: ["'self'", "https://openvibe.network", "https://*.openvibe.tools", "https://openvibe.events"],
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

// ── Who is asking, then the guard's quotas ───────────────────
app.use(guard.identify);
app.use('/api/', guard.apiQuota);

// ── Tool registry (ADR-027): GET /api/v1/tools[/:id[/schema]] for this app's PDF tools ──
// Public (Access-Control-Allow-Origin *), cacheable (ETag), counted by the quota above. The
// gateway (openvibe.tools) answers the same routes for every tool and reads this list for status.
const pdfPrograms = require('./tools/pdf');
const toolRegistry = createLocalRegistry({ specs: require('./descriptors').SPECS, statusOf: requiresStatus((p) => (pdfPrograms[p] ? pdfPrograms[p].available() : true)) });
// A signed-in person's page view of a tool goes into their tools.usage module (the launchers' recent tools).
app.use(require('../../_shared/usage').usagePages({ snapshot: toolRegistry.snapshot }));
// Per-actor limits (apps/_shared/actor-limits.js, roadmap WS-R task 4): signed-in registry reads, and a backstop above the
// guard's quotas on job submits, retries and runs.
const actorLimits = require('../../_shared/actor-limits').createToolsLimits({ app: 'docs', createActorLimiter: require('openvibe-sdk/limits').createActorLimiter, guard, registry: obs.registry });
app.use(actorLimits.registryReads);
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
app.get('/api/health', async (_req, res) => {
    const stats = retention.getStats();
    res.json({ status: 'ok', service: 'openvibe-docs', version: '1.0.0', files: stats, jobs: await jobs.stats(), workers: pool.stats() });
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
app.post('/api/info', guard.originCheck(), guard.toolQuota(hostTool), uploadSingle, guard.admitUpload(hostTool), guard.heavy(hostTool), async (req, res) => {
    try {
        const tool = getTool('metadata');
        const [buffer] = await readUploads([req.file]);
        const result = await runTool(pool, tool, buffer, { mode: 'view' }, syncRun(req, res));
        res.json({ success: true, ...result });
    } catch (err) {
        sendToolError(req, res, err, 'Info');
    }
});

// ── Jobs (/api/v1/jobs) ──────────────────────────────────────
// The document operations, asynchronous and durable: accepted into the shared `tools` database, followed over SSE,
// reattachable by id after a reload or a restart.
const jobs = jobsRuntime.setupJobs({
    app, service: 'docs', dataDir: path.resolve(__dirname, '..', config.dataDir), db: toolsDb.db, contracts, sdk,
    getPublicKey: guard.keys.get, issuer: config.networkUrl, guard,
    define: (system) => defineJobs(system, pool),
    receive: uploadAny,
    limiters: [actorLimits.backstop('tools.job.create'), guard.toolQuota(hostTool)],
    jobTool: (req, type, input) => { const op = String((input && input.tool) || req.ctx.defaultOp || ''); const d = op ? guard.toolForJob('docs.process', op, req.ctx.toolId) : null; return d ? d.id : null; },
    defaults(req, input) {
        const out = { ...input };
        if (!out.tool && req.ctx.defaultOp) out.tool = req.ctx.defaultOp;
        if (!out.format && !out.defaultFormat && req.ctx.defaultFormat) out.defaultFormat = req.ctx.defaultFormat;
        return out;
    },
});

// ── Run API (ADR-027): POST /api/v1/tools/:id/run for this app's tools ──
// tools.run-request@1 (JSON, or multipart with `file` parts and the text parts input, files, wait_ms)
// → tools.run@1: each tool runs as a job of this satellite (the preset and operation from its
// descriptor), answered finished within wait_ms or 202 with the job. The gateway streams runs here.
const runApi = satelliteRunApi({
    app: 'docs', guard, contracts, snapshot: toolRegistry.snapshot, system: () => jobs,
    multer: require('multer'), uploadsDir: path.resolve(config.uploadsDir), ...ajvFrom(require), ports: () => satellitePorts(),
    limiters: [actorLimits.backstop('tools.tool.run')],
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
        : 'openvibedocs-output';

    res.set({
        'Content-Type': entry.mime,
        'Content-Disposition': `attachment; filename="${baseName}.${entry.ext}"`,
        'Content-Length': entry.size,
    });
    res.sendFile(entry.filePath);
});

// ── Internal Analytics API ────────────────────────────────────
const internalAccess = requireInternalAccess({ keys: guard.keys, issuer: guard.issuer, audience: guard.audience, contracts });
app.get('/api/internal/analytics', internalAccess, async (req, res) => {
    try { const d = Math.min(parseInt(req.query.days) || 30, 365); const h = req.query.hours ? Math.min(parseInt(req.query.hours), 8760) : null; res.json({ ok: true, analytics: await analytics.getStats({ days: d, hours: h }) }); }
    catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.get('/api/internal/analytics/bots', internalAccess, async (req, res) => {
    try { res.json({ ok: true, bots: await analytics.getBotAnalysis(Math.min(parseInt(req.query.days) || 30, 365)) }); }
    catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ── Static Files ─────────────────────────────────────────────
// (the shared browser files come from this app's own pin at /shared: apps/_shared/release.js)

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

// ── Graceful stop (roadmap WS-P lifecycle; apps/_shared/graceful.js) ──
// SIGTERM: the retention timer and the job worker stop (nothing new starts; open job event streams
// end); the server stops taking connections and lets requests in flight finish (4 s at most); then
// recent-tool writes are flushed (1 s at most), the analytics, the jobs store, the worker pool and the
// guard close, and the process exits 0, within the manifest's 5 s.
require('../../_shared/graceful').gracefulStop({
    name: 'Docs.OpenVibe', server,
    stop: [
        () => retention.stopCleanup(),
        () => jobs.stop(),
    ],
    close: [
        () => require('../../_shared/usage').stopRecorder(800),
        () => analytics.destroy(),
        () => jobs.close(),   // running jobs stay 'running' in the tools database; the next boot re-queues them
        () => pool.close(),
        () => guard.close(),
        () => toolsDb.db.close(),
        () => toolsValkey && toolsValkey.close(),
    ],
});
