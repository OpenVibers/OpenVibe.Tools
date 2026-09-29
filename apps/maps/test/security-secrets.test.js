'use strict';
/**
 * The maps satellite's provider keys never reach a visitor (roadmap WS-R task 5, the internal-secret
 * class). Maps calls RIDB, NPS and OpenChargeMap with keys from its environment, and /api/search
 * reports each source's failure to the visitor (sourceMeta[].error). The satellite starts with a
 * sentinel in each key and with no network (test/no-network.js preloaded: every third-party call
 * fails at once), so every source takes its error path; then every route is requested with places
 * and nonsense coordinates. No body or header may carry a key; nor may the process's output.
 */
const assert = require('assert');
const path = require('path');
const { startApp } = require('../../_shared/test/spawn');

const KEYS = {
    RIDB_API_KEY: 'sentinel-not-a-secret-ridb',
    NPS_API_KEY: 'sentinel-not-a-secret-nps',
    OPEN_CHARGE_MAP_KEY: 'sentinel-not-a-secret-ocm',
};

// One loopback proxy hop is trusted (guard/ip.js): a fresh client address per request keeps the
// per-address limit out of what is being read.
let seq = 0;
const client = () => { seq++; return { 'x-forwarded-for': `198.18.${(seq >> 8) & 255}.${seq & 255}` }; };

(async () => {
    const maps = await startApp('maps', { ...KEYS, NODE_OPTIONS: `--require ${path.join(__dirname, '..', '..', '_shared', 'test', 'no-network.js')}` }, undefined, { readyPath: '/api/ready' });
    let failures = 0;
    const check = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failures++; console.log(`  ✗ ${name}\n    ${String(e.stack || e.message).split('\n').slice(0, 8).join('\n    ')}`); } };
    try {
        const places = ['lat=47.6062&lon=-122.3321&radius=25&q=seattle', 'lat=37.7749&lon=-122.4194&radius=100&q=park&state=CA', 'lat=999&lon=abc&radius=-1&q=%27%22%3Cx%3E', 'q=' + 'x'.repeat(300)];
        const paths = ['/api/search', '/api/search/stream', '/api/geocode', '/api/weather', '/api/terrain', '/api/food-banks', '/api/foods', '/api/stores', '/api/meal-plan',
            '/api/internal/analytics', '/api/internal/analytics/bots', '/api/ready', '/api/nope', '/', '/nope'];
        let answered = 0;
        const found = [];
        const statuses = {};
        await check('every route, with places and nonsense: no provider or internal key in a body or header', async () => {
            for (const p of paths) {
                for (const q of places) {
                    let r = null;
                    try {
                        const ac = new AbortController();
                        const timer = setTimeout(() => ac.abort(), 15000);
                        r = await fetch(`${maps.base}${p}?${q}`, { signal: ac.signal, headers: client() });
                        const text = await r.text().catch(() => '');
                        clearTimeout(timer);
                        answered++;
                        statuses[r.status] = (statuses[r.status] || 0) + 1;
                        const all = text + JSON.stringify([...r.headers.entries()]);
                        for (const [k, v] of Object.entries(KEYS)) if (all.includes(v)) found.push(`GET ${p}?${q.slice(0, 40)} → ${r.status} carries ${k}`);
                    } catch { /* a stream cut off by the timeout carries what it carried */ }
                }
            }
            assert.ok(answered >= paths.length * 2, `${answered} answers`);
            assert.ok(statuses[429] === undefined, `rate-limited answers: ${statuses[429]}`);
            assert.deepStrictEqual(found, []);
        });
        await check('the search really ran its sources into their error paths (the keys were in use)', async () => {
            const r = await fetch(`${maps.base}/api/search?${places[0]}`, { headers: client() });
            const body = await r.json().catch(() => ({}));
            const meta = JSON.stringify(body.sourceMeta || body);
            assert.match(meta, /RIDB|NPS|OpenChargeMap/, meta.slice(0, 300));
        });
        await check('the process output carries no key', async () => {
            const out = maps.output();
            for (const [k, v] of Object.entries(KEYS)) assert.ok(!out.includes(v), `a log line carries ${k}`);
        });
    } finally {
        maps.kill('SIGTERM');
        await maps.exited;
    }
    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
    console.log('\nmaps security-secrets: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
