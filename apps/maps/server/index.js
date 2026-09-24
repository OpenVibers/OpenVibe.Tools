'use strict';

// ═══════════════════════════════════════════════════════════════
// maps.openvibe.tools — Survival Map for North America
// Express server that proxies 18+ data sources for camping,
// resources, shelter, and survival information.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const NodeCache = require('node-cache');
const cookieParser = require('cookie-parser');

const config = require('./config');

// ── Analytics ────────────────────────────────────────────────
const Database = require('better-sqlite3');
const { AnalyticsTracker } = require('openvibe-shared/analytics'); // ADR-021: no IP/user id, route templates, raw rows pruned after 30 days, Sec-GPC/DNT not recorded
const { internalOk } = require('../../_shared/internal-auth');
const { hostGuard, stampedPage } = require('../../_shared/host-role');
const { createToolsApi, exceptRegistry } = require('../../_shared/tools/http');
const { createLocalRegistry, requiresStatus } = require('../../_shared/tools/local');
const { createGuard, TRUST_PROXY } = require('../../_shared/guard');
const { createPacer, Busy } = require('../../_shared/guard/semaphore');
const analyticsDbPath = path.join(__dirname, '..', 'data', 'analytics.db');
fs.mkdirSync(path.dirname(analyticsDbPath), { recursive: true });
const analyticsDb = new Database(analyticsDbPath);
analyticsDb.pragma('journal_mode = WAL');
const analytics = new AnalyticsTracker(analyticsDb, 'openvibe-maps', { retention: { days: 30 } });

// ── Guard (apps/_shared/guard) ───────────────────────────────
// Who is asking (Network sign-in with aud openvibe.tools, else the address — the food app forwards its
// visitor's), the tools-map quota on the data routes (descriptor maps: cost 2 a call) and the abuse log
// (data/guard.db). TOOLS_GUARD=report (default) records what it would refuse.
const NETWORK_URL = process.env.OV_NETWORK_URL || 'https://openvibe.network';
const guard = createGuard({
    app: 'maps', dataDir: path.join(__dirname, '..', 'data'), Database, specs: require('./descriptors').SPECS,
    issuer: NETWORK_URL, networkUrl: NETWORK_URL, networkInternalUrl: process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000',
    publicKeyFiles: [process.env.OV_NETWORK_PUBLIC_KEY].filter(Boolean),
});

const app = express();
// What this deploy runs (ADR-016); the shared navbar's release-watch polls it on every tool host.
const release = require('../../_shared/release').toolsRelease('maps', require);   // its components: apps/_shared/release.js
// Metrics (GET /metrics, direct loopback callers only) and GET /api/ready from this server's real
// dependencies (roadmap Track O). First, so the HTTP metrics see every request.
const { observe, checks: ready } = require('../../_shared/observe');
const obs = observe({
    app, metrics: require('openvibe-shared/metrics'), ready: require('openvibe-shared/ready'),
    service: 'tools-maps', release: release.release,
    checks: [
        ready.sqlite('analytics_db', analyticsDb, { required: false, description: 'visit analytics only' }),
    ],
    // The public data sources maps queries (OSM and others) are not probed here: each request says when one fails.
});
guard.attachMetrics(obs.registry);
// GET /release.json (ADR-016) and POST /release-metrics, which the shared navbar's release-watch reports
// its update outcomes to (release_client_updates_total on /metrics): openvibe-shared release.mount.
release.mount(app, { registry: obs.registry });

// Legal documents live on the apex; every tool host points there instead of answering 404.
app.get(['/terms', '/privacy', '/dmca', '/tos'], (req, res) => res.redirect(301, 'https://openvibe.tools' + (req.path === '/tos' ? '/terms' : req.path)));
const cache = new NodeCache({ stdTTL: config.cache.search, checkperiod: 60 });

// ── Middleware ──────────────────────────────────────────────
// X-Forwarded-For is believed from exactly one hop on loopback: the host's nginx, the gateway or the
// food app (which forwards its visitor's address). Maps listens on 0.0.0.0 by default, so a direct
// caller's own header must not count.
app.set('trust proxy', TRUST_PROXY);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "unpkg.com", "cdn.jsdelivr.net", "cdnjs.cloudflare.com", "static.cloudflareinsights.com", "https://openvibe.network"],
      styleSrc: ["'self'", "'unsafe-inline'", "unpkg.com", "cdn.jsdelivr.net", "cdnjs.cloudflare.com", "fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "blob:", "*.tile.openstreetmap.org", "*.basemaps.cartocdn.com", "server.arcgisonline.com", "image.tmdb.org", "*.wp.com"],
      connectSrc: ["'self'", "nominatim.openstreetmap.org", "api.weather.gov", "api.open-meteo.com", "*.tile.openstreetmap.org", "*.basemaps.cartocdn.com", "server.arcgisonline.com", "https://openvibe.network"],
      fontSrc: ["'self'", "fonts.gstatic.com", "cdnjs.cloudflare.com", "cdn.jsdelivr.net"],
      frameSrc: ["'none'"],
      scriptSrcAttr: ["'unsafe-inline'"],
    },
  },
}));
app.use(exceptRegistry(cors({ origin: ['https://maps.openvibe.tools', 'https://food.openvibe.tools', 'https://openvibe.network', 'http://localhost:4010', 'http://localhost:4011'] })));
app.use(cookieParser());
app.use(express.json());

// Rate limits: sign-in first, so limits know who is asking; everyone else counts by address (IPv6 /64).
app.use(guard.identify);
const apiLimiter = guard.legacyLimiter(rateLimit, { windowMs: 60 * 1000, anonymous: 30, signedIn: 60, message: 'Too many requests — slow down, traveler.' });
app.use('/api/', apiLimiter, guard.apiQuota);
// The map's data lookups (OpenStreetMap, weather, food banks…): the tools-map quota, by descriptor.
app.use(['/api/geocode', '/api/search', '/api/weather', '/api/terrain', '/api/food-banks', '/api/stores', '/api/foods', '/api/meal-plan'], guard.toolQuota('maps'));

// ── Tool registry (ADR-027): GET /api/v1/tools[/:id[/schema]] for this app's survival map ──
// Public (Access-Control-Allow-Origin *), cacheable (ETag), counted by the limiter above. The
// gateway (openvibe.tools) answers the same routes for every tool and reads this list for status.
const toolRegistry = createLocalRegistry({ specs: require('./descriptors').SPECS.filter(s => s.id === 'maps') });
// A signed-in person's page view of a tool goes into their tools.usage module (the launchers' recent tools).
app.use(require('../../_shared/usage').usagePages({ snapshot: toolRegistry.snapshot }));
app.use(createToolsApi({ snapshot: toolRegistry.snapshot }));

// ── Analytics Middleware ─────────────────────────────────────
app.use(analytics.middleware());

// ── Hosts + the page ───────────────────────────────────────
// Through the gateway the X-OV-* headers name the canonical host (a custom domain included) and the
// page's canonical / og:url / JSON-LD follow it; aliases are redirected; other hosts go to the tools index.
const HOST = 'maps.openvibe.tools';
app.use(hostGuard({ knows: (h) => h === HOST }));
const sendIndex = stampedPage(path.join(__dirname, '..', 'public', 'index.html'), HOST);
app.get(['/', '/index.html'], sendIndex);

// ── Static files ───────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: '1h',
  extensions: ['html'],
  index: false,
}));

// ── Source modules ─────────────────────────────────────────
const utils = require('./sources/utils');
const ridb = require('./sources/ridb');
const overpass = require('./sources/overpass');
const freecampsites = require('./sources/freecampsites');
const ioverlander = require('./sources/ioverlander');
const staticData = require('./sources/static-data');
const bridges = require('./sources/bridges');
const bathrooms = require('./sources/bathrooms');
const resources = require('./sources/resources');
const usfs = require('./sources/usfs');
const woods = require('./sources/woods');
const waterways = require('./sources/waterways');
const nps = require('./sources/nps');
const openchargemap = require('./sources/openchargemap');
const scraper = require('./sources/scraper');
const cover = require('./sources/cover');
const crimedata = require('./sources/crimedata');
const harmreduction = require('./sources/harmreduction');
const weather = require('./sources/weather');
const terrain = require('./sources/terrain');
const grocery = require('./sources/grocery');

// ── Geocode endpoint ───────────────────────────────────────
// Nominatim's usage policy is one request a second from us in all: answers are cached, and the misses
// are paced (at most 20 waiting, none longer than 15 s; beyond that 503 with Retry-After).
const nominatim = createPacer({ minIntervalMs: 1100, queue: 20, maxWaitMs: 15_000 });
app.get('/api/geocode', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing query' });

  const cacheKey = `geo:${q.toLowerCase().trim()}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  try {
    const axios = require('axios');
    const resp = await nominatim.run(() => axios.get('https://nominatim.openstreetmap.org/search', {
      params: { q, format: 'json', limit: 5, countrycodes: 'us,ca,mx' },
      headers: { 'User-Agent': 'Maps.OpenVibe/1.0 (maps.openvibe.tools)' },
      timeout: 8000,
    }));
    const results = (resp.data || []).map(r => ({
      lat: parseFloat(r.lat),
      lon: parseFloat(r.lon),
      name: r.display_name,
      type: r.type,
    }));
    cache.set(cacheKey, results, config.cache.geocode);
    res.json(results);
  } catch (err) {
    if (err instanceof Busy) return res.status(503).set('Retry-After', '15').json({ error: 'Place search is busy; try again in a few seconds.' });
    res.status(502).json({ error: 'Geocode failed' });
  }
});

// ── Source definitions (shared between search & stream) ─────
function getSourceDefs(lat, lon, radius) {
  return [
    { name: 'RIDB', icon: 'fa-database', fn: () => ridb.search(lat, lon, radius, config.ridbApiKey) },
    { name: 'OpenStreetMap', icon: 'fa-map', fn: () => overpass.search(lat, lon, radius) },
    { name: 'FreeCampsites', icon: 'fa-campground', fn: () => freecampsites.search(lat, lon, radius) },
    { name: 'iOverlander', icon: 'fa-globe', fn: () => ioverlander.search(lat, lon, radius) },
    { name: 'Built-in DB', icon: 'fa-hard-drive', fn: () => Promise.resolve(staticData.search(lat, lon, radius)) },
    { name: 'Bridges', icon: 'fa-bridge', fn: () => bridges.findBridges(lat, lon, radius) },
    { name: 'Bathrooms', icon: 'fa-restroom', fn: () => bathrooms.findAllBathrooms(lat, lon, radius * 1609.34) },
    { name: 'Resources', icon: 'fa-hand-holding-heart', fn: () => resources.findResources(lat, lon, radius) },
    { name: 'USFS', icon: 'fa-tree', fn: () => usfs.search(lat, lon, radius) },
    { name: 'Woods', icon: 'fa-tree', fn: () => woods.findWoods(lat, lon, radius) },
    { name: 'Waterways', icon: 'fa-water', fn: () => waterways.findWaterways(lat, lon, radius) },
    { name: 'NPS', icon: 'fa-mountain-sun', fn: () => nps.search(lat, lon, radius, config.npsApiKey) },
    { name: 'OpenChargeMap', icon: 'fa-charging-station', fn: () => openchargemap.search(lat, lon, radius, config.openChargeMapKey) },
    { name: 'WebScraper', icon: 'fa-spider', fn: () => scraper.search(lat, lon, radius) },
    { name: 'Rain Cover', icon: 'fa-umbrella', fn: () => cover.findCover(lat, lon, radius) },
    { name: 'Crime Intel', icon: 'fa-skull-crossbones', fn: () => crimedata.findSketchAreas(lat, lon, radius) },
    { name: 'Harm Reduction', icon: 'fa-suitcase-medical', fn: () => harmreduction.findHarmReduction(lat, lon, radius) },
  ];
}

/** Process a single source result into normalized locations/bridges/crimeHeatmap */
function processSourceResult(name, data) {
  const out = { locations: [], bridges: [], crimeHeatmap: [], count: 0 };
  try {
    if (name === 'Bridges' && data?.bridges) {
      out.bridges = data.bridges.map(b => ({
        ...b, source: 'Bridges', sourceIcon: 'fa-bridge',
        type: `Bridge (${b.serviceUnder || 'Unknown'})`,
      }));
      out.count = data.bridges.length;
    } else if (name === 'Crime Intel' && data) {
      out.crimeHeatmap = data.heatmapPoints || [];
      if (data.locations) out.locations = data.locations;
      out.count = data.totalIndicators || 0;
    } else if (name === 'Resources' && data?.resources) {
      out.locations = data.resources.map(r => ({
        ...r, source: 'Resources', sourceIcon: r.icon || 'fa-hand-holding-heart',
        type: r.typeLabel || r.resourceType || 'Resource',
      }));
      out.count = data.total || 0;
    } else if (name === 'Woods' && data?.woods) {
      out.locations = data.woods.map(w => ({ ...w, source: 'Woods', sourceIcon: w.icon || 'fa-tree' }));
      out.count = data.total || 0;
    } else if (name === 'Waterways' && data?.waterways) {
      out.locations = data.waterways.map(w => ({ ...w, source: 'Waterways', sourceIcon: w.icon || 'fa-water' }));
      out.count = data.summary?.total || 0;
    } else if (name === 'Rain Cover' && data?.cover) {
      out.locations = data.cover.map(c => ({
        ...c, source: 'Rain Cover', sourceIcon: c.coverIcon || 'fa-umbrella',
        type: c.coverLabel || 'Covered Structure',
      }));
      out.count = data.total || 0;
    } else if (name === 'Harm Reduction' && data?.services) {
      out.locations = data.services.map(hr => ({
        ...hr, source: 'Harm Reduction', sourceIcon: hr.icon || 'fa-hand-holding-heart',
        type: hr.typeLabel || 'Harm Reduction',
      }));
      out.count = data.services.length;
    } else if (name === 'Bathrooms' && data?.bathrooms) {
      out.locations = data.bathrooms.map(b => ({
        ...b, source: 'Bathrooms', sourceIcon: 'fa-restroom',
        type: b.type || 'Bathroom',
      }));
      out.count = data.bathrooms.length;
    } else if (Array.isArray(data)) {
      out.locations = data;
      out.count = data.length;
    }
  } catch (e) {
    console.warn(`[Search] Error processing ${name}:`, e.message);
  }
  return out;
}

// ── Master search endpoint (legacy, returns all at once) ───
app.get('/api/search', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  const radius = Math.min(parseFloat(req.query.radius) || 15, 50);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: 'Invalid lat/lon' });
  }

  const cacheKey = `search:${lat.toFixed(3)}:${lon.toFixed(3)}:${radius}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);

  const sources = getSourceDefs(lat, lon, radius);
  const TIMEOUT = 30000;
  const results = { locations: [], bridges: [], crimeHeatmap: [], sourceMeta: {} };

  const settled = await Promise.allSettled(
    sources.map(s =>
      Promise.race([
        s.fn().then(data => ({ name: s.name, data })),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), TIMEOUT)),
      ])
    )
  );

  for (const result of settled) {
    if (result.status !== 'fulfilled') continue;
    const { name, data } = result.value;
    const processed = processSourceResult(name, data);
    results.locations.push(...processed.locations);
    if (processed.bridges.length) results.bridges = processed.bridges;
    if (processed.crimeHeatmap.length) results.crimeHeatmap = processed.crimeHeatmap;
    results.sourceMeta[name] = { count: processed.count };
  }

  results.locations = utils.dedup(results.locations);
  results.totalSources = sources.length;
  results.totalLocations = results.locations.length;

  cache.set(cacheKey, results);
  res.json(results);
});

// ── Streaming search endpoint (SSE) ───────────────────────
app.get('/api/search/stream', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  const radius = Math.min(parseFloat(req.query.radius) || 15, 50);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: 'Invalid lat/lon' });
  }

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (event, data) => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };

  // Check cache — if cached, stream everything instantly
  const cacheKey = `search:${lat.toFixed(3)}:${lon.toFixed(3)}:${radius}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    send('cached', cached);
    send('done', { cached: true, totalSources: cached.totalSources, totalLocations: cached.totalLocations });
    return res.end();
  }

  const sources = getSourceDefs(lat, lon, radius);

  // Send source manifest so the client can render all source indicators immediately
  send('sources', sources.map(s => ({ name: s.name, icon: s.icon })));

  const TIMEOUT = 30000;
  const t0 = Date.now();
  const allResults = { locations: [], bridges: [], crimeHeatmap: [], sourceMeta: {} };
  let completed = 0;
  let clientClosed = false;

  req.on('close', () => { clientClosed = true; });

  // Fire all sources in parallel — stream each result as it arrives
  const promises = sources.map(async (s) => {
    if (clientClosed) return;
    try {
      const data = await Promise.race([
        s.fn(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), TIMEOUT)),
      ]);
      const processed = processSourceResult(s.name, data);
      allResults.locations.push(...processed.locations);
      if (processed.bridges.length) allResults.bridges = processed.bridges;
      if (processed.crimeHeatmap.length) allResults.crimeHeatmap = processed.crimeHeatmap;
      allResults.sourceMeta[s.name] = { count: processed.count };
      completed++;
      if (!clientClosed) {
        send('source', {
          name: s.name, icon: s.icon, status: 'done',
          count: processed.count,
          locations: processed.locations,
          bridges: processed.bridges,
          crimeHeatmap: processed.crimeHeatmap,
          completed, total: sources.length,
          elapsed: Date.now() - t0,
        });
      }
    } catch (err) {
      completed++;
      allResults.sourceMeta[s.name] = { count: 0, error: err.message };
      if (!clientClosed) {
        send('source', {
          name: s.name, icon: s.icon, status: 'error',
          error: err.message, count: 0,
          locations: [], bridges: [], crimeHeatmap: [],
          completed, total: sources.length,
          elapsed: Date.now() - t0,
        });
      }
    }
  });

  await Promise.allSettled(promises);

  // Dedup and cache the combined results
  allResults.locations = utils.dedup(allResults.locations);
  allResults.totalSources = sources.length;
  allResults.totalLocations = allResults.locations.length;
  cache.set(cacheKey, allResults);

  if (!clientClosed) {
    send('done', {
      totalSources: sources.length,
      totalLocations: allResults.totalLocations,
      elapsed: Date.now() - t0,
    });
    res.end();
  }
});

// ── Individual source endpoints ────────────────────────────
app.get('/api/weather', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: 'Invalid coords' });

  const ck = `wx:${lat.toFixed(3)}:${lon.toFixed(3)}`;
  const cached = cache.get(ck);
  if (cached) return res.json(cached);

  try {
    const data = await weather.getWeather(lat, lon);
    cache.set(ck, data, config.cache.weather);
    res.json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/terrain', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: 'Invalid coords' });
  try {
    const data = await terrain.getTerrainInfo(lat, lon);
    res.json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/food-banks', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  const radius = Math.min(parseFloat(req.query.radius) || 10, 25) * 1609.34;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: 'Invalid coords' });
  try {
    const data = await grocery.findFoodBanks(lat, lon, radius);
    res.json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/stores', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).json({ error: 'Invalid coords' });
  try {
    const data = await grocery.findNearbyStores(lat, lon);
    res.json(data);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/foods', (req, res) => {
  const filters = {
    group: req.query.group || null,
    campFriendly: req.query.campFriendly === 'true',
    shelfStable: req.query.shelfStable === 'true',
    search: req.query.search || null,
  };
  res.json(grocery.getAllFoods(filters));
});

app.get('/api/meal-plan', (req, res) => {
  const budget = parseFloat(req.query.budget) || 20;
  const days = parseInt(req.query.days) || 3;
  const prefs = {
    campFriendlyOnly: req.query.campFriendly === 'true',
    shelfStableOnly: req.query.shelfStable === 'true',
    randomize: req.query.randomize === 'true',
  };
  res.json(grocery.optimizeMealPlan(budget, days, prefs));
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

// ── SPA fallback ───────────────────────────────────────────
app.get('*', (req, res) => {
  sendIndex(req, res);
});

// ── Start ──────────────────────────────────────────────────
const server = app.listen(config.port, config.host, () => {
  console.log(`[Maps.OpenVibe] 🗺️  maps.openvibe.tools listening on ${config.host}:${config.port}`);
});

// ── Graceful Shutdown ────────────────────────────────────────
function shutdown() {
    console.log('[Maps.OpenVibe] Shutting down...');
    analytics.destroy();
    analyticsDb.close();
    guard.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
