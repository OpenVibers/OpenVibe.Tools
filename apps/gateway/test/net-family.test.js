'use strict';
// Network diagnostics family acceptance (roadmap WS-L task 6): every net tool, taken from the registry
// rather than from a hand-picked list, is held to three things.
//   • registry  it has a tools.tool@1 entry in the net family, served on <id>.openvibe.tools, with an
//               input schema and a route when it is available and a reason when it is not; probes
//               need tools.net.probe and every tool that reaches a chosen host has a per-target throttle
//   • help      its page has help content: name, title, description, an intro, at least two bullets
//               and a FAQ (an unavailable tool also says why it is unavailable)
//   • egress    called with this machine, a private network, the cloud metadata address or a name that
//               resolves to one, it never connects there; a tool that connects to a public target
//               refuses these with 403 tools.net.target_not_public. Every connection goes through the
//               egress guard: a direct net/tls socket or a system DNS lookup fails the test, and no
//               upstream request goes to a private host.
// Resolver, transports and upstream fetch are mocks: nothing here touches a real network.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dnsMod = require('dns');
const netMod = require('net');
const tlsMod = require('tls');
const express = require('express');
const { EventEmitter } = require('events');
const { Readable } = require('stream');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-net-family-'));

// ── The world: a public name, names that resolve to internal addresses ──
const DNS = { 'public.example': ['93.184.216.34'], 'rebind.example': ['127.0.0.1'], 'meta.example': ['169.254.169.254'] };
const PUBLIC_IP = '93.184.216.34';
const nx = () => Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
const noData = () => Object.assign(new Error('no data'), { code: 'ENODATA' });

// System DNS and raw sockets outside the egress guard are violations: record them.
const violations = [];
const answer4 = async (host) => { if (DNS[host]) return DNS[host]; throw nx(); };
const answerNone = async () => { throw noData(); };
for (const [k, fn] of Object.entries({ resolve4: answer4, resolve6: answerNone, resolveMx: answerNone, resolveTxt: answerNone, resolveNs: answerNone, resolveCname: answerNone, resolveSoa: answerNone, resolveAny: answerNone,
    resolve: async (host, type = 'A') => (type === 'A' ? answer4(host) : answerNone()), reverse: async () => [], lookup: async (host) => { if (DNS[host]) return { address: DNS[host][0], family: 4 }; throw nx(); } })) {
    dnsMod.promises[k] = fn;
}
class MockResolver {
    constructor() { Object.assign(this, { resolve4: answer4, resolve6: answerNone, resolveMx: answerNone, resolveTxt: answerNone, resolveNs: answerNone, resolveCname: answerNone, resolveSoa: answerNone, resolve: dnsMod.promises.resolve, reverse: async () => [] }); }
    setServers() {}
    cancel() {}
}
dnsMod.promises.Resolver = MockResolver;
// Only this test's own server (an IP literal on a known port) may be looked up and connected to directly.
const own = { port: null };
const realLookup = dnsMod.lookup;
dnsMod.lookup = (host, opts, cb) => {
    if (netMod.isIP(host)) return realLookup(host, opts, cb);
    if (typeof opts === 'function') cb = opts;
    violations.push(`dns.lookup ${host}`);
    process.nextTick(() => cb(nx()));
};
for (const [mod, names] of [[netMod, ['connect', 'createConnection']], [tlsMod, ['connect']]]) {
    for (const n of names) {
        const real = mod[n].bind(mod);
        mod[n] = (...a) => {
            const o = a[0] && typeof a[0] === 'object' ? a[0] : { port: a[0], host: a[1] };
            if (mod === netMod && own.port && Number(o.port) === own.port && ['127.0.0.1', undefined].includes(o.host)) return real(...a);
            violations.push(`${n} ${JSON.stringify(o).slice(0, 80)}`);
            throw new Error('a direct socket outside the egress guard');
        };
    }
}

// Every connection the egress guard makes, by the address actually dialled.
const dialled = [];
function fakeSocket(address, { secure = false } = {}) {
    const s = new EventEmitter();
    s.setTimeout = () => {}; s.setNoDelay = () => {}; s.setKeepAlive = () => {}; s.write = () => true; s.setEncoding = () => {};
    let closed = false;
    const close = () => { if (!closed) { closed = true; s.emit('end'); s.emit('close', false); } };
    s.destroy = close; s.end = close;
    s.getPeerCertificate = () => ({}); s.getProtocol = () => 'TLSv1.3'; s.getCipher = () => null; s.authorized = false;
    // Like a real peer: connect (and the TLS handshake), a greeting line, then the peer hangs up.
    process.nextTick(() => {
        s.emit('connect');
        if (secure) s.emit('secureConnect');
        setTimeout(() => { if (!closed) s.emit('data', Buffer.from('220 mock ready\r\n')); setTimeout(close, 5); }, 5);
    });
    dialled.push(address);
    return s;
}
function fakeHttp(opts, cb) {
    const req = new EventEmitter();
    req.destroy = () => {}; req.setTimeout = () => {}; req.write = () => {};
    req.end = () => {
        const reply = (address) => {
            dialled.push(address);
            const res = Readable.from([Buffer.from('User-agent: *\nDisallow:\n')]);
            Object.assign(res, { statusCode: 200, statusMessage: 'OK', headers: { server: 'mock', 'content-type': 'text/plain' } });
            cb(res);
        };
        if (opts.lookup) opts.lookup(opts.hostname, {}, (err, address) => (err ? req.emit('error', err) : reply(address)));
        else reply(opts.hostname);
    };
    return req;
}
const { createEgress } = require('../../_shared/egress');
const egress = createEgress({
    lookup: (host, _o, cb) => (DNS[host] ? cb(null, DNS[host].map((address) => ({ address, family: 4 }))) : cb(nx())),
    tcpConnect: ({ host }) => fakeSocket(host),
    tlsConnect: (o, onSecure) => { const s = fakeSocket(o.host, { secure: true }); if (onSecure) s.once('secureConnect', onSecure); return s; },
    httpRequest: fakeHttp,
    httpsRequest: fakeHttp,
});
// Fixed upstreams (IP data, RDAP, DoH): recorded, answered 503.
const upstream = [];
const upstreamFetch = async (url) => { upstream.push(String(url)); return new Response('{}', { status: 503, headers: { 'Content-Type': 'application/json' } }); };
const resolverFor = () => new MockResolver();

const contracts = require('openvibe-contracts');
const reg = require('../server/registry/descriptors');
const { SPECS } = require('../server/net/descriptors');
const { NET_TOOL_MAP } = require('../server/net/config');
const { seoFor } = require('../server/seo/catalog');
const createNetRoutes = require('../server/net/routes');

const INTERNAL = ['127.0.0.1', '169.254.169.254', '10.0.0.8', '192.168.1.1', 'localhost', 'rebind.example', 'meta.example'];
const isInternalAddr = (a) => /^(127\.|10\.|192\.168\.|169\.254\.|0\.|::1$|\[::1\]$|localhost$)/.test(String(a));
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };

(async () => {
    // ── Registry ──
    const snap = reg.snapshot();
    const byId = new Map(snap.tools.map((d) => [d.id, d]));
    const family = snap.tools.filter((d) => d.family === 'net');
    assert.strictEqual(family.length, SPECS.length, 'every net tool is in the registry');
    for (const s of SPECS) {
        const d = byId.get(s.id);
        assert.ok(d, `${s.id}: registry entry`);
        assert.strictEqual(d.family, 'net', `${s.id}: net family`);
        assert.ok((d.hosts || []).includes(`${s.id}.openvibe.tools`), `${s.id}: served on its own host`);
        assert.ok(contracts.validate('tools.tool@1', d).valid, `${s.id}: a valid tools.tool@1`);
        if (s.api) {
            assert.ok(d.input && d.input.type === 'object', `${s.id}: input schema`);
            assert.ok(s.route && /^\/api\/net\//.test(s.route.path), `${s.id}: runs through a net route`);
        } else {
            assert.strictEqual(d.status, 'unavailable', `${s.id}: no API means unavailable`);
            assert.ok(String(NET_TOOL_MAP.get(s.id).unavailable || '').length > 20, `${s.id}: says why it is unavailable`);
        }
        if (s.auth.capability === 'tools.net.probe') assert.ok(!s.auth.anonymous, `${s.id}: a probe is never anonymous`);
        if (s.egress && s.api) assert.ok(s.limits.perTargetPerMinute > 0, `${s.id}: per-target throttle`);
    }

    // ── Help ──
    const helpProblems = [];
    for (const s of SPECS) {
        const h = seoFor(s.id);
        if (!h) { helpProblems.push(`${s.id}: no help page record`); continue; }
        for (const [k, min] of [['name', 2], ['title', 10], ['desc', 40], ['about', 40]]) if (!(typeof h[k] === 'string' && h[k].trim().length >= min)) helpProblems.push(`${s.id}: help ${k}`);
        if (String(h.desc || '').length > 200) helpProblems.push(`${s.id}: description longer than a search snippet (${h.desc.length})`);
        if (!(Array.isArray(h.bullets) && h.bullets.length >= 2)) helpProblems.push(`${s.id}: fewer than two bullets`);
        if (!(Array.isArray(h.faq) && h.faq.length >= 1 && h.faq.every(([q, a]) => q && a && q.length > 5 && a.length > 20))) helpProblems.push(`${s.id}: no FAQ with answers`);
    }
    assert.deepStrictEqual(helpProblems, [], `help content:\n  ${helpProblems.join('\n  ')}`);
    console.log(`registry and help: ${SPECS.length} net tools ok`);

    // ── Egress ──
    const app = express();
    app.use('/api/net', createNetRoutes(null, null, { egress, resolverFor, fetch: upstreamFetch, reverse: async () => [], tlsUpgrade: (o, onSecure) => { const s = fakeSocket(o.host || 'tls-upgrade', { secure: true }); if (onSecure) s.once('secureConnect', onSecure); return s; } }));
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    own.port = srv.address().port;
    const base = `http://127.0.0.1:${own.port}`;
    const pathFor = (s, t) => {
        const q = new URLSearchParams(s.route.query || {});
        const target = s.route.target ? s.route.target.replace('{target}', t).replace('{selector}', 'default') : t;
        q.set('target', target);
        if (s.id === 'ping') q.set('count', '1');
        if (s.id === 'port') q.set('ports', '443,8080');
        return `${s.route.path}?${q}`;
    };
    const get = async (p) => {
        const r = await fetch(base + p, { signal: AbortSignal.timeout(45000) }).catch((err) => { throw new Error(`${p}: ${err.message}`); });
        let body = null; try { body = await r.json(); } catch { /* not json */ }
        return { status: r.status, body };
    };

    const connecting = [];
    for (const s of SPECS.filter((x) => x.api && x.egress)) {
        // Does it connect to the target itself? Ask about a public one.
        dialled.length = 0;
        await get(pathFor(s, 'public.example'));
        const connects = dialled.includes(PUBLIC_IP);
        if (connects) connecting.push(s.id);
        for (const t of INTERNAL) {
            dialled.length = 0; upstream.length = 0;
            const r = await get(pathFor(s, t));
            assert.deepStrictEqual(dialled.filter(isInternalAddr), [], `${s.id} ${t}: never dialled an internal address (${dialled.join(', ')})`);
            assert.deepStrictEqual(upstream.filter((u) => isInternalAddr(hostOf(u)) || /\.example$/.test(hostOf(u))), [], `${s.id} ${t}: no upstream request to the target's host`);
            if (connects) {
                assert.strictEqual(r.status, 403, `${s.id} ${t}: refused (${r.status} ${JSON.stringify(r.body).slice(0, 200)})`);
                assert.strictEqual(r.body && r.body.code, 'tools.net.target_not_public', `${s.id} ${t}: the egress refusal code`);
            }
        }
    }
    assert.deepStrictEqual(violations, [], `connections outside the egress guard:\n  ${violations.join('\n  ')}`);
    // The tools that connect to what they are asked about must be found as such (the classification works).
    for (const id of ['port', 'ping', 'latency', 'headers', 'curl', 'httpstatus', 'redirects', 'ssl', 'uptime', 'robots', 'sitemap', 'smtp', 'lookup']) {
        assert.ok(connecting.includes(id), `${id} connects to a public target (connecting: ${connecting.join(', ')})`);
    }
    // myip reaches nothing.
    dialled.length = 0; upstream.length = 0;
    await get('/api/net/myip');
    assert.deepStrictEqual([dialled, upstream], [[], []], 'myip makes no outbound request');
    srv.close();
    console.log(`egress: ${SPECS.filter((x) => x.api && x.egress).length} tools × ${INTERNAL.length} internal targets, ${connecting.length} connecting tools refused them`);
    console.log('net family acceptance: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
