'use strict';
// Per-actor limits on the real gateway process (apps/_shared/actor-limits.js, roadmap WS-R task 4; the
// numbers and the clock are checked in apps/_shared/test/actor-limits.test.js): with one read a window, a
// signed-in person's second registry read is refused 429 rate_limited with Retry-After while another person
// passes; signed-out reads and health are never refused per actor; the refusal is counted on /metrics.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startApp } = require('../../_shared/test/spawn');
const { startNetwork } = require('../../_shared/test/network');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-gw-limits-'));

(async () => {
    const net = await startNetwork();
    let gw = null;
    try {
        gw = await startApp('gateway', {
            OV_NETWORK_URL: net.url, OV_NETWORK_INTERNAL_URL: net.url, DATA_DIR: path.join(tmp, 'gw'),
            OV_DOMAINS_URL: 'http://127.0.0.1:9/api/domains', OV_REGISTRY_URL: 'http://127.0.0.1:9/registry',
            TOOLS_SATELLITE_PORTS: 'img=9,audio=9,docs=9,yt=9,text=9,maps=9,food=9',
            TOOLS_LIMITS_MINUTE: '1', TOOLS_LIMITS_HOUR: '1',
        });
        const get = async (p, token, ip = '203.0.113.9') => {
            const r = await fetch(gw.base + p, { headers: { 'X-Forwarded-For': ip, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
            const text = await r.text();
            let body = null; try { body = JSON.parse(text); } catch { /* not JSON */ }
            return { status: r.status, h: r.headers, body, text };
        };
        const alice = net.user();
        assert.strictEqual((await get('/api/v1/tools', alice)).status, 200);
        const r = await get('/api/v1/tools', alice);
        assert.strictEqual(r.status, 429, r.text);
        assert.ok(Number(r.h.get('retry-after')) >= 1, r.h.get('retry-after'));
        assert.deepStrictEqual([r.body.code, r.body.status], ['rate_limited', 429]);
        assert.strictEqual(r.h.get('access-control-allow-origin'), '*');
        assert.strictEqual((await get('/api/v1/tools', net.user())).status, 200, 'another person still passes');
        for (let i = 0; i < 5; i++) {
            assert.strictEqual((await get('/api/v1/tools')).status, 200, `signed-out read ${i + 1}`);
            assert.strictEqual((await get('/api/health', alice)).status, 200);
        }
        const m = await fetch(`${gw.base}/metrics`).then((x) => x.text());
        assert.ok(/tools_rate_limited_total\{limit="tools.tool.read",window="(minute|hour)"\} 1/.test(m), m.split('\n').filter((l) => l.includes('rate_limited')).join('\n'));
        assert.ok(/\[Limits\] gateway: tools\.tool\.read: user:usr_\w+ refused/.test(gw.output()), gw.output().slice(-2000));
        console.log('gateway actor limits: registry reads per person, signed-out reads and health free, counted');
    } finally {
        if (gw) await gw.kill();
        await net.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
})().catch((e) => { console.error(e); process.exit(1); });
