'use strict';
// Food proxies every API call to maps. It used to call maps without the visitor's address, so maps'
// per-caller quota was one bucket shared by every food visitor (127.0.0.1). Now food forwards
// X-Forwarded-For / X-Real-IP from req.ip, and maps believes X-Forwarded-For from one loopback hop only.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { startApp } = require('../../_shared/test/spawn');

(async () => {
    const maps = await startApp('maps', {}, undefined, { readyPath: '/api/ready' });
    const food = await startApp('food', { MAPS_API: maps.base }, undefined, { readyPath: '/api/ready' });
    try {
        const ask = (ip) => fetch(`${food.base}/api/foods?search=rice`, { headers: { 'X-Forwarded-For': ip } });
        // One visitor uses up maps' tools-map quota (descriptor maps: cost 2; anonymous burst 40 units = 20 calls)…
        let limited = null;
        for (let i = 0; i < 40 && !limited; i++) { const r = await ask('203.0.113.1'); if (r.status === 429) limited = i; else assert.strictEqual(r.status, 200); }
        assert.ok(limited >= 19 && limited <= 21, `maps limits that visitor after its burst of 20 (got ${limited})`);
        // …and another visitor is not affected.
        const other = await ask('203.0.113.2');
        assert.strictEqual(other.status, 200, 'a second visitor has their own bucket');

        const src = (app) => fs.readFileSync(path.join(__dirname, '..', '..', app, 'server', 'index.js'), 'utf8');
        assert.match(src('maps'), /app\.set\('trust proxy', TRUST_PROXY\)/, 'maps trusts one forwarded hop, on loopback only');
        assert.match(src('food'), /app\.set\('trust proxy', TRUST_PROXY\)/);
        assert.match(src('food'), /'X-Forwarded-For': req\.ip/);
    } finally {
        await food.kill();
        await maps.kill();
    }
    console.log('food → maps forwards the visitor address; maps limits per person: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
