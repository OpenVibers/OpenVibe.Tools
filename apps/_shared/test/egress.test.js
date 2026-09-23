'use strict';
// The shared SSRF guard (apps/_shared/egress.js): address classes, checks after DNS, pinned
// connections (no rebinding window), redirect hops re-checked. No real network: resolvers are mocks
// and the only server is an in-process one on loopback.
const assert = require('assert');
const http = require('http');
const { createEgress, isPublicAddress, embeddedV4, TargetRefused } = require('../egress');

(async () => {
    // ── Address classes ──
    for (const ip of ['127.0.0.1', '127.1.2.3', '10.0.0.1', '172.16.5.4', '172.31.255.255', '192.168.1.1', '169.254.169.254',
        '100.64.0.1', '0.0.0.0', '0.1.2.3', '224.0.0.1', '239.255.255.250', '255.255.255.255', '192.0.2.10', '198.51.100.1',
        '203.0.113.9', '198.18.0.1', '192.0.0.8', '240.0.0.1',
        '::1', '::', 'fd00::1', 'fc00::1', 'fe80::1', 'fe80::1%eth0', 'fec0::1', 'ff02::1', '2001:db8::1',
        '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '::127.0.0.1',
        '64:ff9b::a00:1', '2002:c0a8:101::1', 'not-an-ip', '']) {
        assert.equal(isPublicAddress(ip), false, `${ip} is not public`);
    }
    for (const ip of ['93.184.216.34', '1.1.1.1', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:93.184.216.34', '2a00:1450:4001::1']) {
        assert.equal(isPublicAddress(ip), true, `${ip} is public`);
    }
    assert.equal(embeddedV4('::ffff:7f00:1'), '127.0.0.1');
    assert.equal(embeddedV4('2002:c0a8:101::1'), '192.168.1.1');
    console.log('address classes: ok');

    // ── resolve(): checks after DNS, every answer, names refused before DNS ──
    const table = {
        'public.example': ['93.184.216.34', '2606:4700::6810:1'],
        'rebind.example': ['127.0.0.1'],
        'meta.example': ['169.254.169.254'],
        'mixed.example': ['93.184.216.34', '10.0.0.7'],
        'mapped.example': ['::ffff:127.0.0.1'],
    };
    let lookups = [];
    const lookup = (host, opts, cb) => {
        lookups.push(host);
        const a = table[host];
        if (!a) return cb(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }));
        cb(null, a.map(address => ({ address, family: address.includes(':') ? 6 : 4 })));
    };
    const g = createEgress({ lookup });
    const refused = async (p, what) => {
        await assert.rejects(p, (err) => err instanceof TargetRefused && err.status === 403 && err.code === 'tools.net.target_not_public', what);
    };
    for (const h of ['localhost', 'LOCALHOST.', 'app.localhost', 'printer.local', 'metadata.google.internal', 'intranet', '2130706433']) {
        lookups = [];
        await refused(g.resolve(h), h);
        assert.deepEqual(lookups, [], `${h} is refused before DNS`);
    }
    for (const h of ['127.0.0.1', '[::1]', '10.1.2.3', '192.168.0.10', '169.254.169.254', '0.0.0.0', '100.64.1.1', '[::ffff:127.0.0.1]', '[fd12::1]']) {
        await refused(g.resolve(h), h);
    }
    for (const h of ['rebind.example', 'meta.example', 'mixed.example', 'mapped.example']) await refused(g.resolve(h), h);
    await assert.rejects(g.resolve('nxdomain.example'), (err) => err.status === 400 && /Cannot resolve/.test(err.message));
    const pub = await g.resolve('Public.Example.', { prefer: 4 });
    assert.deepEqual([pub.host, pub.address, pub.family, pub.literal, pub.addresses.length], ['public.example', '93.184.216.34', 4, false, 2]);
    assert.equal((await g.resolve('[2606:4700:4700::1111]')).address, '2606:4700:4700::1111');
    console.log('resolve: ok');

    // ── Raw sockets only dial checked addresses ──
    const dialled = [];
    const { EventEmitter } = require('events');
    const fakeSocket = (ok) => { const s = new EventEmitter(); s.setTimeout = () => {}; s.destroy = () => {}; process.nextTick(() => ok ? s.emit('connect') : s.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))); return s; };
    const g2 = createEgress({ lookup, tcpConnect: ({ host, port }) => { dialled.push(`${host}:${port}`); return fakeSocket(port === 443); } });
    assert.throws(() => g2.tcpProbe('127.0.0.1', 22), TargetRefused, 'tcpProbe re-checks the address it is handed');
    assert.throws(() => g2.tcpProbe('public.example', 22), TargetRefused, 'tcpProbe takes addresses, not names');
    assert.equal((await g2.tcpProbe('93.184.216.34', 443)).status, 'open');
    assert.equal((await g2.tcpProbe('93.184.216.34', 22)).status, 'closed');
    assert.deepEqual(dialled, ['93.184.216.34:443', '93.184.216.34:22']);
    console.log('tcp probe: ok');

    // ── HTTP: the socket uses the checked address (one DNS answer, never a second) ──
    const seen = [];
    const srv = http.createServer((req, res) => {
        seen.push({ host: req.headers.host, url: req.url });
        if (req.url === '/to-private') { res.writeHead(302, { Location: 'http://10.0.0.5/admin' }); return res.end(); }
        if (req.url === '/to-meta') { res.writeHead(301, { Location: 'http://meta.example/latest/meta-data/' }); return res.end(); }
        if (req.url === '/hop') { res.writeHead(302, { Location: '/final' }); return res.end(); }
        if (req.url === '/big') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('x'.repeat(100000)); }
        res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': ['a=1', 'b=2'] });
        res.end('<title>hello</title>');
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    // This test pretends 127.0.0.1 is public so the in-process server stands in for a public host.
    let dnsCalls = 0;
    const flipLookup = (host, opts, cb) => {
        dnsCalls++;
        if (host === 'site.example') return cb(null, [{ address: dnsCalls === 1 ? '127.0.0.1' : '10.9.9.9', family: 4 }]);
        return lookup(host, opts, cb);
    };
    const dials = [];
    const httpRequest = (opts, cb) => { dials.push(opts.hostname); return http.request(opts, cb); };
    const g3 = createEgress({ lookup: flipLookup, isAllowed: (a) => a === '127.0.0.1' || isPublicAddress(a), httpRequest });
    const r1 = await g3.request(`http://site.example:${port}/page`, { maxBytes: 1000 });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.toString(), '<title>hello</title>');
    assert.equal(r1.headers['set-cookie'], 'a=1, b=2');
    assert.equal(seen[0].host, `site.example:${port}`, 'Host header is the name the person typed');
    assert.equal(dnsCalls, 1, 'one DNS answer: the socket used the pinned address, not a second (rebound) lookup');
    const big = await g3.request(`http://127.0.0.1:${port}/big`, { maxBytes: 1000 });
    assert.equal(big.body.length, 1000); assert.equal(big.truncated, true);
    const head = await g3.request(`http://127.0.0.1:${port}/`, { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(head.body.length, 0);

    // request() never follows; follow() re-checks each hop and refuses before dialling.
    const one = await g3.request(`http://127.0.0.1:${port}/to-private`);
    assert.equal(one.status, 302);
    dials.length = 0; seen.length = 0;
    await refused(g3.follow(`http://127.0.0.1:${port}/to-private`), 'redirect to 10.0.0.5');
    await refused(g3.follow(`http://127.0.0.1:${port}/to-meta`), 'redirect to a name resolving to 169.254.169.254');
    assert.deepEqual(dials, ['127.0.0.1', '127.0.0.1'], 'the refused hops were never dialled');
    const followed = await g3.follow(`http://127.0.0.1:${port}/hop`, { maxBytes: 100 });
    assert.equal(followed.status, 200);
    assert.deepEqual(followed.chain.map(c => c.status), [302, 200]);

    // A real rebinding resolver against the default guard: loopback is refused.
    const g4 = createEgress({ lookup: (h, o, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]) });
    await refused(g4.request(`http://anything.example:${port}/`), 'hostname resolving to 127.0.0.1');
    for (const u of [`http://localhost:${port}/`, `http://127.0.0.1:${port}/`, 'http://[::1]:3000/', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/', 'http://192.168.1.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://[::ffff:7f00:1]/']) {
        await refused(g4.request(u), u);
    }
    await assert.rejects(g4.request('ftp://example.com/'), (e) => e.status === 400);
    await assert.rejects(g4.request('http://user:pw@example.com/'), (e) => e.status === 400);
    srv.close();
    console.log('http request + follow: ok');

    console.log('egress (SSRF guard): all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
