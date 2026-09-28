'use strict';
// Per-actor limits (apps/_shared/actor-limits.js, roadmap WS-R task 4) on the real guard's callers, with a
// fixed limiter clock:
//   • registry reads: a signed-in person past TOOLS_LIMITS_MINUTE gets 429 problem+json rate_limited with
//     Retry-After (readable from any origin) while another person passes; a third-party app is counted,
//     a first-party service is not; signed-out reads (nobody, or a browser session) are never refused per
//     actor; the next minute reopens
//   • the backstop on job submits and runs sits above the guard's quotas: a person's 601st submit in a
//     minute is refused and another person passes; a service principal goes on past 600
//   • the admin analytics route: 30 a minute
//   • health is never limited; refusals are logged (no token, no raw address) and counted
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { dep } = require('./deps');

const express = dep('express');
const cookieParser = dep('cookie-parser');
const contracts = dep('openvibe-contracts');
const metrics = dep('openvibe-shared/metrics');
const { createActorLimiter } = dep('openvibe-sdk/limits');
const { createGuard, TRUST_PROXY } = require('../guard');
const { createToolsLimits, BACKSTOP } = require('../actor-limits');

const ISSUER = 'https://openvibe.network';
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(claims) {
    const input = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}`;
    return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}
const t = () => Math.floor(Date.now() / 1000);
const ALICE = 'usr_01JAAAAAAAAAAAAAAAAAAAAAAA';
const BOB = 'usr_01JBBBBBBBBBBBBBBBBBBBBBBB';
const userToken = (sid) => jwt({ iss: ISSUER, sub: '42', id: 42, subject_id: sid, username: 'someone', aud: ['openvibe.tools', 'openvibe.network'], iat: t(), exp: t() + 3600 });
const principal = (sub, extra = {}) => contracts.serviceAuth.signServiceToken({ iss: ISSUER, sub, actor_type: sub.startsWith('app:') ? 'app' : 'service', aud: ['openvibe.tools'], cap: ['tools.tool.read', 'tools.job.create', 'tools.tool.run'], ns: [], iat: t(), exp: t() + 900, jti: `tok_${crypto.randomBytes(12).toString('hex')}`, ...extra }, privateKey);
const APP = principal('app:app_01JCCCCCCCCCCCCCCCCCCCCCCC', { project_id: 'prj_01JCCCCCCCCCCCCCCCCCCCCCCC', env: 'production' });
const SVC = principal('svc:network');

(async () => {
    // The limiter's clock: 15 s into a minute, so the minute window has 45 s left. Registry reads: 3 a minute.
    let clock = Date.UTC(2026, 8, 27, 12, 0, 15);
    const lines = [];
    const log = { log() {}, error() {}, warn: (m) => lines.push(String(m)) };
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-actor-limits-'));
    const guard = createGuard({
        app: 'test', dataDir, Database: dep('better-sqlite3'), contracts, specs: [], issuer: ISSUER,
        keys: { get: () => publicKey, ensure: async () => publicKey }, env: { TOOLS_GUARD: 'report' }, log, pruneIntervalMs: 0,
    });
    const registry = metrics.createRegistry();
    const limits = createToolsLimits({ app: 'test', createActorLimiter, guard, registry, log, now: () => clock, env: { TOOLS_LIMITS_MINUTE: '3', TOOLS_LIMITS_HOUR: '100' } });

    const app = express();
    app.set('trust proxy', TRUST_PROXY);
    app.use(cookieParser());
    app.use(guard.identify);
    app.use(limits.registryReads);
    const ok = (_req, res) => res.json({ ok: true });
    app.get(['/api/v1/tools', '/api/v1/tools/:id', '/api/v1/tools/:id/schema'], ok);
    app.post('/api/v1/jobs', limits.backstop('tools.job.create'), ok);
    app.post('/api/v1/tools/:id/run', limits.backstop('tools.tool.run'), ok);
    app.get('/api/internal/analytics', limits.admin, ok);
    app.get('/api/health', ok);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${srv.address().port}`;
    const call = async (p, { token, cookie, ip = '203.0.113.7', method = 'GET' } = {}) => {
        const headers = { 'X-Forwarded-For': ip };
        if (token) headers.Authorization = `Bearer ${token}`;
        if (cookie) headers.Cookie = cookie;
        const r = await fetch(base + p, { method, headers });
        const text = await r.text();
        let body = null; try { body = JSON.parse(text); } catch { /* not JSON */ }
        return { status: r.status, h: r.headers, body, text };
    };

    try {
        // ── Registry reads ──
        const alice = userToken(ALICE);
        for (let i = 0; i < 3; i++) assert.strictEqual((await call('/api/v1/tools', { token: alice })).status, 200, `read ${i + 1}`);
        let r = await call('/api/v1/tools/webp-converter/schema', { token: alice });
        assert.strictEqual(r.status, 429, r.text);
        assert.strictEqual(r.h.get('retry-after'), '45');
        assert.strictEqual(r.h.get('content-type'), 'application/problem+json');
        assert.strictEqual(r.h.get('access-control-allow-origin'), '*', 'readable from any origin, like the registry');
        assert.deepStrictEqual([r.body.code, r.body.status, r.body.retry_after_seconds], ['rate_limited', 429, 45]);
        assert.ok(r.body.detail.includes('tools.tool.read'), r.body.detail);
        assert.strictEqual((await call('/api/v1/tools', { token: userToken(BOB) })).status, 200, 'another person still passes');

        for (let i = 0; i < 3; i++) assert.strictEqual((await call('/api/v1/tools', { token: APP })).status, 200);
        assert.strictEqual((await call('/api/v1/tools', { token: APP })).status, 429, 'a third-party app is counted');
        for (let i = 0; i < 6; i++) assert.strictEqual((await call('/api/v1/tools', { token: SVC })).status, 200, 'a first-party service is not counted');

        // Signed-out reads keep only the per-address limit: nobody, or a browser session, from one address.
        for (let i = 0; i < 8; i++) {
            assert.strictEqual((await call('/api/v1/tools')).status, 200, `signed-out read ${i + 1}`);
            assert.strictEqual((await call('/api/v1/tools/webp-converter', { cookie: `ov_tools_jobs=${'s'.repeat(40)}` })).status, 200);
        }

        clock += 45 * 1000;
        assert.strictEqual((await call('/api/v1/tools', { token: alice })).status, 200, 'the next minute reopens');

        // ── The backstop above the guard's quotas ──
        clock = Date.UTC(2026, 8, 27, 12, 5, 0);
        assert.deepStrictEqual(BACKSTOP.person, { minute: 600, hour: 20000 });
        for (let i = 0; i < 600; i++) {
            const s = (await call('/api/v1/jobs', { token: alice, method: 'POST' })).status;
            if (s !== 200) assert.fail(`submit ${i + 1}: ${s}`);
        }
        r = await call('/api/v1/jobs', { token: alice, method: 'POST' });
        assert.deepStrictEqual([r.status, r.body.code, r.h.get('retry-after')], [429, 'rate_limited', '60']);
        assert.strictEqual((await call('/api/v1/jobs', { token: userToken(BOB), method: 'POST' })).status, 200, 'another person still submits');
        assert.strictEqual((await call('/api/v1/tools/webp-converter/run', { token: alice, method: 'POST' })).status, 200, 'runs are their own budget');
        for (let i = 0; i < 601; i++) {
            const s = (await call('/api/v1/jobs', { token: SVC, method: 'POST' })).status;
            if (s !== 200) assert.fail(`service submit ${i + 1}: ${s}`);
        }

        // ── The admin analytics route: 30 a minute ──
        for (let i = 0; i < 30; i++) assert.strictEqual((await call('/api/internal/analytics', { ip: '127.0.0.1' })).status, 200);
        assert.strictEqual((await call('/api/internal/analytics', { ip: '127.0.0.1' })).status, 429);

        // ── Never limited; logged and counted ──
        for (let i = 0; i < 8; i++) assert.strictEqual((await call('/api/health', { token: alice })).status, 200);
        assert.ok(lines.includes(`[Limits] test: tools.tool.read: user:${ALICE} refused, over 3 per minute`), lines.join('\n'));
        assert.ok(lines.includes(`[Limits] test: tools.job.create: user:${ALICE} refused, over 600 per minute`), lines.join('\n'));
        const limitLines = lines.filter((l) => l.startsWith('[Limits]'));
        assert.ok(!limitLines.some((l) => /Bearer|eyJ|203\.0\.113|127\.0\.0\.1/.test(l)), `no token or raw address in the log:\n${limitLines.join('\n')}`);
        const text = registry.metrics();
        const found = text.split('\n').filter((l) => l.includes('tools_rate_limited_total')).join('\n');
        assert.ok(/tools_rate_limited_total\{limit="tools.tool.read",window="minute"\} 2/.test(text), found);
        assert.ok(/tools_rate_limited_total\{limit="tools.job.create",window="minute"\} 1/.test(text), found);
        assert.ok(/tools_rate_limited_total\{limit="tools.analytics.read",window="minute"\} 1/.test(text), found);
        console.log('actor limits: registry reads, backstop, admin, never-limited routes, logs and metrics');
    } finally {
        await new Promise((r) => srv.close(r));
        guard.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exit(1); });
