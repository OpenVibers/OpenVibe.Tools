'use strict';
// The internal analytics route on the real gateway (apps/_shared/internal-token.js, contracts v0.79.0):
// a Network service token with tools.analytics.read (aud openvibe.tools) opens it, a token without the
// capability is 403, a wrong audience or a sandbox token is 401, a bad Bearer beside the right key is
// still 401 (never downgraded to the key), the key alone still works, a proxied request is refused, and
// the incoming Bearer is forwarded unchanged to the satellites while the key stays forwarded for a key
// caller. A stub satellite records what the gateway sends.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { startApp } = require('../../_shared/test/spawn');
const { startNetwork } = require('../../_shared/test/network');

const KEY = 'k'.repeat(40);   // a fake key, built at runtime so no literal looks like a secret
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-gw-internal-'));

(async () => {
    const net = await startNetwork();
    const seen = [];
    const stub = http.createServer((req, res) => {
        seen.push({ url: req.url, authorization: req.headers.authorization || null, key: req.headers['x-internal-key'] || null });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, analytics: { summary: { total_pageviews: 1 }, realtime: {} } }));
    });
    await new Promise(r => stub.listen(0, '127.0.0.1', r));
    const stubPort = stub.address().port;
    const fanout = () => seen.filter(s => s.url.startsWith('/api/internal/analytics'));

    let gw = null;
    try {
        gw = await startApp('gateway', {
            OV_NETWORK_URL: net.url, OV_NETWORK_INTERNAL_URL: net.url, INTERNAL_API_KEY: KEY,
            DATA_DIR: path.join(tmp, 'gw'),
            OV_DOMAINS_URL: 'http://127.0.0.1:9/api/domains', OV_REGISTRY_URL: 'http://127.0.0.1:9/registry',
            OV_COMMUNITY_INTERNAL_URL: 'http://127.0.0.1:9',
            TOOLS_SATELLITE_PORTS: ['img', 'audio', 'docs', 'yt', 'text', 'maps', 'food'].map(n => `${n}=${stubPort}`).join(','),
        });
        const now = () => Math.floor(Date.now() / 1000);
        const claims = (extra) => ({ iss: net.url, sub: 'svc:network-admin', actor_type: 'service', aud: ['openvibe.tools'], cap: [], ns: [], iat: now(), exp: now() + 900, jti: `tok_${crypto.randomBytes(12).toString('hex')}`, ...extra });
        const good = net.sign(claims({ cap: ['tools.analytics.read'] }));
        const noCap = net.sign(claims({ cap: ['tools.tool.read'] }));
        const wrongAud = net.sign(claims({ cap: ['tools.analytics.read'], aud: ['openvibe.live'] }));
        const sandbox = net.sign(claims({ sub: 'app:app_01JCCCCCCCCCCCCCCCCCCCCCCC', actor_type: 'app', project_id: 'prj_01JCCCCCCCCCCCCCCCCCCCCCCC', env: 'sandbox', ns: ['prj_01JCCCCCCCCCCCCCCCCCCCCCCC'], cap: ['tools.analytics.read'] }));
        const get = (headers = {}) => fetch(`${gw.base}/api/internal/analytics`, { headers });

        // 1. A service token with the capability opens it, and the Bearer reaches every satellite.
        seen.length = 0;
        let r = await get({ Authorization: `Bearer ${good}` });
        let body = await r.json();
        assert.strictEqual(r.status, 200, JSON.stringify(body));
        assert.ok(body.ok && body.analytics, JSON.stringify(body));
        assert.strictEqual(fanout().length, 7, 'the gateway fanned out to all seven satellites');
        assert.ok(fanout().every(s => s.authorization === `Bearer ${good}`), 'the Bearer is forwarded unchanged');
        assert.ok(fanout().every(s => s.key === null), 'no key is sent with a token');

        // 2. A token without the capability is 403.
        r = await get({ Authorization: `Bearer ${noCap}` });
        body = await r.json();
        assert.strictEqual(r.status, 403, JSON.stringify(body));
        assert.strictEqual(body.code, 'capability.denied');

        // 3. Another audience is 401.
        assert.strictEqual((await get({ Authorization: `Bearer ${wrongAud}` })).status, 401);

        // 4. A sandbox token is 401.
        assert.strictEqual((await get({ Authorization: `Bearer ${sandbox}` })).status, 401);

        // 5. A Bearer request is judged on the token alone: the right key beside it does not help.
        assert.strictEqual((await get({ Authorization: 'Bearer not-a-jwt', 'X-Internal-Key': KEY })).status, 401);
        assert.strictEqual((await get({ Authorization: `Bearer ${noCap}`, 'X-Internal-Key': KEY })).status, 403);

        // 6. A proxied request is refused with key or token (loopback only, as before).
        assert.strictEqual((await get({ 'X-Internal-Key': KEY, 'X-Forwarded-For': '203.0.113.9' })).status, 404);
        assert.strictEqual((await get({ Authorization: `Bearer ${good}`, 'X-Forwarded-For': '203.0.113.9' })).status, 404);

        // 7. The key alone still works, and the key is what the gateway forwards.
        seen.length = 0;
        r = await get({ 'X-Internal-Key': KEY });
        body = await r.json();
        assert.strictEqual(r.status, 200, JSON.stringify(body));
        assert.strictEqual(fanout().length, 7);
        assert.ok(fanout().every(s => s.key === KEY && s.authorization === null), 'the key is forwarded when the caller used the key');

        // 8. No credentials is 404, as before.
        assert.strictEqual((await get()).status, 404);

        console.log('gateway internal analytics: token (tools.analytics.read) opens and is forwarded, 403 without it, 401 for wrong audience/sandbox/bad Bearer, key alone still works, proxied refused');
    } finally {
        if (gw) await gw.kill();
        await new Promise(r => stub.close(r));
        await net.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
})().catch((e) => { console.error(e); process.exit(1); });
