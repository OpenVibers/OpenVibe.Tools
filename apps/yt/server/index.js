'use strict';

// ═══════════════════════════════════════════════════════════════
// YT.OpenVibe — Main Server Entry Point
// YouTube downloader with yt-dlp backend.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');

const config = require('./config');
const downloader = require('./downloader');
const seo = require('./seo');
const { hostGuard } = require('../../_shared/host-role');
const { createToolsApi, exceptRegistry } = require('../../_shared/tools/http');
const { createLocalRegistry, requiresStatus } = require('../../_shared/tools/local');
const { createGuard, TRUST_PROXY } = require('../../_shared/guard');

// ── Analytics ────────────────────────────────────────────────
const { AnalyticsTrackerPg } = require('openvibe-shared/analytics/pg'); // ADR-021: no IP/user id, route templates, raw rows pruned after 30 days, Sec-GPC/DNT not recorded
const { requireInternalAccess } = require('../../_shared/internal-token');

// ── Guard (apps/_shared/guard) ───────────────────────────────
// Who is asking (Network sign-in with aud openvibe.tools, the browser session, else the address),
// the tools-download quota (a download costs 50, descriptor yt) and the abuse log (data/guard.db).
// TOOLS_GUARD=enforce (default) refuses; report records what it would refuse.
// The one `tools` database and the shared Valkey (plan T8, decisions 3 and 4).
const toolsDb = require('../../_shared/db').openToolsDb({ createDb: require('openvibe-sdk/db').createDb, service: 'tools-yt' });
const analytics = new AnalyticsTrackerPg(toolsDb.db, 'openvibe-yt', { retention: { days: 30 } }); // ADR-021; PostgreSQL (plan T8)
const toolsValkey = require('../../_shared/db').openToolsValkey({ createValkey: require('openvibe-sdk/valkey').createValkey });
const guard = createGuard({
    app: 'yt', db: toolsDb.db, valkey: toolsValkey, specs: require('./descriptors').SPECS,
    issuer: config.networkUrl, networkUrl: config.networkUrl, networkInternalUrl: config.networkInternalUrl, publicKeyFiles: config.publicKeyPaths,
});

const app = express();
// What this deploy runs (ADR-016); the shared navbar's release-watch polls it on every tool host.
const release = require('../../_shared/release').toolsRelease('yt', require);   // its components: apps/_shared/release.js
// Metrics (GET /metrics, direct loopback callers only) and GET /api/ready from this server's real
// dependencies (roadmap Track O). First, so the HTTP metrics see every request.
const { observe, checks: ready, which } = require('../../_shared/observe');
// Serve only once the schema is in: the first PGlite migration must not run inside a request (it
// would block the event loop and time out a satellite's readiness check).
app.use((req, res, next) => toolsDb.ready.then(() => next(), next));
const obs = observe({
    app, metrics: require('openvibe-shared/metrics'), ready: require('openvibe-shared/ready'),
    service: 'tools-yt', release: release.release,
    checks: [
        ready.postgres('tools_db', () => toolsDb.db, { description: 'the one tools database (guard_abuse, analytics, revocations)' }),
        ready.writableDir('downloads_dir', path.resolve(config.downloadsDir), { description: 'downloads are written here before they are served' }),
        ready.binary('yt_dlp', config.ytdlpPath, { description: 'every download runs yt-dlp' }),
        ready.binary('ffmpeg', process.env.FFMPEG_PATH || 'ffmpeg', { description: 'merging video+audio and audio conversion' }),
        ...(process.env.YT_COOKIES_FILE ? [ready.readableFile('yt_cookies', process.env.YT_COOKIES_FILE, { description: 'YT_COOKIES_FILE is set; yt-dlp is given these cookies' })] : []),
        ready.networkKey('network_key', guard.keys.get, { description: 'recognises signed-in visitors (higher limits); anonymous use works without it' }),
    ],
    // Download progress streams last as long as the download.
    skip: (req) => /^\/api\/status\/[^/]+\/stream$/.test(req.path),
    details: () => ({ yt_proxy_configured: !!String(process.env.YT_PROXY || '').trim() }),
});
guard.attachMetrics(obs.registry);
// GET /release.json (ADR-016) and POST /release-metrics, which the shared navbar's release-watch reports
// its update outcomes to (release_client_updates_total on /metrics): openvibe-shared release.mount.
release.mount(app, { registry: obs.registry });

// Legal documents live on the apex; every tool host points there instead of answering 404.
app.get(['/terms', '/privacy', '/dmca', '/tos'], (req, res) => res.redirect(301, 'https://openvibe.tools' + (req.path === '/tos' ? '/terms' : req.path)));

// ── Security ─────────────────────────────────────────────────
app.set('trust proxy', TRUST_PROXY); // one hop: the host's nginx (or the gateway) on loopback; req.ip is the only address
// API answers are live state, never revalidated: a 304 on /api/status froze the progress poll.
app.set('etag', false);
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com", "https://openvibe.network", "https://static.cloudflareinsights.com"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://fonts.googleapis.com", "https://fonts.gstatic.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:", "https://i.ytimg.com", "https://img.youtube.com", "https://*.ggpht.com", "https://openvibe.network", "https://openvibe.media"],
            // openvibe.events: release notifications (release-watch's EventSource, openvibe-shared 2.13.0).
            connectSrc: ["'self'", "https://openvibe.network", "https://openvibe.tools", "https://*.openvibe.tools", "https://cloudflareinsights.com", "https://openvibe.events"],
            frameSrc: ["https://openvibe.network"], // the hidden /sso/check sign-in probe
            scriptSrcAttr: ["'unsafe-inline'"],
        },
    },
    crossOriginEmbedderPolicy: false,
}));
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));

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

// ── Rate Limiting ────────────────────────────────────────────
// Sign-in is read first, so limits know who is asking; everyone else counts by address (IPv6 by /64).
// The guard's tools-api quota covers every /api/ call, the progress polls included.
app.use(guard.identify);
app.use('/api/', guard.apiQuota);
app.use('/api/', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

// ── Tool registry (ADR-027): GET /api/v1/tools[/:id[/schema]] for this app's YouTube downloader ──
// Public (Access-Control-Allow-Origin *), cacheable (ETag), counted by the quota above. The
// gateway (openvibe.tools) answers the same routes for every tool and reads this list for status.
const toolRegistry = createLocalRegistry({ specs: require('./descriptors').SPECS, statusOf: requiresStatus((p) => (p === 'yt-dlp' ? !!which(config.ytdlpPath) : true)) });
// A signed-in person's page view of a tool goes into their tools.usage module (the launchers' recent tools).
app.use(require('../../_shared/usage').usagePages({ snapshot: toolRegistry.snapshot }));
// Per-actor limits (apps/_shared/actor-limits.js, roadmap WS-R task 4): signed-in registry reads (signed-out reads keep
// the per-address limit only).
const actorLimits = require('../../_shared/actor-limits').createToolsLimits({ app: 'yt', createActorLimiter: require('openvibe-sdk/limits').createActorLimiter, guard, registry: obs.registry });
app.use(actorLimits.registryReads);
app.use(createToolsApi({ snapshot: toolRegistry.snapshot }));

// ── Analytics Middleware ─────────────────────────────────────
app.use(analytics.middleware());

// Downloads: the guard's tools-download quota (descriptor yt: cost 50). A download belongs to whoever
// started it (the browser session cookie, minted on the start, or a sign-in): its status, progress
// stream, file and cancel answer 404 to anyone else, the same as for an id that does not exist.
const owners = new Map();   // download id → owner
const ownsDownload = (req, res, id) => {
    const owner = owners.get(String(id || ''));
    const who = guard.resolveCaller(req, res);
    return !!owner && !!who.owner && owner === who.owner;
};
setInterval(() => { for (const id of owners.keys()) if (!downloader.getStatus(id) && !downloader.getFile(id)) owners.delete(id); }, 10 * 60_000).unref();

// ── Hosts ────────────────────────────────────────────────────
// Pages are only rendered for hosts this tool serves (or that the gateway vouches for with
// X-OV-Tool); aliases go to the short host, anything else to the tools index.
app.use(hostGuard({ knows: seo.knowsHost, aliasOf: seo.aliasOf }));

// ── API Routes ───────────────────────────────────────────────

// Health check
app.get('/api/health', (_req, res) => {
    const stats = downloader.getStats();
    const up = downloader.getUpstream();
    res.set('Cache-Control', 'no-store').json({ status: 'ok', service: 'openvibe-yt', version: '1.0.0', stats, info: downloader.infoStats(), limits: { maxDuration: config.download.maxDuration, maxFilesizeMB: config.download.maxFilesize }, youtube: up.state, youtubeCheckedAt: up.checkedAt ? new Date(up.checkedAt).toISOString() : null });
});

// Get video info
app.post('/api/info', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });
    if (!downloader.isValidUrl(url)) return res.status(400).json({ error: 'Only YouTube URLs are supported (youtube.com, youtu.be)' });

    try {
        // At most config.info.maxConcurrent yt-dlp lookups at once; the same video is looked up once
        // per ten minutes however many people paste it.
        const info = await downloader.getInfoLimited(url);
        res.json({ success: true, video: info });
    } catch (err) {
        if (err.status === 503) return res.status(503).set('Retry-After', '5').json({ error: err.message });
        console.error('[Info] Error:', err.message);
        res.status(422).json({ error: err.message });
    }
});

// Start download
app.post('/api/download', guard.toolQuota('yt'), async (req, res) => {
    const { url, quality, title } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });
    if (!downloader.isValidUrl(url)) return res.status(400).json({ error: 'Only YouTube URLs are supported' });
    // The length is known from the info lookup the page made first: refuse before yt-dlp starts.
    const known = downloader.cachedInfo(downloader.videoId(url));
    if (known && known.downloadable === false) return res.status(422).json({ error: known.reason });

    try {
        const who = guard.resolveCaller(req, res, { create: true });
        const { id } = await downloader.startDownload(url, quality || 'best', { title: typeof title === 'string' ? title : '' });
        owners.set(id, who.owner);
        res.json({ success: true, id, statusUrl: `/api/status/${id}`, streamUrl: `/api/status/${id}/stream` });
    } catch (err) {
        console.error('[Download] Error:', err.message);
        res.status(422).json({ error: err.message });
    }
});

// Download status (poll for progress)
app.get('/api/status/:id', (req, res) => {
    const status = ownsDownload(req, res, req.params.id) ? downloader.getStatus(req.params.id) : null;
    if (!status) return res.status(404).json({ error: 'Download not found' });
    res.json(status);
});

// Download status via SSE (real-time progress).
//
// Protocol (the poll endpoint above answers the same JSON):
//   event: progress   status "downloading" — phase starting|downloading|processing, progress 0–100|null
//   event: complete   status "done"        — download { url, size, ext, filename }
//   event: failed     status "error"       — error text (cancelled: true after DELETE)
// Every frame is also sent once as an unnamed message (`data:` only) for clients that predate
// the named events. The stream closes itself after a terminal event.
const SSE_EVENT = { downloading: 'progress', done: 'complete', error: 'failed' };

app.get('/api/status/:id/stream', (req, res) => {
    const id = req.params.id;
    if (!ownsDownload(req, res, id)) return res.status(404).json({ error: 'Download not found' });

    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    let timer = null;
    let lastFrame = '';
    let lastWrite = 0;
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const send = (event, payload) => {
        const json = JSON.stringify(payload);
        res.write(`data: ${json}\n\n`);
        res.write(`event: ${event}\ndata: ${json}\n\n`);
        lastWrite = Date.now();
    };

    const tick = () => {
        const status = downloader.getStatus(id);
        if (!status) {
            send('failed', { id, status: 'error', error: 'Download not found or expired' });
            stop();
            return res.end();
        }
        const json = JSON.stringify(status);
        const terminal = status.status === 'done' || status.status === 'error';
        if (json !== lastFrame || terminal) {
            lastFrame = json;
            send(SSE_EVENT[status.status] || 'progress', status);
        } else if (Date.now() - lastWrite > 15000) {
            res.write(': keep-alive\n\n');
            lastWrite = Date.now();
        }
        if (terminal) {
            stop();
            setTimeout(() => res.end(), 250);
        }
    };

    timer = setInterval(tick, 500);
    tick(); // first frame immediately, not after a tick of silence
    req.on('close', stop);
});

// Cancel a running download (kills yt-dlp) or discard a finished file
app.delete('/api/download/:id', (req, res) => {
    const result = ownsDownload(req, res, req.params.id) ? downloader.cancelDownload(req.params.id) : null;
    if (!result) return res.status(404).json({ error: 'Download not found' });
    res.json({ success: true, ...result });
});

// Serve downloaded file
app.get('/api/download/:id', (req, res) => {
    const entry = ownsDownload(req, res, req.params.id) ? downloader.getFile(req.params.id) : null;
    if (!entry) return res.status(404).json({ error: 'File not found or expired' });

    res.set({
        'Content-Type': entry.mime,
        'Content-Disposition': downloader.contentDisposition(entry.filename || `youtube-video.${entry.ext}`),
        'Content-Length': entry.size,
        'Cache-Control': 'private, no-store',
    });
    res.sendFile(entry.filePath);
});

// ── Internal Analytics API ────────────────────────────────────
const internalAccess = requireInternalAccess({ keys: guard.keys, issuer: guard.issuer, audience: guard.audience });
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
app.use(express.static(path.join(__dirname, '..', 'public'), {
    index: false, // '/' is rendered below with the head for this host (server/seo.js)
    setHeaders(res, filePath) {
        if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
            res.setHeader('Cache-Control', 'no-cache');
        }
    },
}));

// The page: one document, head stamped per host. Anything else that is not a file is a 404
// (no soft-404 copies of the home page under made-up paths).
app.get(['/', '/index.html'], (req, res) => {
    if (req.path !== '/') return res.redirect(301, '/');
    return seo.sendIndex(req, res);
});
app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
    res.status(404).set('Cache-Control', 'no-cache').type('html')
        .send('<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>Not found</title><p>Nothing here. <a href="/">YouTube Downloader</a></p>');
});

// ── Start ────────────────────────────────────────────────────
const server = app.listen(config.port, config.host, () => {
    downloader.startCleanup();
    downloader.startUpstreamProbe();
    console.log(`\n╔═══════════════════════════════════════╗`);
    console.log(`║   📺 YT.OpenVibe — YouTube Downloader       ║`);
    console.log(`╠═══════════════════════════════════════╣`);
    console.log(`║  Port: ${String(config.port).padEnd(30)}║`);
    console.log(`║  Host: ${config.host.padEnd(30)}║`);
    console.log(`╚═══════════════════════════════════════╝\n`);
});

// ── Graceful stop (roadmap WS-P lifecycle; apps/_shared/graceful.js) ──
// SIGTERM: the download cleanup timer stops; the server stops taking connections and lets requests
// in flight finish (4 s at most; progress streams are closed and reconnect); then recent-tool writes
// are flushed (1 s at most), the analytics and the guard close, and the process exits 0, within the
// manifest's 5 s.
require('../../_shared/graceful').gracefulStop({
    name: 'YT.OpenVibe', server,
    stop: [
        () => downloader.stopCleanup(),
    ],
    close: [
        () => require('../../_shared/usage').stopRecorder(800),
        () => analytics.destroy(),
        () => guard.close(),
        () => toolsDb.db.close(),
        () => toolsValkey && toolsValkey.close(),
    ],
});
