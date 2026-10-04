'use strict';
// Food answers every food API call from maps (apps/food/server/index.js, proxyToMaps). This stands in
// for the maps satellite with one local HTTP server (apps/food/test/maps-stub.js, no external network,
// no maps process) and checks how food answers when that upstream misbehaves:
//   • maps times out or returns malformed JSON → food answers a clean 502 with nothing of the upstream
//   • with no provider key configured, maps' "source skipped" answer is passed through (200), and food
//     sends no key or credential of its own upstream
//   • the parameters the route allows are forwarded
// Maps 5xx responses and query filtering are checked in maps-upstream-todo.test.js.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startApp } = require('../../_shared/test/spawn');
const { startMapsStub } = require('./maps-stub');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-food-upstream-'));

(async () => {
    const maps = await startMapsStub();
    const food = await startApp('food', { MAPS_API: maps.base, DATA_DIR: path.join(tmp, 'food') }, undefined, { readyPath: '/api/ready' });
    const call = async (p) => {
        const r = await fetch(`${food.base}${p}`);
        const text = await r.text();
        let body = null;
        try { body = JSON.parse(text); } catch { /* not JSON */ }
        return { status: r.status, headers: r.headers, text, body };
    };
    try {
        // ── maps returns malformed JSON: a clean 502 ──
        maps.setMode('badjson');
        let r = await call('/api/foods?search=rice');
        assert.strictEqual(r.status, 502, `malformed JSON: food answered ${r.status} ${r.text.slice(0, 200)}`);
        assert.deepStrictEqual(r.body, { error: 'Backend unavailable' }, 'malformed JSON: the answer is the clean error');
        assert.ok(!/maps\.internal|sk-live|SyntaxError|undefined/.test(r.text), `malformed JSON: the answer leaks nothing (${r.text.slice(0, 200)})`);

        // ── maps times out: a clean 502 after food's own 15 s budget ──
        maps.setMode('hang');
        const t0 = Date.now();
        r = await call('/api/foods?search=rice');
        assert.strictEqual(r.status, 502, `timeout: food answered ${r.status} ${r.text.slice(0, 200)}`);
        assert.deepStrictEqual(r.body, { error: 'Backend unavailable' }, 'timeout: the answer is the clean error');
        assert.ok(Date.now() - t0 >= 14000, 'timeout: food waited for its own budget, not forever');

        // ── with no provider key configured, maps' "source skipped" answer comes through as 200 ──
        maps.setMode('skipped');
        maps.requests.length = 0;
        r = await call('/api/food-banks?lat=40.7&lon=-74');
        assert.strictEqual(r.status, 200, `a skipped source still answers 200 (${r.status} ${r.text.slice(0, 200)})`);
        assert.strictEqual(r.body.sources[0].skipped, true, 'the skipped source is passed through, not turned into an error');
        const up = maps.requests.filter((s) => s.path === '/api/food-banks').pop();
        assert.ok(up, 'food forwarded the call to maps');
        assert.ok(!up.headers.authorization && !up.headers['x-api-key'], `food sends no credential of its own upstream (${JSON.stringify(up.headers)})`);

        // ── the parameters the route allows are forwarded ──
        maps.setMode('ok');
        maps.requests.length = 0;
        r = await call('/api/foods?search=rice');
        assert.strictEqual(r.status, 200);
        const fwd = maps.requests.filter((s) => s.path === '/api/foods').pop();
        assert.ok(fwd, 'food forwarded the call to maps');
        assert.ok(fwd.params.includes('search'), `search reached maps (${fwd.params.join(', ')})`);
    } finally {
        await food.kill();
        await maps.close();
    }
    console.log('food → maps: a dead, slow or key-less upstream answers cleanly and the allowed parameters are forwarded');
})().catch((err) => { console.error(err); process.exit(1); });
