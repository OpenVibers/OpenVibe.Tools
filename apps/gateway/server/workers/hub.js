'use strict';
const crypto = require('node:crypto');
const { MAX_FRAME, TYPES, verify } = require('../../../worker/server/protocol');
function createHub({ WebSocketServer, store, now = Date.now, heartbeatMs = 15000, staleMs = 45000 }) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false });
    const connections = new Map(), nonces = new Map();
    async function upgrade(req, socket, head) {
        if (req.url === '/api/v1/workers/dry-run') {
            wss.handleUpgrade(req, socket, head, ws => {
                ws.on('error', () => {});
                ws.send(JSON.stringify({ protocol: 1, dry_run: true, accepts_real_jobs: false }), () => ws.close());
                const deadline = setTimeout(() => ws.terminate(), 3000); deadline.unref();
                ws.once('close', () => clearTimeout(deadline));
            });
            return true; // Never registered, authenticated as a worker, or offered work.
        }
        if (req.url !== '/api/v1/workers/connect') return false;
        const deny = () => { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); };
        try {
            const id = req.headers['x-worker-id'];
            if (!/^wrk_[a-f0-9]{24}$/.test(id || '')) { deny(); return true; }
            const worker = await store.lookup(id);
            for (const [n, expiry] of nonces) if (expiry < now()) nonces.delete(n);
            const nonce = `${id}:${req.headers['x-worker-nonce']}`;
            if (!worker || !verify(worker.token_hash, req.headers, now()) || nonces.has(nonce)) { deny(); return true; }
            nonces.set(nonce, now() + 60000);
            wss.handleUpgrade(req, socket, head, ws => {
                const old = connections.get(id);
                if (old) old.ws.terminate();
                const c = { id, location: worker.location, draining: worker.draining, ws, last: now(), pending: new Map(), capabilities: [], tools: [], slots: 0, free: 0, load: 0, latency_ms: null };
                connections.set(id, c);
                const activity = () => { c.last = now(); };
                socket.on('data', activity); // A slow result may span several heartbeat intervals.
                ws.on('error', () => {});
                ws.on('message', raw => {
                    let m;
                    try { m = JSON.parse(String(raw)); } catch { ws.close(1008); return; }
                    if (m.type === 'status') {
                        if (m.tools === undefined) m.tools = []; // Older protocol-1 workers stay connected but receive no jobs.
                        if (!Array.isArray(m.tools) || m.tools.length > 128 || m.tools.some(t => typeof t !== 'string' || !/^(img|docs|audio)\.process:[a-z0-9-]{1,40}$/.test(t)) || !Array.isArray(m.capabilities) || m.capabilities.some(x => !TYPES.includes(x)) || !Number.isInteger(m.slots) || m.slots < 1 || m.slots > 8 || !Number.isInteger(m.free) || m.free < 0 || m.free > m.slots || !Number.isFinite(m.load) || m.load < 0) { ws.close(1008); return; }
                        Object.assign(c, { tools: m.dry ? [] : m.tools, capabilities: m.dry ? [] : [...new Set(m.capabilities)], slots: m.slots, free: m.dry ? 0 : m.free, load: m.load, last: now() });
                        ws.send(JSON.stringify({ type: 'heartbeat' })); // Also keeps the reverse proxy's upstream read deadline alive.
                    } else if (m.type === 'result') {
                        const p = c.pending.get(m.id);
                        if (!p) return;
                        c.pending.delete(m.id); clearTimeout(p.timer);
                        c.latency_ms = now() - p.started;
                        p.resolve(m);
                    } else ws.close(1008);
                });
                ws.on('close', () => {
                    socket.removeListener('data', activity);
                    if (connections.get(id) === c) connections.delete(id);
                    for (const p of c.pending.values()) { clearTimeout(p.timer); p.reject(Object.assign(new Error('worker disconnected'), { code: 'worker.disconnected' })); }
                    c.pending.clear();
                });
                ws.send(JSON.stringify({ type: 'ready', protocol: 1 }));
            });
        } catch { deny(); }
        return true;
    }
    const sweep = setInterval(async () => {
        for (const c of connections.values()) {
            try {
                c.ws.send(JSON.stringify({ type: 'heartbeat' }));
                const row = await store.lookup(c.id);
                if (!row || now() - c.last > staleMs) c.ws.terminate();
                else c.draining = row.draining;
            } catch { c.ws.terminate(); }
        }
    }, heartbeatMs);
    sweep.unref();
    function dispatch(c, job, signal) {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) return reject(new Error('cancelled'));
            const id = crypto.randomBytes(16).toString('hex');
            const cancel = () => { c.ws.send(JSON.stringify({ type: 'cancel', id })); finish(new Error('cancelled')); };
            const cleanup = () => { const p = c.pending.get(id); clearTimeout(p?.timer); c.pending.delete(id); signal?.removeEventListener('abort', cancel); };
            const finish = err => { cleanup(); reject(err); };
            const timer = setTimeout(() => { c.ws.terminate(); finish(new Error('worker timeout')); }, Math.min(job.timeoutMs || 900000, 900000));
            c.pending.set(id, { started: now(), timer, resolve: m => { signal?.removeEventListener('abort', cancel); resolve(m); }, reject: err => { signal?.removeEventListener('abort', cancel); reject(err); } });
            signal?.addEventListener('abort', cancel, { once: true });
            c.ws.send(JSON.stringify({ type: 'job', id, jobType: job.type, input: job.input, files: job.files }));
        });
    }
    return { upgrade, connections, dispatch, stats: () => [...connections.values()].map(({ id, location, draining, capabilities, slots, free, load, latency_ms }) => ({ id, location, draining, capabilities, slots, free, load, latency_ms })), close() { clearInterval(sweep); for (const c of connections.values()) c.ws.terminate(); wss.close(); } };
}
module.exports = { createHub };
