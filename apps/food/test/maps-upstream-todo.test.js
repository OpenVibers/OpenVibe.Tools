'use strict';
// Food's maps proxy suppresses upstream 5xx bodies and forwards only each route's query fields.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startApp } = require('../../_shared/test/spawn');
const { startMapsStub } = require('./maps-stub');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-food-upstream-todo-'));

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
        // 1. maps answers 5xx with a JSON body → a clean 502 that carries nothing of the upstream
        maps.setMode('boom');
        const r = await call('/api/foods?search=rice');
        assert.strictEqual(r.status, 502, `food answered ${r.status} ${r.text.slice(0, 200)}`);
        assert.deepStrictEqual(r.body, { error: 'Backend unavailable' }, 'the upstream body must not be passed through');
        assert.ok(!/maps\.internal|sk-live|upstream blew up/.test(r.text), `the answer leaks the upstream: ${r.text.slice(0, 200)}`);
        assert.strictEqual(r.headers.get('x-upstream-secret'), null, 'no upstream header is passed through');

        // 2. every route keeps its supported fields and drops unrelated ones
        maps.setMode('ok');
        const routes = [
            ['/api/food-banks', 'lat=40&lon=-74&radius=10', ['lat', 'lon', 'radius']],
            ['/api/stores', 'lat=40&lon=-74', ['lat', 'lon']],
            ['/api/foods', 'group=grains&campFriendly=true&shelfStable=true&search=rice', ['group', 'campFriendly', 'shelfStable', 'search']],
            ['/api/meal-plan', 'budget=20&days=3&campFriendly=true&shelfStable=true&randomize=true', ['budget', 'days', 'campFriendly', 'shelfStable', 'randomize']],
            ['/api/geocode', 'q=Seattle', ['q']],
        ];
        for (const [route, allowedQuery, expected] of routes) {
            maps.requests.length = 0;
            const result = await call(`${route}?${allowedQuery}&evil=1&unexpected%5Bkey%5D=2`);
            assert.strictEqual(result.status, 200, `${route} answered ${result.status}`);
            const fwd = maps.requests.find((s) => s.path === route);
            assert.ok(fwd, `${route} reached maps`);
            assert.deepStrictEqual(fwd.params.sort(), expected.sort(), `${route} forwarded unexpected query fields`);
        }
    } finally {
        await food.kill();
        await maps.close();
    }
    console.log('food → maps: 5xx bodies are suppressed and only route query fields reach maps');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
