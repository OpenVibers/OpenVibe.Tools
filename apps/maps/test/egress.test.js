'use strict';
// The maps egress adapter (apps/maps/server/egress.js): one allowlisted HTTPS door for every
// outbound request. Every transport is a mock — no DNS, no socket — so any real network use would
// fail the test. Covers the allowlist and redirect hops, the pinned-DNS rule from the shared guard,
// size caps, key handling, and the grep guard that no other maps file reaches the network itself.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { createEgress, TargetRefused } = require('../../_shared/egress');

const maps = require('../server/egress');
const { setEgress, MapsEgressError } = maps;

const PUBLIC = '93.184.216.34';
const RIDB_KEY = 'ridb-sentinel-key';
const NPS_KEY = 'nps-sentinel-key';
const OCM_KEY = 'ocm-sentinel-key';

// A guard whose httpsRequest records the request and answers with `respond(rec)` (or a fixed answer).
function makeMock(respond) {
    const seen = [];
    const lookups = [];
    const guard = createEgress({
        lookup: (host, opts, cb) => { lookups.push(host); cb(null, [{ address: PUBLIC, family: 4 }]); },
        httpsRequest: (opts, cb) => {
            const rec = { method: opts.method, hostname: opts.hostname, path: opts.path, headers: opts.headers, body: null };
            seen.push(rec);
            const req = new EventEmitter();
            req.destroy = () => {};
            req.end = (b) => {
                rec.body = b;
                process.nextTick(() => {
                    const answer = (typeof respond === 'function' ? respond(rec) : respond) || {};
                    const res = new EventEmitter();
                    res.statusCode = answer.status || 200;
                    res.statusMessage = 'OK';
                    res.headers = answer.headers || {};
                    res.destroy = () => {};
                    cb(res);
                    process.nextTick(() => {
                        res.emit('data', Buffer.from(answer.body != null ? answer.body : '{}'));
                        res.emit('end');
                    });
                });
            };
            return req;
        },
    });
    return { guard, seen, lookups };
}

(async () => {
    let failures = 0;
    const check = async (name, fn) => {
        try { await fn(); console.log(`  ✓ ${name}`); }
        catch (e) { failures++; console.log(`  ✗ ${name}\n    ${String(e.stack || e.message).split('\n').slice(0, 8).join('\n    ')}`); }
    };

    const ridb = require('../server/sources/ridb');
    const nps = require('../server/sources/nps');
    const ocm = require('../server/sources/openchargemap');
    const terrain = require('../server/sources/terrain');
    const { overpassQuery } = require('../server/sources/utils');

    await check('injected RIDB, NPS and OpenChargeMap keys reach their requests and never a log', async () => {
        const mock = makeMock({ status: 200, body: '{"data":[],"RECDATA":[]}' });
        setEgress(mock.guard);
        const logs = [];
        const real = { log: console.log, warn: console.warn, error: console.error };
        console.log = console.warn = console.error = (...a) => logs.push(a.map(String).join(' '));
        let results;
        try {
            const r1 = await ridb.search(47.6062, -122.3321, 25, RIDB_KEY);
            const r2 = await nps.search(47.6062, -122.3321, 25, NPS_KEY);
            const r3 = await ocm.search(47.6062, -122.3321, 25, OCM_KEY);
            results = JSON.stringify([r1, r2, r3]);
        } finally { Object.assign(console, real); }

        const ridbReqs = mock.seen.filter(r => r.hostname === 'ridb.recreation.gov');
        assert.ok(ridbReqs.length > 0, 'RIDB sent a request');
        for (const r of ridbReqs) assert.strictEqual(r.headers.apikey, RIDB_KEY, 'RIDB key is the apikey header');
        assert.ok(mock.seen.some(r => r.hostname === 'developer.nps.gov' && r.path.includes(`api_key=${NPS_KEY}`)), 'NPS key is the api_key query param');
        assert.ok(mock.seen.some(r => r.hostname === 'api.openchargemap.io' && r.path.includes(`key=${OCM_KEY}`)), 'OpenChargeMap key is the key query param');
        const all = results + '\n' + logs.join('\n');
        for (const key of [RIDB_KEY, NPS_KEY, OCM_KEY]) assert.ok(!all.includes(key), `${key} leaked into results or logs`);
    });

    await check('with an empty key RIDB and NPS send nothing and still resolve', async () => {
        const mock = makeMock({ status: 200, body: '{"data":[],"RECDATA":[]}' });
        setEgress(mock.guard);
        const r1 = await ridb.search(47.6062, -122.3321, 25, '');
        const r2 = await nps.search(47.6062, -122.3321, 25, '');
        assert.deepStrictEqual(mock.seen.length, 0, 'no request was sent');
        for (const r of [r1, r2]) assert.deepStrictEqual(r, [], 'search resolves empty');
    });

    await check('a redirect to a non-allowlisted host is refused before any DNS lookup', async () => {
        const mock = makeMock(() => ({ status: 302, headers: { location: 'https://evil.example/' } }));
        setEgress(mock.guard);
        await assert.rejects(maps.get('https://api.weather.gov/evil'),
            (e) => e instanceof MapsEgressError && e.code === 'tools.maps.host_not_allowed');
        assert.ok(!mock.lookups.includes('evil.example'), 'the refused host was never resolved');
    });

    await check('a redirect that drops to http is refused', async () => {
        const mock = makeMock(() => ({ status: 302, headers: { location: 'http://api.weather.gov/plain' } }));
        setEgress(mock.guard);
        await assert.rejects(maps.get('https://api.weather.gov/start'),
            (e) => e instanceof MapsEgressError && e.code === 'tools.maps.host_not_allowed');
    });

    await check('a fourth redirect between allowlisted hosts is refused', async () => {
        const mock = makeMock(() => ({ status: 302, headers: { location: 'https://api.weather.gov/next' } }));
        setEgress(mock.guard);
        await assert.rejects(maps.get('https://api.weather.gov/start'),
            (e) => e instanceof MapsEgressError && e.code === 'tools.maps.too_many_redirects');
    });

    await check('a redirect to another allowlisted host drops the caller headers', async () => {
        const mock = makeMock((rec) => rec.hostname === 'ridb.recreation.gov'
            ? { status: 302, headers: { location: 'https://api.weather.gov/next' } }
            : { status: 200, body: '{}' });
        setEgress(mock.guard);
        await maps.get('https://ridb.recreation.gov/api/v1/facilities', { headers: { apikey: 'k' } });
        assert.strictEqual(mock.seen.length, 2, 'both hops were made');
        assert.strictEqual(mock.seen[0].headers.apikey, 'k', 'the key goes to the host the caller asked for');
        assert.strictEqual(mock.seen[1].hostname, 'api.weather.gov');
        assert.strictEqual(mock.seen[1].headers.apikey, undefined, 'the key is not resent cross-origin');
        assert.strictEqual(mock.seen[1].headers['Accept-Encoding'], 'identity');
    });

    await check('a same-origin redirect keeps the caller headers', async () => {
        const mock = makeMock((rec) => rec.path.endsWith('/start')
            ? { status: 302, headers: { location: 'https://ridb.recreation.gov/api/v1/facilities' } }
            : { status: 200, body: '{}' });
        setEgress(mock.guard);
        await maps.get('https://ridb.recreation.gov/api/v1/start', { headers: { apikey: 'k' } });
        assert.strictEqual(mock.seen.length, 2, 'both hops were made');
        assert.strictEqual(mock.seen[1].headers.apikey, 'k', 'a same-origin redirect keeps the key');
    });

    await check('a host resolving to a private address is refused by the pinned guard', async () => {
        setEgress(createEgress({ lookup: (h, o, cb) => cb(null, [{ address: '10.0.0.5', family: 4 }]) }));
        await assert.rejects(maps.get('https://api.weather.gov/points/47,-122'), (e) => e instanceof TargetRefused);
    });

    await check('an oversized answer is refused and the terrain source falls back to null', async () => {
        const mock = makeMock({ status: 200, body: 'x'.repeat(1.5 * 1024 * 1024) });
        setEgress(mock.guard);
        await assert.rejects(maps.get('https://api.open-meteo.com/v1/elevation?latitude=47&longitude=-122'),
            (e) => e instanceof MapsEgressError && e.code === 'tools.maps.response_too_large');
        assert.strictEqual(await terrain.getElevation(47, -122), null);
    });

    await check('overpassQuery POSTs the encoded QL as a form body', async () => {
        const mock = makeMock({ status: 200, body: '{"elements":[]}' });
        setEgress(mock.guard);
        await overpassQuery('node(1);');
        const rec = mock.seen.find(r => r.hostname === 'overpass-api.de');
        assert.ok(rec, 'Overpass was asked');
        assert.strictEqual(rec.method, 'POST');
        assert.strictEqual(rec.body, `data=${encodeURIComponent('node(1);')}`);
        assert.strictEqual(rec.headers['Content-Type'], 'application/x-www-form-urlencoded');
    });

    await check('a non-2xx answer surfaces err.response.status', async () => {
        const mock = makeMock({ status: 429, body: '{"error":"slow down"}' });
        setEgress(mock.guard);
        await assert.rejects(maps.get('https://api.weather.gov/alerts/active'),
            (e) => e.response && e.response.status === 429);
    });

    await check('no maps server file outside egress.js reaches the network itself', async () => {
        const serverDir = path.join(__dirname, '..', 'server');
        const moduleRequire = /require\(\s*['"](axios|node-fetch|got|undici|node:https?|https?)['"]\s*\)/;
        const bad = [];
        (function walk(dir) {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) walk(p);
                else if (e.name.endsWith('.js') && e.name !== 'egress.js') {
                    const src = fs.readFileSync(p, 'utf8');
                    if (moduleRequire.test(src) || /\bfetch\s*\(/.test(src) || /\baxios\b/.test(src)) bad.push(path.relative(serverDir, p));
                }
            }
        })(serverDir);
        assert.deepStrictEqual(bad, [], `files still reaching the network: ${bad.join(', ')}`);
    });

    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
    console.log('\nmaps egress adapter: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
