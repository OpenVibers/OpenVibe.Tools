'use strict';
const fs = require('node:fs');
const { createRuntime } = require('./runtime');
const { sign, MAX_FRAME } = require('./protocol');
async function main() {
    const dry = process.argv.includes('--dry-run');
    const gateway = new URL(process.env.TOOLS_GATEWAY || 'https://openvibe.tools');
    if (gateway.protocol !== 'https:' || gateway.username || gateway.password || gateway.pathname !== '/' || gateway.search || gateway.hash) throw new Error('gateway must be an HTTPS origin');
    if (dry) {
        const r = await fetch(new URL('/api/v1/workers/status', gateway), { signal: AbortSignal.timeout(15000) });
        const body = await r.json();
        if (!r.ok || body.protocol !== 1 || body.dry_run !== true) throw new Error('worker protocol unavailable');
        console.log('dry-run: production protocol 1 reachable; accepts_real_jobs=false');
        return;
    }
    const token = fs.readFileSync(process.env.TOOLS_WORKER_TOKEN_FILE, 'utf8').trim();
    const id = process.env.TOOLS_WORKER_ID;
    if (!/^wrk_[a-f0-9]{24}$/.test(id || '') || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('invalid worker credentials');
    const WebSocket = require('../../gateway/node_modules/ws');
    const runtime = createRuntime({ slots: Number(process.env.TOOLS_WORKER_SLOTS || 2) });
    let ws, timer, retry, stopping = false;
    const send = m => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
    const status = () => send({ type: 'status', ...runtime.status() });
    function connect() {
        const endpoint = new URL('/api/v1/workers/connect', gateway); endpoint.protocol = 'wss:';
        ws = new WebSocket(endpoint, { headers: sign(token, id), maxPayload: MAX_FRAME, perMessageDeflate: false, handshakeTimeout: 15000 });
        ws.on('open', () => { status(); timer = setInterval(status, 15000); });
        ws.on('message', async raw => {
            let m; try { m = JSON.parse(String(raw)); } catch { ws.close(); return; }
            if (m.type === 'cancel') return runtime.cancel(m.id);
            if (m.type !== 'job') return;
            const connection = ws;
            try {
                const result = await runtime.run({ id: m.id, type: m.jobType, input: m.input, files: m.files });
                if (ws === connection) send({ type: 'result', id: m.id, ok: true, result });
            } catch { if (ws === connection) send({ type: 'result', id: m.id, ok: false, error: 'worker job failed' }); }
            status();
        });
        ws.on('error', () => {}); // Never log a credential or server-supplied error.
        ws.on('close', () => { runtime.cancelAll(); clearInterval(timer); if (!stopping) retry = setTimeout(connect, 5000); });
    }
    async function stop() { stopping = true; clearTimeout(retry); clearInterval(timer); ws?.terminate(); await runtime.close(); }
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    connect();
}
if (require.main === module) main().catch(() => { console.error('Tools worker could not start; check configuration and gateway availability.'); process.exitCode = 1; });
module.exports = { main };
