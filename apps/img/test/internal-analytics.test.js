'use strict';
// The internal analytics routes on a satellite (apps/_shared/internal-token.js): the image service
// accepts a Network service token with tools.analytics.read (aud openvibe.tools) on /analytics and
// /bots, refuses a token without the capability (403), a wrong audience or a sandbox token (401), a
// bad Bearer beside the retired key (401), a proxied request (404), and the retired key alone or
// nothing at all (401 token.missing).
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startApp } = require('../../_shared/test/spawn');
const { startNetwork } = require('../../_shared/test/network');

const KEY = 'k'.repeat(40);   // a fake key, built at runtime so no literal looks like a secret
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-img-internal-'));

(async () => {
    const net = await startNetwork();
    let app = null;
    try {
        app = await startApp('img', {
            DATA_DIR: data, UPLOADS_DIR: path.join(data, 'uploads'), OUTPUT_DIR: path.join(data, 'output'),
            OV_NETWORK_URL: net.url, OV_NETWORK_INTERNAL_URL: net.url, INTERNAL_API_KEY: KEY,
        });
        const now = () => Math.floor(Date.now() / 1000);
        const claims = (extra) => ({ iss: net.url, sub: 'svc:network-admin', actor_type: 'service', aud: ['openvibe.tools'], cap: [], ns: [], iat: now(), exp: now() + 900, jti: `tok_${crypto.randomBytes(12).toString('hex')}`, ...extra });
        const good = net.sign(claims({ cap: ['tools.analytics.read'] }));
        const noCap = net.sign(claims({ cap: ['tools.tool.read'] }));
        const wrongAud = net.sign(claims({ cap: ['tools.analytics.read'], aud: ['openvibe.live'] }));
        const sandbox = net.sign(claims({ sub: 'app:app_01JCCCCCCCCCCCCCCCCCCCCCCC', actor_type: 'app', project_id: 'prj_01JCCCCCCCCCCCCCCCCCCCCCCC', env: 'sandbox', ns: ['prj_01JCCCCCCCCCCCCCCCCCCCCCCC'], cap: ['tools.analytics.read'] }));
        const get = (p, headers = {}) => fetch(`${app.base}${p}`, { headers });

        // A token with the capability passes both routes.
        for (const p of ['/api/internal/analytics', '/api/internal/analytics/bots']) {
            let r = await get(p, { Authorization: `Bearer ${good}` });
            const body = await r.json();
            assert.strictEqual(r.status, 200, `${p}: ${JSON.stringify(body)}`);
            assert.ok(body.ok, p);
            // Without the capability: 403.
            assert.strictEqual((await get(p, { Authorization: `Bearer ${noCap}` })).status, 403, p);
            // Another audience, and a sandbox token: 401.
            assert.strictEqual((await get(p, { Authorization: `Bearer ${wrongAud}` })).status, 401, p);
            assert.strictEqual((await get(p, { Authorization: `Bearer ${sandbox}` })).status, 401, p);
            // A bad Bearer is 401 whatever else is sent beside it (the retired key does not help).
            assert.strictEqual((await get(p, { Authorization: 'Bearer not-a-jwt', 'X-Internal-Key': KEY })).status, 401, p);
            // The retired key alone is 401 token.missing, and so is no credentials at all.
            r = await get(p, { 'X-Internal-Key': KEY });
            assert.strictEqual(r.status, 401, p);
            assert.strictEqual((await r.json()).code, 'token.missing', p);
            r = await get(p);
            assert.strictEqual(r.status, 401, p);
            assert.strictEqual((await r.json()).code, 'token.missing', p);
            // A proxied request is refused with key or token.
            assert.strictEqual((await get(p, { 'X-Internal-Key': KEY, 'X-Forwarded-For': '203.0.113.9' })).status, 404, p);
            assert.strictEqual((await get(p, { Authorization: `Bearer ${good}`, 'X-Forwarded-For': '203.0.113.9' })).status, 404, p);
        }
        console.log('img internal analytics: token (tools.analytics.read) passes, 403 without it, 401 wrong audience/sandbox/bad Bearer, the retired key alone is 401, proxied refused');
    } finally {
        if (app) await app.kill();
        await net.close();
        fs.rmSync(data, { recursive: true, force: true });
    }
})().catch((e) => { console.error(e); process.exit(1); });
