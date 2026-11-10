'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { execFileSync, spawnSync } = require('node:child_process');
const WebSocket = require('../../gateway/node_modules/ws');
const { createHub } = require('../../gateway/server/workers/hub');
const { sign, hash } = require('../server/protocol');
const { createRuntime } = require('../server/runtime');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tools-worker-test-'));
    let hub, server, runtime;
    try {
        const token = crypto.randomBytes(32).toString('base64url'), id = `wrk_${crypto.randomBytes(12).toString('hex')}`;
        hub = createHub({ WebSocketServer: WebSocket.WebSocketServer, heartbeatMs: 50, staleMs: 400, store: { lookup: async () => ({ token_hash: hash(token), location: 'home', draining: false }) } });
        server = http.createServer(); server.on('upgrade', (req, socket, head) => hub.upgrade(req, socket, head));
        server.listen(0, '127.0.0.1'); await once(server, 'listening');
        const base = `ws://127.0.0.1:${server.address().port}`;
        const dry = new WebSocket(base + '/api/v1/workers/dry-run');
        const [raw] = await once(dry, 'message');
        assert.deepEqual(JSON.parse(String(raw)), { protocol: 1, dry_run: true, accepts_real_jobs: false });
        assert.equal(hub.connections.size, 0, 'dry sockets never enter dispatch candidates');
        const ws = new WebSocket(base + '/api/v1/workers/connect', { headers: sign(token, id) });
        await once(ws, 'open');
        const status = JSON.stringify({ type: 'status', capabilities: ['img.process'], tools: ['img.process:convert'], slots: 2, free: 2, load: 0, padding: 'x'.repeat(1000) });
        for (let n = 0; n < status.length; n += 100) {
            ws.send(status.slice(n, n + 100), { fin: n + 100 >= status.length });
            await sleep(70);
        }
        assert.equal(ws.readyState, WebSocket.OPEN, 'partial frame bytes keep a slow upload alive beyond stale interval');
        assert.equal(hub.stats()[0].free, 2);
        ws.terminate();
        runtime = createRuntime({ slots: 2, root });
        const sharp = require('../../img/node_modules/sharp');
        const bytes = (await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer()).toString('base64');
        const results = await Promise.all([1, 2].map(() => runtime.run({ id: crypto.randomBytes(16).toString('hex'), type: 'img.process', input: { tool: 'convert', format: 'png' }, files: [{ name: 'sample.png', bytes }] })));
        assert.equal(results.length, 2, 'advertised slots support simultaneous image work');
        assert(results.every(r => r.files[0].mime === 'image/png'));
        const wav = Buffer.alloc(44 + 1600);
        wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
        wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
        wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
        wav.write('data', 36); wav.writeUInt32LE(1600, 40);
        const audio = await runtime.run({ id: crypto.randomBytes(16).toString('hex'), type: 'audio.process', input: { tool: 'convert', format: 'wav' }, files: [{ name: 'sample.wav', bytes: wav.toString('base64') }] });
        assert.equal(audio.files[0].name, 'sample.wav');
        assert(audio.files[0].bytes.length > 0, 'worker uses the existing hardened audio path');
        const page = require('../../gateway/server/pages/site').pageWorkers();
        assert.match(page, /Run Tools on your own machine/);
        assert.match(page, /--dry-run --prefix/);
        const installer = path.resolve(__dirname, '../install.sh');
        execFileSync('bash', ['-n', installer]);
        assert.notEqual(spawnSync('bash', [installer, '--dry-run', '--prefix', root], { encoding: 'utf8' }).status, 0, 'dry installation cannot overwrite an existing directory');
        console.log('worker setup: dry WebSocket accepts no jobs; slow uploads survive; two slots execute; shared audio guard reused; installer guards passed');
    } finally {
        if (runtime) await runtime.close();
        if (hub) hub.close();
        if (server) await new Promise(r => server.close(r));
        await fs.rm(root, { recursive: true, force: true });
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
