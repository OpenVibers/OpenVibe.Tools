'use strict';
// The gateway's sign-in flow (apps/gateway/server/auth/routes.js): the OAuth half is openvibe-sdk/sso's
// (the authorize URL with PKCE S256, the code / refresh / FedCM grants and GET /auth/health), the
// session half stays the gateway's own, because its cookies belong to the whole *.openvibe.tools
// zone. A stand-in Network speaks the token endpoint (JSON, like the SDK posts it) and answers the
// authorize request with a code bound to the challenge it was given.
//
// What this pins down:
//   - the flow cookies and the session cookies keep their names, domains, paths and httpOnly flags
//   - the authorize URL carries a PKCE S256 challenge, and the code is only redeemable with the
//     verifier from the flow cookie (a code with the wrong verifier is refused by the Network)
//   - a state that does not match the flow cookie never sets a session
//   - next is sanitised at the login and again at the callback
//   - GET /auth/health answers 200 while the Network accepts the client and 503 when it refuses it
//   - a service principal's token is not a person's session
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const { createAuthClient, createAuthRoutes } = require('../server/auth/routes');

const CLIENT_ID = 'tools';
const CLIENT_SECRET = 'tools-secret';
const REDIRECT = 'https://openvibe.tools/auth/callback';
const DOMAIN = '.openvibe.tools';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const t = () => Math.floor(Date.now() / 1000);
const sign = (claims) => {
    const head = b64({ alg: 'RS256', typ: 'JWT' });
    const body = b64(claims);
    return `${head}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;
};

async function startNetwork() {
    const codes = new Map();       // code -> { challenge }
    const seen = [];
    let issuer = '';
    const srv = http.createServer((req, res) => {
        const raw = [];
        req.on('data', (c) => raw.push(c));
        req.on('end', () => {
            const text = Buffer.concat(raw).toString('utf8');
            const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
            const url = new URL(req.url, 'http://x');
            if (url.pathname === '/api/.well-known/jwks') return json(200, { public_key: publicKey, algorithm: 'RS256' });
            if (url.pathname === '/oauth/authorize') {
                // The Network's authorize endpoint: a code bound to the challenge it was given.
                const challenge = url.searchParams.get('code_challenge');
                const code = crypto.randomBytes(16).toString('hex');
                codes.set(code, { challenge });
                return json(200, { code, state: url.searchParams.get('state') });
            }
            if (url.pathname === '/oauth/token' && req.method === 'POST') {
                // The Network takes the token grant as JSON (openvibe-sdk/sso) or as a form.
                const body = text.trim().startsWith('{') ? JSON.parse(text) : Object.fromEntries(new URLSearchParams(text));
                seen.push(body);
                if (body.client_id !== CLIENT_ID || body.client_secret !== CLIENT_SECRET) return json(401, { error: 'invalid_client' });
                if (body.grant_type === 'authorization_code') {
                    const entry = codes.get(body.code);
                    if (!entry) return json(400, { error: 'invalid_grant', error_description: 'Invalid authorization code' });
                    codes.delete(body.code);
                    const digest = crypto.createHash('sha256').update(String(body.code_verifier || '')).digest('base64url');
                    if (entry.challenge && digest !== entry.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
                    return json(200, {
                        access_token: sign({ iss: issuer, sub: '1001', id: 1001, subject_id: 'usr_01J0000000000000000000000', username: 'person1', aud: ['openvibe.tools'], iat: t(), exp: t() + 3600 }),
                        refresh_token: 'refresh-x',
                        token_type: 'Bearer',
                    });
                }
                if (body.grant_type === 'refresh_token') {
                    return json(200, {
                        access_token: sign({ iss: issuer, sub: '1001', id: 1001, subject_id: 'usr_01J0000000000000000000000', username: 'person1', aud: ['openvibe.tools'], iat: t(), exp: t() + 3600 }),
                        refresh_token: 'refresh-y',
                        token_type: 'Bearer',
                    });
                }
                if (body.grant_type === 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
                    return json(200, {
                        access_token: sign({ iss: issuer, sub: '1001', id: 1001, subject_id: 'usr_01J0000000000000000000000', username: 'person1', aud: ['openvibe.tools'], iat: t(), exp: t() + 3600 }),
                        refresh_token: 'refresh-z',
                        token_type: 'Bearer',
                    });
                }
                return json(400, { error: 'unsupported_grant_type' });
            }
            return json(404, {});
        });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}`;
    issuer = url;
    return { url, codes, seen, close: () => new Promise((r) => srv.close(r)) };
}

/** The Set-Cookie headers of a reply, by cookie name. */
function cookieMap(res) {
    const out = {};
    for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        out[pair.slice(0, i)] = { value: decodeURIComponent(pair.slice(i + 1)), raw: c };
    }
    return out;
}
/** The flow cookies as a Cookie header (the browser's own jar, by hand). */
function flowCookie(cookies, names) {
    return names.filter((n) => cookies[n]).map((n) => `${n}=${encodeURIComponent(cookies[n].value)}`).join('; ');
}

async function serve(app) {
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    return { base: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}

/** The gateway's auth routes, mounted the way index.js mounts them. */
function gateway(net, { clientSecret = CLIENT_SECRET } = {}) {
    const config = {
        baseUrl: 'https://openvibe.tools',
        networkUrl: net.url,
        networkInternalUrl: net.url,
        oauth: { clientId: CLIENT_ID, clientSecret, redirectUri: REDIRECT, scope: 'profile theme' },
        cookies: { domain: DOMAIN, secure: true },
        keyRetryMs: 100,
    };
    const auth = createAuthClient(config);
    const app = express();
    app.use(cookieParser());
    app.use('/auth', createAuthRoutes(config, auth));
    return { app, auth };
}

(async () => {
    const net = await startNetwork();
    let gw = null;
    try {
        const { app, auth } = gateway(net);
        gw = await serve(app);

        const guest = await fetch(`${gw.base}/auth/login?silent=1&next=${encodeURIComponent('https://maps.openvibe.tools/')}`, {
            redirect: 'manual', headers: { Cookie: 'ov_sso_hint=guest' },
        });
        assert.strictEqual(guest.status, 302);
        assert.strictEqual(guest.headers.get('location'), 'https://maps.openvibe.tools/', 'guest handoff never visits Network');
        assert.strictEqual(guest.headers.get('set-cookie'), null, 'no flow or session is created for a guest');
        const explicit = await fetch(`${gw.base}/auth/login`, { redirect: 'manual', headers: { Cookie: 'ov_sso_hint=guest' } });
        assert.strictEqual(new URL(explicit.headers.get('location')).pathname, '/oauth/authorize', 'an explicit login still works');

        // ── GET /auth/login: the authorize URL with a PKCE S256 challenge ──
        const login = await fetch(`${gw.base}/auth/login?next=%2Ftools%3Fa%3D1`, { redirect: 'manual' });
        assert.strictEqual(login.status, 302, 'the login redirects');
        const location = new URL(login.headers.get('location'));
        assert.strictEqual(location.pathname, '/oauth/authorize');
        assert.strictEqual(location.searchParams.get('response_type'), 'code');
        assert.strictEqual(location.searchParams.get('client_id'), CLIENT_ID);
        assert.strictEqual(location.searchParams.get('redirect_uri'), REDIRECT);
        assert.strictEqual(location.searchParams.get('code_challenge_method'), 'S256', 'PKCE S256');
        assert.ok(location.searchParams.get('code_challenge'), 'a challenge');
        assert.ok(location.searchParams.get('state'), 'a state');

        const cookies = cookieMap(login);
        // The flow cookies keep their names and their attributes (zone-wide, /auth, httpOnly).
        for (const name of ['ov_oauth_state', 'ov_oauth_verifier', 'ov_oauth_next']) {
            assert.ok(cookies[name], `${name} is set`);
            assert.match(cookies[name].raw, /Domain=\.openvibe\.tools/, name);
            assert.match(cookies[name].raw, /Path=\/auth/, name);
            assert.match(cookies[name].raw, /HttpOnly/, name);
        }
        assert.strictEqual(cookies.ov_oauth_next.value, '/tools?a=1', 'the next target is kept');
        assert.ok(!cookies.ov_token, 'no session yet');

        // ── GET /auth/callback: a state that does not match never sets a session ──
        const bad = await fetch(`${gw.base}/auth/callback?code=x&state=not-the-state`, { redirect: 'manual', headers: { Cookie: flowCookie(cookies, ['ov_oauth_state', 'ov_oauth_verifier', 'ov_oauth_next']) } });
        assert.strictEqual(bad.status, 400, 'a wrong state is refused');
        assert.ok(!cookieMap(bad).ov_token, 'no session from a wrong state');

        // ── the whole flow: the code is only redeemable with the flow's verifier ──
        const authorized = await fetch(location.href, { redirect: 'manual' });
        const { code } = await authorized.json();
        const cb = await fetch(`${gw.base}/auth/callback?code=${code}&state=${encodeURIComponent(location.searchParams.get('state'))}`, { redirect: 'manual', headers: { Cookie: flowCookie(cookies, ['ov_oauth_state', 'ov_oauth_verifier', 'ov_oauth_next']) } });
        assert.strictEqual(cb.status, 302, 'the callback redirects');
        assert.strictEqual(cb.headers.get('location'), '/tools?a=1', 'back to the next target');
        const granted = net.seen.find((b) => b.grant_type === 'authorization_code');
        assert.ok(granted, 'the code was exchanged');
        assert.strictEqual(granted.code_verifier, cookies.ov_oauth_verifier.value, 'the PKCE verifier went with it');
        assert.strictEqual(granted.redirect_uri, REDIRECT, 'the redirect URI is unchanged');

        const session = cookieMap(cb);
        // The session cookies keep their names, domains, paths and httpOnly flags.
        assert.match(session.ov_token.raw, /Domain=\.openvibe\.tools/, 'ov_token is zone-wide');
        assert.match(session.ov_token.raw, /Path=\/;/, 'ov_token is on /');
        assert.ok(!/HttpOnly/i.test(session.ov_token.raw), 'ov_token stays readable by the satellites');
        assert.match(session.ov_refresh.raw, /Domain=\.openvibe\.tools/, 'ov_refresh is zone-wide');
        assert.match(session.ov_refresh.raw, /Path=\/auth/, 'ov_refresh only leaves for /auth');
        assert.match(session.ov_refresh.raw, /HttpOnly/i, 'ov_refresh is httpOnly');
        assert.strictEqual(session.ov_sso_hint.value, 'account', 'the hint says account');
        assert.ok(!/HttpOnly/i.test(session.ov_sso_hint.raw), 'the hint is readable by the navbar');

        // ── GET /auth/me: the session reads back as the person ──
        const me = await fetch(`${gw.base}/auth/me`, { headers: { Cookie: `ov_token=${encodeURIComponent(session.ov_token.value)}` } });
        assert.strictEqual(me.status, 200);
        const meBody = await me.json();
        assert.strictEqual(meBody.user.username, 'person1', 'the profile');
        assert.ok(!('aud' in meBody.user) && !('iat' in meBody.user), 'the registered claims are not the profile');

        // ── a principal's token is not a person's session ──
        const service = sign({ iss: net.url, sub: 'svc:partner', actor_type: 'service', aud: ['openvibe.tools'], cap: ['tools.net.probe'], iat: t(), exp: t() + 900 });
        const asService = await fetch(`${gw.base}/auth/me`, { headers: { Cookie: `ov_token=${encodeURIComponent(service)}` } });
        assert.deepStrictEqual(await asService.json(), { user: null }, 'a service token is not a session');

        // ── next is sanitised at the login ──
        const evil = await fetch(`${gw.base}/auth/login?next=${encodeURIComponent('https://evil.example/x')}`, { redirect: 'manual' });
        const evilCookies = cookieMap(evil);
        assert.ok(!evilCookies.ov_oauth_next || ['/', ''].includes(evilCookies.ov_oauth_next.value), 'an outside target is dropped');
        assert.ok(!evilCookies.ov_oauth_next || !evilCookies.ov_oauth_next.value.includes('evil.example'), 'the outside target is never kept');

        // ── GET /auth/health: the Network accepts this client ──
        const health = await fetch(`${gw.base}/auth/health`);
        assert.strictEqual(health.status, 200);
        assert.deepStrictEqual(await health.json(), { ok: true, client: 'ok' });

        auth.stop();

        // ── and 503 when the Network refuses the client ──
        const refused = gateway(net, { clientSecret: 'wrong-secret' });
        const refusedSrv = await serve(refused.app);
        try {
            const h = await fetch(`${refusedSrv.base}/auth/health`);
            assert.strictEqual(h.status, 503, 'the health answers 503 when the client is refused');
            assert.deepStrictEqual(await h.json(), { ok: false, client: 'invalid' });
        } finally {
            refused.auth.stop();
            await refusedSrv.close();
        }

        console.log('gateway sign-in: PKCE S256, the flow cookies, the zone-wide session cookies, /auth/health');
    } finally {
        if (gw) await gw.close();
        await net.close();
    }
})().catch((e) => { console.error(e); process.exit(1); });
