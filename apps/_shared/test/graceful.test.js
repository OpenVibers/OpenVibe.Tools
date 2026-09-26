'use strict';
// Graceful stop (roadmap WS-P lifecycle; apps/_shared/graceful.js). The helper on a plain server: a
// request in flight finishes and is told Connection: close, new connections are refused, idle
// keep-alive ones and event streams close, the steps run in order, a request that outlives the drain
// is cut, a stop that outlives the deadline exits 1. Then every Tools process (the gateway and the
// seven satellites, as systemd runs them): SIGTERM while a request is in flight, the request is
// answered, and the process exits 0 within the manifest's 5 s.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { gracefulStop } = require('../graceful');
const { startApp, freePort } = require('./spawn');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { log() {}, warn() {}, error() {} };

function listen(handler) {
    return new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });
}
/** A request whose body is sent in two halves; → { req, response: Promise<{ status, headers, body, at }>, finish() } */
function slowPost(port, p, headers = {}) {
    const body = Buffer.from(JSON.stringify({ probe: 'graceful-stop', pad: 'x'.repeat(64) }));
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', agent: false, headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, ...headers } });
    const response = new Promise((resolve, reject) => {
        req.on('response', (res) => { let b = ''; res.setEncoding('utf8'); res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b, at: Date.now() })); });
        req.on('error', reject);
    });
    req.write(body.subarray(0, 10));
    return { req, response, finish: () => req.end(body.subarray(10)) };
}
async function refused(port) {
    try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }); return false; } catch { return true; }
}

async function helperTests() {
    // 1. In flight finishes, idle keep-alive closes, steps in order, exit 0.
    {
        const order = [];
        let code = null;
        const server = await listen((req, res) => {
            if (req.url === '/slow') return setTimeout(() => { order.push('answered'); res.end('done'); }, 400);
            res.end('ok');
        });
        const port = server.address().port;
        const g = gracefulStop({ name: 't1', server, signals: false, log: quiet, exit: (c) => { code = c; }, stop: [() => order.push('stop')], close: [async () => { await sleep(10); order.push('close'); }] });
        const agent = new http.Agent({ keepAlive: true });
        await new Promise((r) => http.get({ port, path: '/', agent }, (res) => { res.resume(); res.on('end', r); }));   // leaves an idle keep-alive connection
        const slow = new Promise((resolve) => http.get({ port, path: '/slow', agent: false }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ b, connection: res.headers.connection })); }));
        await sleep(50);
        const t0 = Date.now();
        const stopped = g.stop('SIGTERM');
        await sleep(50);
        assert.ok(await refused(port), 'no new connections once stopping');
        const r = await slow;
        assert.strictEqual(r.b, 'done', 'the request in flight is answered');
        assert.strictEqual(r.connection, 'close', 'and told the connection closes');
        assert.strictEqual(await stopped, 0);
        const ms = Date.now() - t0;
        assert.ok(ms < 1500, `stopped once the request finished, not after the keep-alive timeout (${ms} ms)`);
        assert.deepStrictEqual(order, ['stop', 'answered', 'close']);
        assert.strictEqual(code, 0);
        assert.strictEqual(g.stopping(), true);
        agent.destroy();
    }
    // 2. An open event stream is closed at once (EventSource reconnects); the stop does not wait for it.
    {
        let code = null;
        const server = await listen((req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': hi\n\n'); });
        const port = server.address().port;
        const g = gracefulStop({ name: 't2', server, signals: false, log: quiet, drainMs: 3000, exit: (c) => { code = c; } });
        const ended = new Promise((resolve) => http.get({ port, path: '/events', agent: false }, (res) => { res.resume(); res.on('close', resolve); res.on('error', resolve); }));
        await sleep(50);
        const t0 = Date.now();
        await g.stop();
        await ended;
        assert.ok(Date.now() - t0 < 1000, 'the event stream did not hold the stop');
        assert.strictEqual(code, 0);
    }
    // 3. A request that outlives the drain is cut; the close steps still run; exit 0.
    {
        let code = null, closed = false;
        const server = await listen(() => { /* never answers */ });
        const port = server.address().port;
        const g = gracefulStop({ name: 't3', server, signals: false, log: quiet, drainMs: 300, exit: (c) => { code = c; }, close: [() => { closed = true; }] });
        const cut = new Promise((resolve) => { const q = http.get({ port, path: '/hang', agent: false }); q.on('error', resolve); q.on('response', resolve); });
        await sleep(50);
        const t0 = Date.now();
        await g.stop();
        await cut;
        const ms = Date.now() - t0;
        assert.ok(ms >= 280 && ms < 1500, `cut at the drain limit (${ms} ms)`);
        assert.ok(closed, 'close steps ran');
        assert.strictEqual(code, 0);
    }
    // 4. A step that hangs past the deadline: exit 1 at the deadline.
    {
        const server = await listen((req, res) => res.end());
        const exited = new Promise((resolve) => {
            gracefulStop({ name: 't4', server, signals: false, log: quiet, deadlineMs: 300, exit: resolve, stop: [() => new Promise(() => {})] }).stop();
        });
        const t0 = Date.now();
        assert.strictEqual(await exited, 1);
        assert.ok(Date.now() - t0 < 1000);
        server.close();
    }
}

async function processTests() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-graceful-'));
    // Food proxies its APIs to maps: a stand-in maps that answers slowly makes a request in flight.
    const maps = await listen((req, res) => {
        if (req.url.startsWith('/api/ready')) return res.end('{"status":"ready"}');
        setTimeout(() => { res.setHeader('Content-Type', 'application/json'); res.end('[]'); }, 800);
    });
    const mapsUrl = `http://127.0.0.1:${maps.address().port}`;
    const dirs = (a) => ({ DATA_DIR: path.join(tmp, a), UPLOADS_DIR: path.join(tmp, a, 'up'), OUTPUT_DIR: path.join(tmp, a, 'out') });
    const apps = [
        { app: 'gateway', env: { ...dirs('gateway'), TOOLS_REVOCATIONS_DB: path.join(tmp, 'revocations.db'), OV_DOMAINS_URL: 'http://127.0.0.1:9/api/domains', OV_REGISTRY_URL: 'http://127.0.0.1:9/registry', TOOLS_SATELLITE_PORTS: 'img=9,audio=9,docs=9,yt=9,text=9,maps=9,food=9' }, post: '/internal/events' },
        { app: 'img', env: dirs('img'), post: '/api/graceful-probe' },
        { app: 'audio', env: dirs('audio'), post: '/api/graceful-probe' },
        { app: 'docs', env: dirs('docs'), post: '/api/graceful-probe' },
        { app: 'yt', env: dirs('yt'), post: '/api/graceful-probe' },
        { app: 'text', env: dirs('text'), post: '/api/graceful-probe' },
        { app: 'maps', env: dirs('maps'), post: '/api/graceful-probe', readyPath: '/api/ready' },
        { app: 'food', env: { ...dirs('food'), MAPS_API: mapsUrl }, get: '/api/foods?q=rice', readyPath: '/api/ready' },
    ];
    const results = [];
    for (const a of apps) {
        const port = await freePort();
        const p = await startApp(a.app, a.env, port, a.readyPath ? { readyPath: a.readyPath } : undefined);
        try {
            let inflight;
            if (a.post) {
                inflight = slowPost(port, a.post);
            } else {
                const req = http.get({ host: '127.0.0.1', port, path: a.get, agent: false });
                inflight = { response: new Promise((resolve, reject) => { req.on('response', (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b, at: Date.now() })); }); req.on('error', reject); }), finish() {} };
            }
            await sleep(200);   // the request has reached the handler (its body is still coming, or maps is slow)
            const t0 = Date.now();
            const exited = p.kill('SIGTERM');
            await sleep(300);
            assert.ok(await refused(port), `${a.app}: no new connections once stopping`);
            inflight.finish();
            const r = await inflight.response;
            assert.ok(r.at > t0, `${a.app}: the request was still in flight at SIGTERM`);
            assert.ok(r.status >= 200 && r.status < 600, `${a.app}: answered (${r.status})`);
            assert.strictEqual(r.headers.connection, 'close', `${a.app}: told the connection closes`);
            const code = await exited;
            const ms = Date.now() - t0;
            assert.strictEqual(code, 0, `${a.app}: exit code 0\n${p.output().slice(-2000)}`);
            assert.ok(ms < 5000, `${a.app}: exited within the manifest's 5 s (${ms} ms)`);
            assert.match(p.output(), /stopped in \d+ ms/, `${a.app}: logged its stop`);
            results.push(`${a.app} ${ms} ms`);
        } catch (err) {
            p.kill('SIGKILL');
            throw err;
        }
    }
    maps.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    return results;
}

(async () => {
    await helperTests();
    const times = await processTests();
    console.log(`graceful stop: helper ok; SIGTERM → exit 0 with the request in flight answered: ${times.join(', ')}`);
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
