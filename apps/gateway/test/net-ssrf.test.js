'use strict';
// SSRF regression: every Net.OpenVibe / Dev.OpenVibe tool that connects to a visitor's target
// refuses loopback, private, link-local (metadata), CGNAT, … targets with 403, including a name
// that resolves to one and a redirect to one; a public target still works. The resolver and the
// transports are mocks: nothing here touches a real network.
const assert = require('assert');
const express = require('express');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const { createEgress } = require('../../_shared/egress');
const createNetRoutes = require('../server/net/routes');
const createDevRoutes = require('../server/dev/routes');

const DNS = {
    'public.example': ['93.184.216.34'],
    'redirector.example': ['93.184.216.35'],
    'rebind.example': ['127.0.0.1'],
    'meta.example': ['169.254.169.254'],
    'lan.example': ['192.168.1.20'],
};
const lookup = (host, _opts, cb) => {
    const a = DNS[host];
    if (!a) return cb(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }));
    cb(null, a.map(address => ({ address, family: 4 })));
};

// Every connection attempt, by the address actually dialled.
const dialled = [];
function fakeSocket(address) {
    const s = new EventEmitter();
    s.setTimeout = () => {}; s.destroy = () => {}; s.end = () => {};
    process.nextTick(() => s.emit('connect'));
    dialled.push(address);
    return s;
}
function fakeHttp(opts, cb) {
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => {
        const answer = (address) => {
            dialled.push(address);
            const redirects = { '/to-loopback': 'http://127.0.0.1:3000/admin', '/to-rebind': 'http://rebind.example:4000/', '/to-meta': 'http://169.254.169.254/latest/meta-data/', '/to-public': 'https://public.example/' };
            const loc = opts.hostname === 'redirector.example' && redirects[opts.path];
            const res = Readable.from(loc ? [] : [Buffer.from('<html><head><meta property="og:title" content="Hello"><title>t</title></head></html>')]);
            Object.assign(res, loc
                ? { statusCode: 302, statusMessage: 'Found', headers: { location: loc } }
                : { statusCode: 200, statusMessage: 'OK', headers: { server: 'mock', 'content-type': 'text/html', 'strict-transport-security': 'max-age=1' } });
            cb(res);
        };
        // Like a real socket: a name goes through the (pinned) lookup, a literal is dialled as is.
        if (opts.lookup) opts.lookup(opts.hostname, {}, (err, address) => err ? req.emit('error', err) : answer(address));
        else answer(opts.hostname);
    };
    return req;
}
const egress = createEgress({
    lookup,
    tcpConnect: ({ host }) => fakeSocket(host),
    tlsConnect: (opts) => { const s = fakeSocket(opts.host); s.getPeerCertificate = () => ({}); return s; },
    httpRequest: fakeHttp,
    httpsRequest: fakeHttp,
});

(async () => {
    const app = express();
    // DNS answers for the SMTP tool's MX lookup (none: the name itself is dialled) come from a mock too.
    const noDns = () => { const no = () => Promise.reject(Object.assign(new Error('ENODATA'), { code: 'ENODATA' })); return { resolveMx: no, resolve4: no, resolveTxt: no, resolve: no }; };
    app.use('/api/net', createNetRoutes(null, null, { egress, resolverFor: noDns }));
    app.use('/api/dev', createDevRoutes(null, null, { egress }));
    const srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${srv.address().port}`;
    const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
    const q = encodeURIComponent;

    // ── Refused: hosts and URLs that mean this machine or a private network ──
    const hosts = ['localhost', '127.0.0.1', '[::1]', '::1', '10.0.0.8', '192.168.1.1', '172.20.0.5', '169.254.169.254', '100.64.0.1',
        '0.0.0.0', '::ffff:127.0.0.1', 'fd00::1', '2130706433', 'rebind.example', 'meta.example', 'lan.example'];
    for (const h of hosts) {
        for (const path of [`/api/net/port?target=${q(h)}&ports=3000,4000,4910,8000`, `/api/net/ping?target=${q(h)}&count=1`,
            `/api/net/ssl?target=${q(h)}`, `/api/net/lookup?target=${q(h)}`, `/api/net/smtp?target=${q(h)}&port=25`]) {
            dialled.length = 0;
            const r = await get(path);
            assert.equal(r.status, 403, `${path} → ${r.status} ${JSON.stringify(r.body)}`);
            assert.equal(r.body.ok, false);
            assert.equal(r.body.code, 'tools.net.target_not_public');
            assert.match(r.body.error, /not a public internet address/);
            assert.deepEqual(dialled, [], `${path} made no connection`);
        }
    }
    const urls = ['http://localhost:3000/', 'http://127.0.0.1:4000/api', 'http://[::1]:8000/', 'http://10.1.1.1/', 'http://192.168.0.1/',
        'http://169.254.169.254/latest/meta-data/', 'https://rebind.example/', 'http://meta.example/', 'http://0x7f000001:3000/', 'localhost:4100'];
    for (const u of urls) {
        for (const path of [`/api/net/headers?target=${q(u)}`, `/api/net/redirects?target=${q(u)}`, `/api/dev/opengraph?url=${q(u)}`,
            `/api/net/robots?target=${q(u)}`, `/api/net/sitemap?target=${q(u)}`, `/api/net/uptime?target=${q(u)}`]) {
            dialled.length = 0;
            const r = await get(path);
            assert.equal(r.status, 403, `${path} → ${r.status} ${JSON.stringify(r.body)}`);
            assert.match(r.body.error, /not a public internet address/);
            assert.deepEqual(dialled, [], `${path} made no connection`);
        }
    }
    for (const s of ['127.0.0.1', '10.0.0.53:53', '[::1]:53', '169.254.169.254']) {
        const r = await get(`/api/net/dns?target=example.com&server=${q(s)}`);
        assert.equal(r.status, 403, `dns server ${s}`);
    }
    assert.equal((await get('/api/net/dns?target=example.com&server=resolver.example')).status, 400, 'a DNS server must be an IP');
    console.log('internal targets refused: ok');

    // ── Redirects to internal addresses are re-checked and never dialled ──
    for (const hop of ['/to-loopback', '/to-rebind', '/to-meta']) {
        dialled.length = 0;
        const r = await get(`/api/net/redirects?target=${q(`https://redirector.example${hop}`)}`);
        assert.equal(r.status, 200);
        assert.equal(r.body.chain.length, 2);
        assert.equal(r.body.chain[0].status, 302);
        assert.equal(r.body.chain[1].refused, true);
        assert.match(r.body.stopped, /not a public internet address/);
        assert.deepEqual(dialled, ['93.184.216.35'], `${hop}: only the public hop was dialled`);

        dialled.length = 0;
        const og = await get(`/api/dev/opengraph?url=${q(`https://redirector.example${hop}`)}`);
        assert.equal(og.status, 403, `opengraph ${hop}`);
        assert.deepEqual(dialled, ['93.184.216.35']);

        for (const tool of ['uptime', 'sitemap']) {
            dialled.length = 0;
            const t = await get(`/api/net/${tool}?target=${q(`https://redirector.example${hop}`)}`);
            assert.equal(t.status, 403, `${tool} ${hop}`);
            assert.deepEqual(dialled, ['93.184.216.35'], `${tool} ${hop}: the internal hop was never dialled`);
        }
    }
    // Headers does not follow at all.
    dialled.length = 0;
    const h302 = await get(`/api/net/headers?target=${q('https://redirector.example/to-loopback')}`);
    assert.equal(h302.status, 200); assert.equal(h302.body.status, 302);
    assert.deepEqual(dialled, ['93.184.216.35']);
    console.log('redirect hops re-checked: ok');

    // ── A public target still works, dialled at its checked address ──
    dialled.length = 0;
    const port = await get('/api/net/port?target=public.example&ports=443,80');
    assert.equal(port.status, 200);
    assert.equal(port.body.ip, '93.184.216.34');
    assert.deepEqual(port.body.ports.map(p => p.status), ['open', 'open']);
    assert.deepEqual(dialled, ['93.184.216.34', '93.184.216.34']);
    const lit = await get('/api/net/port?target=93.184.216.34&ports=22');
    assert.equal(lit.status, 200);
    const ping = await get('/api/net/ping?target=public.example&count=2');
    assert.equal(ping.status, 200); assert.equal(ping.body.stats.loss, 0);
    const hdr = await get(`/api/net/headers?target=${q('public.example')}`);
    assert.equal(hdr.status, 200); assert.equal(hdr.body.status, 200); assert.equal(hdr.body.server, 'mock');
    assert.equal(hdr.body.security.hasHSTS, true);
    const red = await get(`/api/net/redirects?target=${q('https://redirector.example/to-public')}`);
    assert.equal(red.status, 200); assert.deepEqual(red.body.chain.map(c => c.status), [302, 200]); assert.equal(red.body.stopped, undefined);
    const og = await get(`/api/dev/opengraph?url=${q('https://redirector.example/to-public')}`);
    assert.equal(og.status, 200); assert.equal(og.body.tags['og:title'], 'Hello');
    console.log('public targets allowed: ok');

    srv.closeAllConnections(); srv.close();
    console.log('net/dev tools SSRF guard: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
