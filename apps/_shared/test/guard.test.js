'use strict';
// The shared guard (apps/_shared/guard), end to end where it matters:
//   callers and keys (IPv6 /64, one loopback hop, loopback services by their token, sessions, users
//   with the audience check, sandbox apps), token-bucket math and cost weighting from descriptors,
//   session-per-address sharing, report vs enforce, day allowances persisted across a restart,
//   RateLimit-* headers and problem+json, upload sniffing (a renamed file), the per-target throttle,
//   the port-scan cap, the abuse log (no raw address, pruned after 30 days) and the metric, the sync
//   semaphore, the jobs' queue and disk bounds, and the challenge hook.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { dep } = require('./deps');

const express = dep('express');
const cookieParser = dep('cookie-parser');
const multer = dep('multer');
const Database = dep('better-sqlite3');
const contracts = dep('openvibe-contracts');
const metrics = dep('openvibe-shared/metrics');
const guardLib = require('../guard');
const { createGuard, TRUST_PROXY } = guardLib;
const { createSemaphore, Busy } = require('../guard/semaphore');
const { createQuotas } = require('../guard/quota');
const { createGuardStore } = require('../guard/store');
const { ipBucket } = require('../guard/ip');
const sniff = require('../guard/sniff');
const jobs = require('../jobs');

const ISSUER = 'https://openvibe.network';
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(claims) {
    const input = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}`;
    return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}
const now0 = Date.UTC(2026, 8, 23, 12, 0, 0);
const t = () => Math.floor(Date.now() / 1000);
const USER = 'usr_01JAAAAAAAAAAAAAAAAAAAAAAA';
const userToken = (extra = {}) => jwt({ iss: ISSUER, sub: '42', id: 42, subject_id: USER, username: 'alice', aud: ['openvibe.live', 'openvibe.tools', 'openvibe.network'], iat: t(), exp: t() + 3600, ...extra });
const svcToken = (name, extra = {}) => contracts.serviceAuth.signServiceToken({ iss: ISSUER, sub: `svc:${name}`, actor_type: 'service', aud: ['openvibe.tools'], cap: ['tools.tool.run'], ns: [], iat: t(), exp: t() + 900, jti: `tok_${crypto.randomBytes(12).toString('hex')}`, ...extra }, privateKey);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ov-guard-'));
const quiet = { log() {}, warn() {}, error() {} };

// Pure-data descriptors of the real apps (nothing loads sharp or ffmpeg).
const IMG = require('../../img/server/descriptors').SPECS;
const AUDIO = require('../../audio/server/descriptors').SPECS;
const NET = require('../../gateway/server/net/descriptors').SPECS;

function makeGuard(o = {}) {
    return createGuard({
        app: o.app || 'test', dataDir: o.dataDir, Database: o.dataDir ? Database : undefined, contracts,
        specs: o.specs || [...IMG, ...AUDIO, ...NET], issuer: ISSUER,
        keys: { get: () => publicKey, ensure: async () => publicKey },
        env: { TOOLS_GUARD: o.mode || 'report', ...(o.env || {}) }, log: quiet, now: o.now, pruneIntervalMs: 0,
        challenge: o.challenge,
    });
}

async function serve(app) {
    const srv = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    return { base: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise(r => srv.close(r)) };
}

(async () => {
    // ── IPv6 by /64, IPv4-mapped as IPv4 ──
    assert.strictEqual(ipBucket('2001:db8:1:2:aaaa::1'), '2001:0db8:0001:0002::/64');
    assert.strictEqual(ipBucket('2001:db8:1:2:bbbb:cccc:dddd:9'), ipBucket('2001:db8:1:2::77'));
    assert.notStrictEqual(ipBucket('2001:db8:1:3::1'), ipBucket('2001:db8:1:2::1'));
    assert.strictEqual(ipBucket('::ffff:203.0.113.5'), '203.0.113.5');
    assert.strictEqual(TRUST_PROXY('127.0.0.1', 0), true);
    assert.strictEqual(TRUST_PROXY('::ffff:127.0.0.1', 0), true);
    assert.strictEqual(TRUST_PROXY('127.0.0.1', 1), false, 'exactly one hop');
    assert.strictEqual(TRUST_PROXY('203.0.113.9', 0), false, 'a non-loopback peer is never a proxy');

    // ── Callers over HTTP: one loopback hop, tokens, sessions ──
    {
        const g = makeGuard();
        const app = express();
        app.set('trust proxy', TRUST_PROXY);
        app.use(cookieParser());
        app.use(g.identify);
        app.get('/who', (req, res) => { const c = g.caller(req, res); res.json({ kind: c.kind, tier: c.tier, key: c.key, ipKey: c.ipKey, user: req.user ? req.user.subject_id : null, ip: req.ip }); });
        app.get('/job-who', (req, res) => res.json(g.ownerResolver()(req, res, { create: true, action: 'create' }) || {}));
        const s = await serve(app);
        const who = async (headers = {}, p = '/who') => (await fetch(s.base + p, { headers })).json();
        try {
            const direct = await who();
            assert.strictEqual(direct.ip, '127.0.0.1');
            assert.strictEqual(direct.kind, 'anonymous', 'a loopback caller without a token is anonymous');
            assert.ok(direct.ipKey.startsWith('ip:') && !direct.ipKey.includes('127.0.0.1'), 'addresses are hashed');
            const viaNginx = await who({ 'X-Forwarded-For': '6.6.6.6, 198.51.100.7' });
            assert.strictEqual(viaNginx.ip, '198.51.100.7', 'only the one hop nginx adds is believed');
            assert.notStrictEqual(viaNginx.ipKey, direct.ipKey, 'a visitor forwarded by the proxy is not the loopback bucket');
            const v6a = await who({ 'X-Forwarded-For': '2001:db8:1:2::1' });
            const v6b = await who({ 'X-Forwarded-For': '2001:db8:1:2:ffff::2' });
            const v6c = await who({ 'X-Forwarded-For': '2001:db8:9:9::1' });
            assert.strictEqual(v6a.ipKey, v6b.ipKey, 'one /64 is one anonymous caller');
            assert.notStrictEqual(v6a.ipKey, v6c.ipKey);

            // Two first-party services on loopback are two callers, by their tokens.
            const live = await who({ Authorization: `Bearer ${svcToken('live')}` });
            const chat = await who({ Authorization: `Bearer ${svcToken('chat')}` });
            assert.deepStrictEqual([live.kind, live.tier, live.key], ['principal', 'service', 'svc:live']);
            assert.strictEqual(chat.key, 'svc:chat');
            assert.strictEqual(live.ipKey, chat.ipKey, 'same loopback address, different callers');
            const wrongAud = await who({ Authorization: `Bearer ${svcToken('live', { aud: ['openvibe.media'] })}` });
            assert.strictEqual(wrongAud.kind, 'anonymous', 'a token for another audience is not believed');
            const jobWrongAud = await who({ Authorization: `Bearer ${svcToken('live', { aud: ['openvibe.media'] })}` }, '/job-who');
            assert.deepStrictEqual(jobWrongAud.error, [401, 'token.wrong_audience', 'not for openvibe.tools'], 'on the job routes it is an error');

            // Users: the audience is checked now.
            const alice = await who({ Cookie: `ov_token=${userToken()}` });
            assert.deepStrictEqual([alice.kind, alice.tier, alice.key, alice.user], ['user', 'user', `user:${USER}`, USER]);
            const noAud = await who({ Authorization: `Bearer ${jwt({ iss: ISSUER, sub: '42', username: 'alice', role: 'user', iat: t(), exp: t() + 3600 })}` });
            assert.strictEqual(noAud.kind, 'anonymous', 'a Network token without aud openvibe.tools (/internal/issue-token) is not a sign-in here');
            const otherIssuer = await who({ Cookie: `ov_token=${userToken({ iss: 'https://evil.example' })}` });
            assert.strictEqual(otherIssuer.kind, 'anonymous');
            const expired = await who({ Cookie: `ov_token=${userToken({ exp: t() - 120 })}` });
            assert.strictEqual(expired.kind, 'anonymous');

            // Sessions; a sandbox app keeps its small tier.
            const sid = crypto.randomBytes(24).toString('base64url');
            const session = await who({ Cookie: `ov_tools_jobs=${sid}` });
            assert.strictEqual(session.tier, 'session');
            assert.match(session.key, /^session:[0-9a-f]{40}$/);
            const sandbox = await who({ Authorization: `Bearer ${contracts.serviceAuth.signServiceToken({ iss: ISSUER, sub: 'app:app_01JCCCCCCCCCCCCCCCCCCCCCCC', actor_type: 'app', aud: ['openvibe.tools'], cap: ['tools.job.create'], ns: ['prj_01JCCCCCCCCCCCCCCCCCCCCCCC'], project_id: 'prj_01JCCCCCCCCCCCCCCCCCCCCCCC', env: 'sandbox', iat: t(), exp: t() + 900, jti: 'tok_' + 'a'.repeat(24) }, privateKey)}` });
            assert.deepStrictEqual([sandbox.kind, sandbox.tier], ['principal', 'sandbox']);
        } finally { await s.close(); g.close(); }
    }

    // ── Bucket math and cost weighting from the descriptors ──
    {
        let clock = now0;
        const store = createGuardStore({ now: () => clock });
        const q = createQuotas({ store, quotas: () => guardLib.limits.QUOTAS, now: () => clock });
        const anon = { tier: 'anonymous', key: 'ip:a', ipKey: 'ip:a' };
        const cost = (id) => [...IMG, ...AUDIO].find(s => s.id === id).cost;
        assert.strictEqual(cost('png'), 5);
        assert.strictEqual(cost('avif'), 8, 'AVIF encoding weighs more');
        assert.strictEqual(cost('merge'), 20);
        // tools-job anonymous: a bucket of 30 refilled at 60 a minute.
        for (let i = 0; i < 3; i++) assert.ok(q.check(anon, { quotaClass: 'tools-job', cost: cost('avif') }).ok, `avif ${i + 1}`);
        let r = q.check(anon, { quotaClass: 'tools-job', cost: cost('png') });
        assert.ok(r.ok, 'png: 24 + 5 = 29 of 30');
        assert.strictEqual(r.limit, 30);
        assert.strictEqual(r.remaining, 1);
        r = q.check(anon, { quotaClass: 'tools-job', cost: cost('png') });
        assert.strictEqual(r.ok, false, 'the next png does not fit');
        assert.strictEqual(r.binding, 'minute');
        assert.strictEqual(r.retryAfter, 4, 'four more units at one a second');
        clock += 4000;
        assert.ok(q.check(anon, { quotaClass: 'tools-job', cost: cost('png') }).ok, 'refilled');
        // Tiers: a signed-in person has four times the bucket, a service forty.
        const user = { tier: 'user', key: 'user:x', ipKey: 'ip:a' };
        let n = 0; while (q.check(user, { quotaClass: 'tools-job', cost: 5 }).ok) n++;
        assert.strictEqual(n, 24, 'user burst 120 / 5');
        // Sessions from one address share SESSION_IP_SHARE × one session's allowance: dropping the cookie is no reset.
        const sessions = [1, 2, 3, 4].map(i => ({ tier: 'session', key: `session:${i}`, ipKey: 'ip:nat' }));
        const spent = sessions.map(sess => { let k = 0; while (q.check(sess, { quotaClass: 'tools-job', cost: 5 }).ok) k++; return k; });
        assert.deepStrictEqual(spent, [9, 9, 9, 0], 'three sessions use the address allowance, a fourth cookie gets nothing more');
        // A run costing more than the whole bucket still runs when the bucket is full.
        assert.ok(q.check({ tier: 'anonymous', key: 'ip:big', ipKey: 'ip:big' }, { quotaClass: 'tools-download', cost: 500 }).ok);
    }

    // ── Report vs enforce; headers and problem+json; the metric; the challenge hook ──
    for (const mode of ['report', 'enforce']) {
        const dataDir = tmp();
        const g = makeGuard({ mode, dataDir, env: { TOOLS_GUARD_LIMITS: JSON.stringify({ 'tools-api': { anonymous: { perMinute: 2, burst: 2 } } }) } });
        const registry = metrics.createRegistry();
        g.attachMetrics(registry);
        const app = express();
        app.set('trust proxy', TRUST_PROXY);
        app.use(cookieParser());
        app.use(g.identify);
        app.use('/api/', g.apiQuota);
        app.get('/api/x', (_req, res) => res.json({ ok: true }));
        app.get('/api/probe', (req, res) => (g.target(req, res, { tool: 'ping', target: req.query.t }) ? res.json({ ok: true }) : undefined));
        const s = await serve(app);
        const ip = { 'X-Forwarded-For': '203.0.113.77' };
        try {
            const r1 = await fetch(`${s.base}/api/x`, { headers: ip });
            assert.strictEqual(r1.status, 200);
            assert.strictEqual(r1.headers.get('ratelimit-limit'), '2');
            assert.strictEqual(r1.headers.get('ratelimit-remaining'), '1');
            await fetch(`${s.base}/api/x`, { headers: ip });
            const r3 = await fetch(`${s.base}/api/x`, { headers: ip });
            if (mode === 'report') {
                assert.strictEqual(r3.status, 200, 'report mode refuses nothing');
            } else {
                assert.strictEqual(r3.status, 429);
                assert.strictEqual(r3.headers.get('content-type'), 'application/problem+json');
                assert.ok(Number(r3.headers.get('retry-after')) >= 1);
                assert.strictEqual(r3.headers.get('ratelimit-remaining'), '0');
                const body = await r3.json();
                assert.strictEqual(body.code, 'tools.quota.exceeded');
                assert.strictEqual(body.status, 429);
                assert.strictEqual(body.type, 'https://openvibe.network/problems/tools.quota.exceeded');
                assert.strictEqual(body.quota_class, 'tools-api');
                assert.strictEqual(body.tier, 'anonymous');
                assert.ok(body.error, 'the legacy { error } field is there');
            }
            // Another address is not affected.
            assert.strictEqual((await fetch(`${s.base}/api/x`, { headers: { 'X-Forwarded-For': '203.0.113.78' } })).status, 200);
            // A hard limit (the per-target throttle: ping 6 a minute) refuses in both modes.
            const codes = [];
            for (let i = 0; i < 7; i++) codes.push((await fetch(`${s.base}/api/probe?t=${i % 2 ? 'Example.COM' : 'https://example.com:443/x'}`, { headers: { 'X-Forwarded-For': `198.51.100.${i + 1}` } })).status);
            assert.deepStrictEqual(codes, [200, 200, 200, 200, 200, 200, 429], `${mode}: one target, all callers, however it is written`);
            assert.strictEqual((await fetch(`${s.base}/api/probe?t=example.org`, { headers: { 'X-Forwarded-For': '198.51.100.99' } })).status, 200, 'another target is fine');
            const rows = g.store.abuseRows();
            const quota = rows.find(r => r.reason === 'quota');
            assert.ok(quota, 'the quota refusal is in the abuse log');
            assert.strictEqual(quota.enforced, mode === 'enforce' ? 1 : 0);
            assert.ok(rows.find(r => r.reason === 'target' && r.enforced === 1 && r.tool === 'ping'));
            const text = registry.metrics();
            assert.match(text, /tools_guard_refused_total\{reason="quota",tool="-"\} [1-9]/);
            assert.match(text, /tools_guard_refused_total\{reason="target",tool="ping"\} 1/);
            assert.match(text, new RegExp(`tools_guard_enforcing ${mode === 'enforce' ? 1 : 0}`));
        } finally { await s.close(); g.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
    }
    {
        // The challenge hook: a provider may let a person through instead of a quota refusal.
        let asked = 0;
        const g = makeGuard({ mode: 'enforce', env: { TOOLS_GUARD_LIMITS: JSON.stringify({ 'tools-api': { anonymous: { perMinute: 1, burst: 1 } } }) }, challenge: { name: 'test', required: () => { asked++; return true; }, verify: async (req) => req.headers['x-proof'] === 'ok' } });
        assert.strictEqual(makeGuard().challenge.name, 'none', 'no challenge by default');
        const app = express();
        app.use('/api/', g.apiQuota);
        app.get('/api/x', (_req, res) => res.json({ ok: true }));
        const s = await serve(app);
        try {
            assert.strictEqual((await fetch(`${s.base}/api/x`)).status, 200);
            const denied = await fetch(`${s.base}/api/x`);
            assert.strictEqual(denied.status, 403);
            assert.deepStrictEqual([(await denied.json()).code, asked], ['tools.challenge.required', 1]);
            assert.strictEqual((await fetch(`${s.base}/api/x`, { headers: { 'x-proof': 'ok' } })).status, 200, 'a passed challenge goes on');
        } finally { await s.close(); g.close(); }
    }

    // ── Day allowances survive a restart (guard.db) ──
    {
        const dataDir = tmp();
        const env = { TOOLS_GUARD: 'enforce', TOOLS_GUARD_LIMITS: JSON.stringify({ 'tools-fetch': { anonymous: { perMinute: 600, burst: 600, perDay: 10 } } }) };
        const req = { ip: '198.51.100.20', headers: {}, cookies: {} };
        let g = makeGuard({ dataDir, env });
        const caller1 = g.resolveCaller(req);
        assert.ok(g.quotas.check(caller1, { quotaClass: 'tools-fetch', cost: 4 }).ok);
        assert.ok(g.quotas.check(caller1, { quotaClass: 'tools-fetch', cost: 4 }).ok);
        g.close();
        g = makeGuard({ dataDir, env });
        const caller2 = g.resolveCaller(req);
        assert.strictEqual(caller2.ipKey, caller1.ipKey, "today's salt is kept, so the same address is the same key after a restart");
        const r = g.quotas.check(caller2, { quotaClass: 'tools-fetch', cost: 4 });
        assert.strictEqual(r.ok, false, '8 of 10 used before the restart: 4 more do not fit');
        assert.strictEqual(r.binding, 'day');
        assert.ok(g.quotas.check(caller2, { quotaClass: 'tools-fetch', cost: 2 }).ok, 'the last 2 still do');
        g.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
    }

    // ── The abuse log: no raw address anywhere, 30 days ──
    {
        const dataDir = tmp();
        let clock = now0;
        const g = makeGuard({ dataDir, now: () => clock, mode: 'enforce' });
        const RAW = '203.0.113.201';
        const req = { ip: RAW, headers: {}, cookies: {} };
        const res = { headersSent: false, statusCode: 200, setHeader() {}, end() {} };
        for (let i = 0; i < 3; i++) g.refuse(req, res, { status: 429, code: 'tools.quota.exceeded', reason: 'quota', tool: 'png', detail: 'x' });
        clock += 25 * 24 * 3600 * 1000;
        g.refuse({ ip: RAW, headers: {}, cookies: {} }, res, { status: 415, code: 'tools.file.unsupported_type', reason: 'sniff', tool: 'png', detail: 'x', hard: true });
        let rows = g.store.abuseRows();
        assert.strictEqual(rows.length, 2);
        assert.strictEqual(rows[0].count, 3, 'repeats within a minute are one row with a count');
        assert.match(rows[0].ip_hash, /^[0-9a-f]{32}$/);
        assert.notStrictEqual(rows[0].ip_hash, rows[1].ip_hash, 'the salt rotates daily: yesterday\'s hash no longer matches');
        g.store.db.pragma('wal_checkpoint(TRUNCATE)');
        for (const f of fs.readdirSync(dataDir)) assert.ok(!fs.readFileSync(path.join(dataDir, f)).includes(RAW), `${f} holds no raw address`);
        assert.strictEqual(g.store.db.prepare('SELECT COUNT(*) AS n FROM guard_salt').get().n, 1, 'only today\'s salt is kept');
        clock += 6 * 24 * 3600 * 1000;   // the first row is now 31 days old, the second 6
        g.prune();
        rows = g.store.abuseRows();
        assert.deepStrictEqual(rows.map(r => r.reason), ['sniff'], 'rows older than 30 days are pruned');
        g.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
    }

    // ── Upload sniffing: the bytes, not the name or the declared type ──
    {
        const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c50000000049454e44ae426082', 'hex');
        const pdf = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
        const hls = Buffer.from('#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:2,\nfile:///etc/passwd\n#EXT-X-ENDLIST\n');
        const concat = Buffer.from("ffconcat version 1.0\nfile '/etc/passwd'\n");
        const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(32)]);
        assert.strictEqual(sniff.detect(png).mime, 'image/png');
        assert.strictEqual(sniff.detect(pdf).mime, 'application/pdf');
        assert.strictEqual(sniff.detect(wav).mime, 'audio/wav');
        assert.strictEqual(sniff.detect(hls), null, 'a playlist is never media');
        assert.strictEqual(sniff.detect(concat), null);
        assert.strictEqual(sniff.detect(Buffer.from('<?xml version="1.0"?>\n<!-- x -->\n<svg xmlns="http://www.w3.org/2000/svg"/>')).mime, 'image/svg+xml');

        const g = makeGuard();   // report mode: sniffing refuses anyway
        const app = express();
        app.set('trust proxy', TRUST_PROXY);
        const upload = multer({ storage: multer.memoryStorage() }).single('file');
        const dir = tmp();
        const disk = multer({ storage: multer.diskStorage({ destination: dir, filename: (_q, f, cb) => cb(null, `${crypto.randomBytes(8).toString('hex')}${path.extname(f.originalname)}`) }) }).single('file');
        app.post('/img', upload, g.admitUpload(() => 'png'), (req, res) => res.json({ mime: req.file.mimetype, name: req.file.originalname }));
        app.post('/audio', disk, g.admitUpload(() => 'reverb'), (req, res) => res.json({ mime: req.file.mimetype, path: path.basename(req.file.path), name: req.file.originalname }));
        const s = await serve(app);
        const send = (p, buf, name, type) => { const f = new FormData(); f.append('file', new Blob([buf], { type }), name); return fetch(s.base + p, { method: 'POST', body: f }); };
        try {
            let r = await send('/img', pdf, 'holiday.png', 'image/png');
            assert.strictEqual(r.status, 415, 'a PDF renamed to .png is refused');
            let body = await r.json();
            assert.strictEqual(body.code, 'tools.file.unsupported_type');
            assert.strictEqual(body.detected, 'application/pdf');
            r = await send('/img', png, 'scan.pdf', 'application/pdf');
            assert.strictEqual(r.status, 200, 'a PNG with the wrong name and type is what its bytes say');
            assert.deepStrictEqual(await r.json(), { mime: 'image/png', name: 'scan.png' });
            r = await send('/audio', hls, 'song.mp3', 'audio/mpeg');
            assert.strictEqual(r.status, 415, 'an HLS playlist named .mp3 never reaches ffmpeg');
            assert.strictEqual(fs.readdirSync(dir).length, 0, 'and the refused upload is deleted');
            r = await send('/audio', wav, 'take.m3u8', 'application/octet-stream');
            body = await r.json();
            assert.strictEqual(r.status, 200);
            assert.strictEqual(body.mime, 'audio/wav');
            assert.match(body.path, /\.wav$/, 'the stored upload gets the extension of what it is');
            assert.strictEqual(body.name, 'take.wav');
        } finally { await s.close(); g.close(); fs.rmSync(dir, { recursive: true, force: true }); }
    }

    // ── The port-scan cap (hard: report mode too) ──
    {
        const g = makeGuard();
        const res = () => { const r = { statusCode: 200, headers: {}, body: null, headersSent: false, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = JSON.parse(b); } }; return r; };
        const reqFrom = (ip, cookie) => ({ ip, headers: {}, cookies: cookie ? { ov_tools_jobs: cookie } : {} });
        const twenty = Array.from({ length: 20 }, (_, i) => 1000 + i);
        let out = res();
        assert.strictEqual(g.portScan(reqFrom('198.51.100.40'), out, { tool: 'port', target: 'a.example', ports: [...twenty, 9999] }), false);
        assert.deepStrictEqual([out.statusCode, out.body.code], [400, 'tools.run.invalid'], 'at most 20 ports a request');
        for (let i = 0; i < 5; i++) assert.ok(g.portScan(reqFrom('198.51.100.41'), res(), { tool: 'port', target: 'a.example', ports: twenty }), `check ${i + 1}`);
        out = res();
        assert.strictEqual(g.portScan(reqFrom('198.51.100.41'), out, { tool: 'port', target: 'a.example', ports: [22] }), false, '100 ports in ten minutes, then no more');
        assert.deepStrictEqual([out.statusCode, out.body.code, out.body.scope], [429, 'tools.quota.exceeded', 'ports']);
        assert.ok(Number(out.headers['retry-after']) > 0);
        // Distinct hosts: ten, whatever cookie the browser shows (sessions count by address).
        for (let i = 0; i < 10; i++) assert.ok(g.portScan(reqFrom('198.51.100.42', crypto.randomBytes(24).toString('base64url')), res(), { tool: 'port', target: `h${i}.example`, ports: [443] }));
        out = res();
        assert.strictEqual(g.portScan(reqFrom('198.51.100.42', crypto.randomBytes(24).toString('base64url')), out, { tool: 'port', target: 'h10.example', ports: [443] }), false, 'an eleventh host is a sweep');
        assert.ok(g.portScan(reqFrom('198.51.100.42'), res(), { tool: 'port', target: 'h3.example', ports: [80] }), 'the same hosts again are fine');
        g.close();
    }

    // ── Cross-site requests (CSRF): cookie-carried mutations must come from our pages ──
    {
        const res = () => ({ statusCode: 200, headers: {}, body: null, headersSent: false, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = JSON.parse(b); } });
        const post = (headers, cookies = { ov_tools_jobs: 'a'.repeat(32) }, method = 'POST') => ({ method, ip: '198.51.100.60', headers: { host: 'png.openvibe.tools', ...headers }, cookies });
        for (const mode of ['report', 'enforce']) {
            const g = makeGuard({ mode });
            const ok = (req, hosts) => g.originOk(req, res(), { hosts, tool: 'png' });
            // Allowed: our pages, the tool's own hosts, the same host, no cookies, a Bearer token, safe methods, no Origin at all.
            for (const o of ['https://openvibe.tools', 'https://png.openvibe.tools', 'https://img.openvibe.tools', 'https://a.b.openvibe.tools']) assert.ok(ok(post({ origin: o })), `${mode}: ${o}`);
            assert.ok(ok(post({ origin: 'https://bestpngconverter.example' }), ['bestpngconverter.example']), `${mode}: the tool's own custom domain`);
            assert.ok(ok(post({ origin: 'https://mydomain.example', host: 'mydomain.example' })), `${mode}: the same host`);
            assert.ok(ok(post({ origin: 'https://evil.example' }, {})), `${mode}: no cookies, nothing to forge`);
            assert.ok(ok(post({ origin: 'https://evil.example', authorization: 'Bearer x.y.z' })), `${mode}: a token, not a cookie`);
            assert.ok(ok(post({ origin: 'https://evil.example' }, undefined, 'GET')), `${mode}: GET is not a mutation`);
            assert.ok(ok(post({})), `${mode}: neither Origin nor Referer: not a browser's cross-site request`);
            // Refused (enforce) or only recorded (report).
            const cases = [
                post({ origin: 'https://evil.example' }),
                post({ origin: 'http://img.openvibe.tools' }),                       // not https
                post({ origin: 'https://openvibe.tools.evil.example' }),
                post({ origin: 'null' }),                                           // a sandboxed frame, a data: page
                post({ referer: 'https://evil.example/form' }),                      // no Origin, a foreign Referer
                post({ origin: 'https://evil.example' }, { ov_token: 'x.y.z' }),     // the sign-in cookie
            ];
            for (const req of cases) {
                const out = res();
                const allowed = g.originOk(req, out, { tool: 'png' });
                if (mode === 'enforce') {
                    assert.strictEqual(allowed, false, JSON.stringify(req.headers));
                    assert.deepStrictEqual([out.statusCode, out.body.code], [403, 'tools.origin.refused']);
                } else {
                    assert.strictEqual(allowed, true, `report mode records ${JSON.stringify(req.headers)}`);
                    assert.strictEqual(out.body, null);
                }
            }
            const logged = g.store.abuseRows().filter(x => x.reason === 'origin').reduce((n, x) => n + x.count, 0);
            assert.strictEqual(logged, cases.length, `${mode}: every refusal is in the abuse log`);
            g.close();
        }
        // localhost pages outside production (dev servers), never in production.
        const dev = makeGuard({ mode: 'enforce', env: { NODE_ENV: 'development' } });
        assert.ok(dev.originOk(post({ origin: 'http://localhost:5173' }), res()));
        dev.close();
        const prod = makeGuard({ mode: 'enforce', env: { NODE_ENV: 'production' } });
        assert.strictEqual(prod.originOk(post({ origin: 'http://localhost:5173' }), res()), false);
        prod.close();
    }

    // ── The sync semaphore holds heavy calls to the cap ──
    {
        const sem = createSemaphore({ max: 2, queue: 3, waitMs: 200 });
        let running = 0, peak = 0;
        const work = async () => { const release = await sem.acquire(); running++; peak = Math.max(peak, running); await new Promise(r => setTimeout(r, 30)); running--; release(); };
        await Promise.all([work(), work(), work(), work(), work()]);
        assert.strictEqual(peak, 2, 'never more than two at once');
        const held = [await sem.acquire(), await sem.acquire()];
        const waiters = [sem.acquire(), sem.acquire(), sem.acquire()];
        await assert.rejects(sem.acquire(), (e) => e instanceof Busy && e.reason === 'queue', 'a full wait list refuses');
        held.forEach(r => r());
        (await Promise.all(waiters.slice(0, 2))).forEach(r => r());
        (await waiters[2])();
        const again = [await sem.acquire(), await sem.acquire()];
        await assert.rejects(sem.acquire(), (e) => e instanceof Busy && e.reason === 'timeout', 'waiting too long refuses');
        again.forEach(r => r());

        // Over HTTP: TOOLS_SYNC_CONCURRENCY=1 runs one request at a time; with no room to wait, 503 tools.busy.
        for (const mode of ['enforce', 'report']) {
            const g = makeGuard({ mode, env: { TOOLS_SYNC_CONCURRENCY: '1', TOOLS_SYNC_QUEUE: '1' } });
            let now = 0, max = 0;
            const app = express();
            app.post('/p', g.heavy('png'), async (_req, res) => { now++; max = Math.max(max, now); await new Promise(r => setTimeout(r, 80)); now--; res.json({ ok: true }); });
            const s = await serve(app);
            try {
                const codes = await Promise.all([1, 2, 3].map(() => fetch(`${s.base}/p`, { method: 'POST' }).then(r => r.status)));
                if (mode === 'enforce') {
                    assert.deepStrictEqual(codes.sort(), [200, 200, 503], 'one runs, one waits, the third is told to come back');
                    assert.strictEqual(max, 1);
                } else {
                    assert.deepStrictEqual(codes, [200, 200, 200], 'report mode lets the overflow run');
                    assert.ok(g.store.abuseRows().some(r => r.reason === 'busy.sync' && r.enforced === 0));
                }
            } finally { await s.close(); g.close(); }
        }
    }

    // ── The job store's bounds: queued jobs and disk (system.busy) through the guard ──
    for (const mode of ['enforce', 'report']) {
        const dataDir = tmp();
        const db = new Database(':memory:');
        const system = jobs.createJobSystem({ db, contracts, service: 'test', dataDir, concurrency: 0, maxQueued: 2, diskBudgetBytes: 1_000_000, log: quiet });
        system.define({ type: 'test.noop', maxFiles: 1, async run() { return { files: [], data: {} }; } });
        system.start();
        const g = makeGuard({ mode });
        const app = express();
        app.set('trust proxy', TRUST_PROXY);
        app.use(express.json());
        app.use(cookieParser());
        jobs.mountJobRoutes(app, { system, contracts, resolveOwner: g.ownerResolver(), onBusy: (req, res, busy) => g.jobsBusy(req, res, busy) });
        const s = await serve(app);
        const submit = () => fetch(`${s.base}/api/v1/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'test.noop', input: {} }) });
        try {
            assert.strictEqual((await submit()).status, 202);
            assert.strictEqual((await submit()).status, 202);
            assert.strictEqual(system.busy().reason, 'queue');
            const r = await submit();
            if (mode === 'enforce') {
                assert.strictEqual(r.status, 503, 'a third queued job is refused');
                assert.strictEqual((await r.json()).code, 'tools.busy');
                assert.strictEqual(r.headers.get('retry-after'), '60');
            } else {
                assert.strictEqual(r.status, 202, 'report mode accepts it');
                assert.ok(g.store.abuseRows().some(x => x.reason === 'busy.queue' && x.enforced === 0));
            }
        } finally { await s.close(); g.close(); system.stop(); db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
    }
    // Unfinished browser-session jobs are bounded per address too: a new cookie is no new allowance.
    for (const mode of ['enforce', 'report']) {
        const dataDir = tmp();
        const db = new Database(':memory:');
        const system = jobs.createJobSystem({ db, contracts, service: 'test', dataDir, concurrency: 0, maxActivePerOwner: 1, log: quiet });
        system.define({ type: 'test.noop', maxFiles: 1, async run() { return { files: [], data: {} }; } });
        system.start();
        assert.strictEqual(system.bounds.maxActivePerAddress, 3, '3 × the per-owner bound by default');
        const g = makeGuard({ mode });
        const app = express();
        app.set('trust proxy', TRUST_PROXY);
        app.use(express.json());
        app.use(cookieParser());
        jobs.mountJobRoutes(app, {
            system, contracts, resolveOwner: g.ownerResolver(),
            onAddressFull: (req, res, full) => !g.refuse(req, res, { status: 429, code: 'tools.job.too_many_active', reason: 'jobs.address', retryAfter: 30, detail: `at most ${full.limit}` }),
        });
        const s = await serve(app);
        const submit = (ip, cookie) => fetch(`${s.base}/api/v1/jobs`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Forwarded-For': ip, ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ type: 'test.noop', input: {} }) });
        try {
            const first = await submit('198.51.100.60');
            assert.strictEqual(first.status, 202);
            const cookie = String(first.headers.get('set-cookie')).split(';')[0];
            assert.strictEqual((await submit('198.51.100.60', cookie)).status, 429, 'the per-owner bound (1) as before');
            const codes = [];
            for (let i = 0; i < 3; i++) codes.push((await submit('198.51.100.60')).status);   // a fresh cookie each time
            assert.deepStrictEqual(codes, mode === 'enforce' ? [202, 202, 429] : [202, 202, 202], `${mode}: three per address`);
            assert.strictEqual((await submit('198.51.100.61')).status, 202, 'another address is fine');
            const row = db.prepare('SELECT ip_key FROM tool_jobs LIMIT 1').get();
            assert.match(row.ip_key, /^ip:[0-9a-f]{32}$/, 'the job keeps the hashed key, never the address');
            if (mode === 'report') assert.ok(g.store.abuseRows().some(x => x.reason === 'jobs.address' && x.enforced === 0));
        } finally { await s.close(); g.close(); system.stop(); db.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }
    }
    {
        const dataDir = tmp();
        const db = new Database(':memory:');
        const system = jobs.createJobSystem({ db, contracts, service: 'test', dataDir, concurrency: 0, diskBudgetBytes: 1000, log: quiet });
        system.define({ type: 'test.noop', maxFiles: 1, async run() { return { files: [], data: {} }; } });
        system.start();
        await system.refreshDisk();
        assert.strictEqual(system.busy(), null);
        await system.submit({ owner: 'session:x', type: 'test.noop', input: {}, files: [{ buffer: Buffer.alloc(1500), name: 'a.bin', mime: 'application/octet-stream', size: 1500 }] });
        assert.strictEqual(system.busy().reason, 'disk', 'accepted inputs count against the disk budget at once');
        assert.strictEqual((await system.refreshDisk()) >= 1500, true, 'and the walk finds them');
        system.stop(); db.close(); fs.rmSync(dataDir, { recursive: true, force: true });
    }

    console.log('guard: callers (/64, one loopback hop, services by token, aud-checked users, sessions, sandbox), bucket math + cost, session sharing, report vs enforce, headers + problem+json, day counters across restarts, sniffing, target throttle, port cap, abuse log + prune + metric, semaphore, job bounds (queue, disk, per address), challenge hook, Origin check (CSRF): all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
