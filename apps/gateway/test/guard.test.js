'use strict';
// The guard on the gateway's own tools: the net tools count against their descriptor's class and
// cost, every tool that reaches a target is throttled per target across all callers, the port
// checker cannot sweep (per request and per caller, in report mode too), a webhook bin belongs to
// whoever made it (session cookie or token) and one address cannot fill the global cap, a principal
// needs tools.net.probe for probes, and the proxy to a satellite passes the one address it resolved.
// Mock resolver and transports: nothing touches a real network.
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const { EventEmitter } = require('events');
const contracts = require('openvibe-contracts');
const { createEgress } = require('../../_shared/egress');
const { createGuard, TRUST_PROXY } = require('../../_shared/guard');
const createNetRoutes = require('../server/net/routes');
const createDevRoutes = require('../server/dev/routes');
const { proxyTo } = require('../server/registry/host-middleware');

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const ISSUER = 'https://openvibe.network';
const t = () => Math.floor(Date.now() / 1000);
const svc = (cap) => contracts.serviceAuth.signServiceToken({ iss: ISSUER, sub: 'svc:partner', actor_type: 'service', aud: ['openvibe.tools'], cap, ns: [], iat: t(), exp: t() + 900, jti: `tok_${crypto.randomBytes(12).toString('hex')}` }, privateKey);

const lookup = (host, _opts, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }]);
const probes = [];
const egress = createEgress({
    lookup,
    tcpConnect: ({ host, port }) => { probes.push(`${host}:${port}`); const s = new EventEmitter(); s.setTimeout = () => {}; s.destroy = () => {}; s.end = () => {}; process.nextTick(() => s.emit('connect')); return s; },
    tlsConnect: () => { throw new Error('unused'); },
    httpRequest: () => { throw new Error('unused'); },
    httpsRequest: () => { throw new Error('unused'); },
});

async function serve(app) {
    const srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    return { base: `http://127.0.0.1:${srv.address().port}`, srv, close: () => new Promise(r => srv.close(r)) };
}

(async () => {
    const guard = createGuard({
        app: 'gateway', contracts, issuer: ISSUER, keys: { get: () => publicKey },
        specs: [...require('../server/net/descriptors').SPECS, ...require('../server/dev/descriptors').SPECS],
        env: { TOOLS_GUARD: 'report' }, log: { log() {}, warn() {}, error() {} }, pruneIntervalMs: 0,
    });
    const app = express();
    app.set('trust proxy', TRUST_PROXY);
    app.use(cookieParser());
    app.use(guard.identify);
    app.use('/api/net', createNetRoutes(null, null, { egress, guard }));
    app.use('/api/dev', createDevRoutes(null, null, { egress, guard }));
    const s = await serve(app);
    const get = (p, headers = {}) => fetch(s.base + p, { headers });
    const from = (ip, extra = {}) => ({ 'X-Forwarded-For': ip, ...extra });
    try {
        // ── Quota by descriptor: a ping is tools-probe at cost 3 ──
        let r = await get('/api/net/ping/one.example?count=1', from('198.51.100.1'));
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('ratelimit-limit'), '15', 'tools-probe, anonymous: a bucket of 15');
        assert.strictEqual(r.headers.get('ratelimit-remaining'), '12', 'one ping costs 3');

        // ── Per-target throttle: ping 6 a minute against one host, whoever asks, in report mode too ──
        const codes = [];
        for (let i = 2; i <= 7; i++) codes.push((await get('/api/net/ping/ONE.example.?count=1', from(`198.51.100.${i}`))).status);
        assert.deepStrictEqual(codes, [200, 200, 200, 200, 200, 429]);
        r = await get('/api/net/headers/https%3A%2F%2Fone.example%2Fpath', from('198.51.100.30'));
        assert.strictEqual(r.status, 429, 'other tools share the host\'s budget');
        const body = await r.json();
        assert.deepStrictEqual([body.code, body.scope], ['tools.quota.exceeded', 'target']);
        assert.ok(Number(r.headers.get('retry-after')) >= 1);
        assert.strictEqual((await get('/api/net/ping/two.example?count=1', from('198.51.100.2'))).status, 200, 'another host is fine');

        // ── The port checker: per request, per caller ──
        const ports = (n, base = 1000) => Array.from({ length: n }, (_, i) => base + i).join(',');
        r = await get(`/api/net/port/three.example?ports=${ports(21)}`, from('198.51.100.50'));
        assert.strictEqual(r.status, 400, 'more than 20 ports is refused, not silently cut');
        probes.length = 0;
        for (let i = 0; i < 5; i++) {
            r = await get(`/api/net/port/h${i}.example?ports=${ports(20)}`, from('198.51.100.51'));
            assert.strictEqual(r.status, 200, `check ${i + 1}`);
        }
        assert.strictEqual(probes.length, 100);
        r = await get('/api/net/port/h9.example?ports=22', from('198.51.100.51'));
        assert.strictEqual(r.status, 429, 'the 101st port in ten minutes is refused (a hard limit)');
        assert.strictEqual((await r.json()).scope, 'ports');
        assert.strictEqual(probes.length, 100, 'nothing was dialled');

        // ── Probes through the API need tools.net.probe (report mode records, enforce refuses) ──
        r = await get('/api/net/ping/four.example?count=1', { Authorization: `Bearer ${svc(['tools.tool.run'])}` });
        assert.strictEqual(r.status, 200, 'report mode: recorded, not refused');
        assert.ok(guard.store.abuseRows().some(x => x.reason === 'capability' && x.principal === 'svc:partner' && x.tool === 'ping'));
        r = await get('/api/net/ping/five.example?count=1', { Authorization: `Bearer ${svc(['tools.net.probe'])}` });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.headers.get('ratelimit-limit'), '300', 'the service tier');

        // ── Webhook bins belong to their maker ──
        r = await fetch(`${s.base}/api/dev/webhook/bins`, { method: 'POST', headers: from('203.0.113.10') });
        const made = await r.json();
        const cookie = String(r.headers.get('set-cookie') || '').split(';')[0];
        assert.match(cookie, /^ov_tools_jobs=/, 'the maker gets a session');
        assert.ok(made.ok && made.binId);
        await fetch(`${s.base}/api/dev/webhook/bins/${made.binId}/in`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"hello":1}' });
        r = await get(`/api/dev/webhook/bins/${made.binId}`, { cookie });
        assert.strictEqual(r.status, 200);
        assert.strictEqual((await r.json()).requestCount, 1, 'the maker reads it');
        r = await get(`/api/dev/webhook/bins/${made.binId}`, from('203.0.113.10'));
        assert.strictEqual(r.status, 404, 'anyone else (even from the same address) gets 404');
        r = await get(`/api/dev/webhook/bins/${made.binId}`, { cookie: `ov_tools_jobs=${crypto.randomBytes(24).toString('base64url')}` });
        assert.strictEqual(r.status, 404, 'another session gets 404');
        r = await fetch(`${s.base}/api/dev/webhook/bins/${made.binId}`, { method: 'DELETE', headers: from('203.0.113.99') });
        assert.strictEqual((await r.json()).deleted, false, 'and cannot delete it');
        assert.strictEqual((await get(`/api/dev/webhook/bins/${made.binId}`, { cookie })).status, 200, 'still there');
        r = await fetch(`${s.base}/api/dev/webhook/bins/${made.binId}`, { method: 'DELETE', headers: { cookie } });
        assert.strictEqual((await r.json()).deleted, true, 'the maker can');

        // Caps: per owner and per address (report mode records; a guard in enforce mode refuses).
        const enforce = createGuard({ app: 'gateway', contracts, issuer: ISSUER, keys: { get: () => publicKey }, specs: require('../server/dev/descriptors').SPECS, env: { TOOLS_GUARD: 'enforce' }, log: { log() {}, warn() {}, error() {} }, pruneIntervalMs: 0 });
        const app2 = express();
        app2.set('trust proxy', TRUST_PROXY);
        app2.use(cookieParser());
        app2.use('/api/dev', createDevRoutes(null, null, { egress, guard: enforce }));
        const s2 = await serve(app2);
        try {
            const make = (headers) => fetch(`${s2.base}/api/dev/webhook/bins`, { method: 'POST', headers });
            const first = await make(from('203.0.113.20'));
            const c1 = String(first.headers.get('set-cookie')).split(';')[0];
            const mine = [first.status];
            for (let i = 0; i < 5; i++) mine.push((await make({ ...from('203.0.113.20'), cookie: c1 })).status);
            assert.deepStrictEqual(mine, [200, 200, 200, 200, 200, 429], 'five bins per owner');
            const fresh = [];
            for (let i = 0; i < 6; i++) fresh.push((await make(from('203.0.113.20'))).status);   // a new cookie every time
            assert.deepStrictEqual(fresh, [200, 200, 200, 200, 200, 429], 'ten per address, whatever cookie is shown');
            assert.strictEqual((await make(from('203.0.113.21'))).status, 200, 'another address is fine');
        } finally { await s2.close(); enforce.close(); }

        // ── The proxy to a satellite: the one address the gateway resolved, nothing a client sent ──
        let seen = null;
        const sat = http.createServer((req, res) => { seen = req.headers; res.end('ok'); });
        await new Promise(r => sat.listen(0, '127.0.0.1', r));
        const front = express();
        front.set('trust proxy', TRUST_PROXY);
        front.use((req, res) => proxyTo(sat.address().port, { tool: 'png', role: 'canonical', canonicalHost: 'png.openvibe.tools', shortHost: 'png.openvibe.tools', host: 'png.openvibe.tools' }, req, res));
        const f = await serve(front);
        try {
            await fetch(`${f.base}/x`, { headers: { 'X-Forwarded-For': '6.6.6.6, 203.0.113.5', 'CF-Connecting-IP': '6.6.6.6' } });
            assert.strictEqual(seen['x-forwarded-for'], '203.0.113.5', 'one address: the one nginx gave');
            assert.strictEqual(seen['x-real-ip'], '203.0.113.5');
            assert.strictEqual(seen['cf-connecting-ip'], '203.0.113.5');
        } finally { await f.close(); await new Promise(r => sat.close(r)); }
    } finally {
        await s.close();
        guard.close();
    }
    console.log('gateway guard: net quotas by descriptor, per-target throttle across tools and callers, port cap, probe capability, webhook bin ownership and caps, proxy address: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
