'use strict';
// Traceroute and MTR (net/trace.js, /api/net/trace and /api/net/mtr): mtr's JSON report becomes hops with names and
// networks; mtr is given only the address the SSRF guard checked, in argv after `--`; a private target, or a name
// that resolves to one, is refused before mtr runs; two runs at once is the limit (busy, Retry-After); a timeout
// is a 502 with its code. The resolver and mtr are fakes: nothing here touches a real network.
const assert = require('assert');
const express = require('express');
const { createEgress } = require('../../_shared/egress');
const createNetRoutes = require('../server/net/routes');
const { createTracer, parseReport, MODES } = require('../server/net/trace');

const DNS = { 'public.example': ['93.184.216.34'], 'lan.example': ['192.168.1.20'], 'six.example': [] };
const lookup = (host, _opts, cb) => {
    const a = DNS[host];
    if (!a) return cb(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }));
    cb(null, a.map(address => ({ address, family: 4 })));
};
const egress = createEgress({ lookup });

const REPORT = (dst) => JSON.stringify({ report: { mtr: { dst, tests: 3 }, hubs: [
    { count: 1, host: '15.204.72.1', ASN: 'AS16276', 'Loss%': 0, Snt: 3, Last: 0.17, Avg: 0.166, Best: 0.147, Wrst: 0.182, StDev: 0.018 },
    { count: 2, host: '???', ASN: 'AS???', 'Loss%': 100, Snt: 3, Last: 0, Avg: 0, Best: 0, Wrst: 0, StDev: 0 },
    { count: 3, host: dst, ASN: 'AS15133', 'Loss%': 33.3333, Snt: 3, Last: 5.4, Avg: 5.4567, Best: 4.7, Wrst: 6.2, StDev: 0.7 },
] } });

(async () => {
    // ── The report ──
    const hops = parseReport(REPORT('93.184.216.34'));
    assert.deepStrictEqual(hops.map(h => [h.hop, h.ip, h.asn]), [[1, '15.204.72.1', 'AS16276'], [2, null, null], [3, '93.184.216.34', 'AS15133']]);
    assert.strictEqual(hops[2].avg, 5.46, 'times rounded to 0.01 ms');
    assert.strictEqual(hops[2].loss, 33.33);
    assert.strictEqual(hops[1].best, null, 'no reply has no times');
    assert.throws(() => parseReport('not json'), (e) => e.code === 'trace_failed');

    // ── The tracer: argv, names, reached, the limit ──
    const calls = [];
    let release = null;
    const exec = async (args, timeoutMs) => {
        calls.push({ args, timeoutMs });
        if (release) await new Promise(r => { release.push(r); });
        return { stdout: REPORT(args[args.length - 1]) };
    };
    const names = { '15.204.72.1': ['vl1.example-provider.net'], '93.184.216.34': ['_gateway'] };
    const tracer = createTracer({ exec, reverse: async (ip) => names[ip] || [] });
    let run = await tracer.run('trace', { address: '93.184.216.34', family: 4 });
    assert.deepStrictEqual(calls[0].args, ['-4', '-n', '-z', '-j', '-c', '3', '-m', '30', '-U', '5', '--', '93.184.216.34']);
    assert.strictEqual(calls[0].timeoutMs, MODES.trace.timeoutMs);
    assert.strictEqual(run.reached, true);
    assert.strictEqual(run.probes, 3);
    assert.strictEqual(run.hops[0].host, 'vl1.example-provider.net', 'a hop with a PTR name is named');
    assert.strictEqual(run.hops[2].host, null, 'a synthetic local name (_gateway) is not a hop name');
    run = await tracer.run('mtr', { address: '2606:4700:4700::1111', family: 6 });
    assert.deepStrictEqual(calls[1].args.slice(0, 6), ['-6', '-n', '-z', '-j', '-c', '10']);
    assert.strictEqual(calls[1].args[calls[1].args.length - 1], '2606:4700:4700::1111');
    await assert.rejects(tracer.run('trace', { address: 'public.example' }), (e) => e.code === 'trace_failed', 'only an address is traced');

    release = [];
    const a = tracer.run('trace', { address: '93.184.216.34' });
    const b = tracer.run('mtr', { address: '93.184.216.34' });
    await assert.rejects(tracer.run('trace', { address: '93.184.216.34' }), (e) => e.code === 'busy', 'a third run at once is refused');
    release.forEach(r => r()); await Promise.all([a, b]);
    release = null;
    assert.strictEqual(tracer.running, 0);

    // ── The routes ──
    const routeCalls = [];
    const fakeTracer = {
        async run(mode, dest) {
            routeCalls.push([mode, dest.address]);
            if (dest.address === '93.184.216.34' && mode === 'mtr' && routeCalls.length > 3) throw Object.assign(new Error('The trace took too long and was stopped'), { code: 'trace_timeout' });
            return { hops: parseReport(REPORT(dest.address)), reached: true, probes: MODES[mode].cycles };
        },
    };
    const app = express();
    app.use('/api/net', createNetRoutes(null, null, { egress, tracer: fakeTracer, reverse: async () => [] }));
    const srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const get = async (p) => { const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`); return { status: r.status, retry: r.headers.get('retry-after'), body: await r.json() }; };
    try {
        let r = await get('/api/net/trace?target=public.example');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.ip, '93.184.216.34');
        assert.strictEqual(r.body.family, 4);
        assert.strictEqual(r.body.hops.length, 3);
        r = await get('/api/net/mtr/public.example');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.probes, 10);
        assert.deepStrictEqual(routeCalls, [['trace', '93.184.216.34'], ['mtr', '93.184.216.34']], 'mtr gets the checked address, not the name');

        for (const t of ['127.0.0.1', '10.0.0.8', '192.168.1.1', '169.254.169.254', 'lan.example', '[::1]', 'fd00::1']) {
            r = await get(`/api/net/trace?target=${encodeURIComponent(t)}`);
            assert.strictEqual(r.status, 403, `${t} is refused`);
        }
        assert.strictEqual(routeCalls.length, 2, 'nothing private reached mtr');
        r = await get('/api/net/trace');
        assert.strictEqual(r.status, 400);

        const busyApp = express();
        busyApp.use('/api/net', createNetRoutes(null, null, { egress, tracer: { run: async () => { throw Object.assign(new Error('busy'), { code: 'busy' }); } } }));
        const s2 = await new Promise(res => { const s = busyApp.listen(0, '127.0.0.1', () => res(s)); });
        const r2 = await fetch(`http://127.0.0.1:${s2.address().port}/api/net/mtr?target=public.example`);
        assert.strictEqual(r2.status, 503);
        assert.strictEqual(r2.headers.get('retry-after'), '10');
        assert.strictEqual((await r2.json()).code, 'busy');
        s2.close();

        routeCalls.push(['x', 'x'], ['x', 'x']);
        r = await get('/api/net/mtr?target=public.example');
        assert.strictEqual(r.status, 502);
        assert.strictEqual(r.body.code, 'trace_timeout');
    } finally { srv.close(); }
    console.log('net-trace: ok');
})().catch((e) => { console.error(e); process.exit(1); });
