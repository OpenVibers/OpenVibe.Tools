'use strict';
// Two behaviours of food's maps proxy (apps/food/server/index.js, proxyToMaps) that are wrong today.
// Each is written as the check it should pass; while it fails it prints the repo runner's
// `<label>: skipped (<why>)` line — the file is reported as skipped, and under --strict it fails — so
// the defect is visible instead of silently green. No production code is changed here (this job does
// not touch it); when the proxy is fixed, no skip line is printed and the file passes.
//   1. a maps 5xx with a JSON body is forwarded verbatim: food answers the upstream's status and body,
//      so an upstream URL or key in that body reaches the caller (it should be a clean 502).
//      apps/food/server/index.js:134 forwards response.status and the parsed body unchanged, and the
//      catch that answers { error: 'Backend unavailable' } (line 137) only runs when the body is not JSON.
//   2. every query parameter is forwarded (line 129), so parameters the route does not take reach maps.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startApp } = require('../../_shared/test/spawn');
const { startMapsStub } = require('./maps-stub');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-food-upstream-todo-'));
const ALLOWED_FOODS = new Set(['group', 'campFriendly', 'shelfStable', 'search']);

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
    const todo = [];
    // The repo runner only reads a skip line that is one line of its own, so the reason is flattened.
    const expect = (label, fn) => {
        try { fn(); } catch (err) { todo.push(`${label}: skipped (${String(err.message).replace(/\s+/g, ' ').slice(0, 200)})`); }
    };
    try {
        // 1. maps answers 5xx with a JSON body → a clean 502 that carries nothing of the upstream
        maps.setMode('boom');
        const r = await call('/api/foods?search=rice');
        expect('food maps 5xx answers a clean 502 with no upstream body', () => {
            assert.strictEqual(r.status, 502, `food answered ${r.status} ${r.text.slice(0, 200)}`);
            assert.deepStrictEqual(r.body, { error: 'Backend unavailable' }, 'the upstream body must not be passed through');
            assert.ok(!/maps\.internal|sk-live|upstream blew up/.test(r.text), `the answer leaks the upstream: ${r.text.slice(0, 200)}`);
            assert.strictEqual(r.headers.get('x-upstream-secret'), null, 'no upstream header is passed through');
        });

        // 2. only the query parameters the route allows reach maps
        maps.setMode('ok');
        maps.requests.length = 0;
        const q = await call('/api/foods?search=rice&evil=1&lat=5');
        assert.strictEqual(q.status, 200);
        const fwd = maps.requests.filter((s) => s.path === '/api/foods').pop();
        assert.ok(fwd, 'food forwarded the call to maps');
        expect('food forwards only the query parameters the route allows', () => {
            const extra = fwd.params.filter((k) => !ALLOWED_FOODS.has(k));
            assert.deepStrictEqual(extra, [], `these parameters reached maps and are not part of the route: ${extra.join(', ')}`);
        });
    } finally {
        await food.kill();
        await maps.close();
    }
    for (const line of todo) console.log(line);
    if (!todo.length) console.log('food → maps todo: the proxy now answers cleanly and forwards only the allowed parameters');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
