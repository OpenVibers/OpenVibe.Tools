'use strict';
// The gateway's Network key (createAuthClient): loaded at boot, and when Network is not answering yet, retried by
// itself every keyRetryMs (30 s in production) until it loads. After the 2026-10-23 reboot the gateway started before
// Network and showed no key on /status for six hours, because only a signed-in request fetched it again.
const assert = require('assert');
const http = require('http');
const { createAuthClient } = require('../server/auth/routes');

(async () => {
    console.log = () => {}; console.warn = () => {};
    let up = false; let fetches = 0;
    const server = http.createServer((req, res) => {
        fetches++;
        if (!up || req.url !== '/api/.well-known/jwks') { res.writeHead(503); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ public_key: '-----BEGIN PUBLIC KEY-----\nTEST\n-----END PUBLIC KEY-----\n', algorithm: 'RS256' }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const auth = createAuthClient({ oauth: { clientId: 'tools', clientSecret: '', redirectUri: `${base}/cb` }, networkUrl: '', networkInternalUrl: base, keyRetryMs: 100 });
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(auth.client.publicKey, null, 'Network down at boot: no key yet');
    assert.strictEqual(fetches, 1);
    up = true;
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(auth.client.publicKey && auth.client.publicKey.includes('TEST'), 'loaded by the retry, with no request asking for it');
    const n = fetches;
    await new Promise((r) => setTimeout(r, 250));
    assert.strictEqual(fetches, n, 'no more fetches once it is loaded');
    auth.stop();
    server.close();
    process.stdout.write('auth-key-retry: ok\n');
    process.exit(0);
})().catch((e) => { process.stderr.write(`${e.stack}\n`); process.exit(1); });
