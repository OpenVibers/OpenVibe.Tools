'use strict';
const os = require('node:os');
function createAdmin({ express, guard, store, hub, ports, fetchImpl = fetch, now = Date.now }) {
    const router = express.Router();
    router.use(guard);
    router.use(express.json({ limit: '4kb' }));
    async function host() {
        const samples = await Promise.all(['img', 'docs', 'audio', 'yt'].map(async app => {
            const port = Number(ports[app]);
            if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
            try {
                const r = await fetchImpl(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
                const jobs = (await r.json()).jobs;
                const active = jobs?.executing ?? jobs?.running;
                return r.ok && Number.isInteger(jobs?.concurrency) && Number.isInteger(active) ? { slots: jobs.concurrency, active } : null;
            } catch { return null; }
        }));
        const known = samples.filter(Boolean), complete = known.length === samples.length;
        return { id: 'host', label: 'Host fallback', location: 'host', online: known.length > 0, draining: false, revoked: false, slots: complete ? known.reduce((n, s) => n + s.slots, 0) : null, free: complete ? known.reduce((n, s) => n + Math.max(0, s.slots - s.active), 0) : null, active_jobs: complete ? known.reduce((n, s) => n + s.active, 0) : null, load: os.loadavg()[0], latency_ms: null };
    }
    router.get('/workers', async (_req, res) => {
        try {
            const day = new Date(now()).toISOString().slice(0, 10);
            const [rows, config, counts, local] = await Promise.all([store.list(), store.routing(), store.daily(day), host()]);
            const online = new Map(hub.stats().map(c => [c.id, c]));
            const daily = new Map(counts.map(c => [c.worker_id, Number(c.jobs)]));
            const workers = [local, ...rows.map(row => ({ ...row, online: online.has(row.id), slots: 0, free: 0, load: null, latency_ms: null, active_jobs: 0, ...online.get(row.id) }))].map(w => ({ ...w, jobs_today: daily.get(w.id) || 0 }));
            res.json({ workers, routing: { enabled: config.enabled, order: JSON.parse(config.worker_order) }, day, counts: 'execution_attempts' });
        } catch { res.status(503).json({ error: 'Worker registry unavailable' }); }
    });
    router.get('/worker-routing', async (_req, res) => {
        try { const r = await store.routing(); res.json({ enabled: r.enabled, order: JSON.parse(r.worker_order) }); }
        catch { res.status(503).json({ error: 'Worker registry unavailable' }); }
    });
    router.put('/worker-routing', async (req, res) => {
        try { res.json(await store.setRouting(req.body || {})); }
        catch { res.status(400).json({ error: 'Invalid worker routing' }); }
    });
    router.post('/workers', async (req, res) => {
        try { res.status(201).json(await store.mint(req.body || {})); }
        catch { res.status(400).json({ error: 'Could not create worker' }); }
    });
    router.put('/workers/:id/drain', async (req, res) => {
        try {
            const row = await store.drain(req.params.id, req.body?.draining);
            const connection = hub.connections.get(row.id);
            if (connection) connection.draining = row.draining;
            res.json(row);
        } catch { res.status(400).json({ error: 'Invalid worker drain request' }); }
    });
    router.delete('/workers/:id', async (req, res) => {
        try { const row = await store.revoke(req.params.id); hub.connections.get(row.id)?.ws.terminate(); res.json({ id: row.id, revoked: true }); }
        catch { res.status(400).json({ error: 'Invalid worker revocation' }); }
    });
    return router;
}
module.exports = { createAdmin };
