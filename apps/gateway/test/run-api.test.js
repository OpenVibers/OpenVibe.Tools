'use strict';
// POST /api/v1/tools/:id/run (ADR-027, tools.run-request@1 → tools.run@1) on real processes: the
// gateway, img and docs, with a stand-in Network for tokens, the guard enforcing.
//   • inline tools: dev and text engines (the page's code, in the gateway's worker pool; cached when
//     safe, fresh when random), net lookups through their own routes (myip is the caller's address)
//   • every answer is a tools.run@1 document; refusals are problem+json with the contract's codes
//     (400 tools.run.invalid, 401/403 auth, 404 not_found / not_runnable, 405, 409, 413, 422 with
//     errors[], 429 with Retry-After, 503 tools.tool.unavailable vs tools.unavailable)
//   • probes need a token with tools.net.probe; tools that need a session refuse the anonymous
//   • job tools stream through the gateway to their satellite: multipart uploads as `file` parts,
//     wait_ms (200 finished) or not (202 + Location), Idempotency-Key replays (same job) and
//     conflicts, file references ({ job_id, index }) across satellites and their owner check
//   • the Origin check on cookie-authenticated calls (CSRF) and CORS for other sites' pages
//   • the older endpoints answer as before with Deprecation, Sunset and a successor Link
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const contracts = require('openvibe-contracts');
const { startApp, freePort } = require('../../_shared/test/spawn');
const { startNetwork } = require('../../_shared/test/network');

const APPS = path.join(__dirname, '..', '..');
const sharp = require(require.resolve('sharp', { paths: [path.join(APPS, 'img')] }));
const { PDFDocument } = require(require.resolve('pdf-lib', { paths: [path.join(APPS, 'docs')] }));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-run-api-'));
const MISSING = path.join(tmp, 'not-installed');
let ipN = 1;
const freshIp = () => `198.51.100.${ipN++}`;

function checkRun(body, where) {
    const r = contracts.validate('tools.run@1', body);
    assert.ok(r.valid, `${where}: tools.run@1 ${JSON.stringify(r.errors && r.errors.slice(0, 3))} ${JSON.stringify(body).slice(0, 300)}`);
}
function checkProblem(r, status, code, where) {
    assert.strictEqual(r.status, status, `${where}: ${r.text.slice(0, 300)}`);
    assert.match(r.h.get('content-type'), /application\/problem\+json/, where);
    assert.strictEqual(r.body.code, code, `${where}: ${r.text.slice(0, 300)}`);
}

(async () => {
    const net = await startNetwork();
    const procs = [];
    const start = async (...a) => { const p = await startApp(...a); procs.push(p); return p; };
    try {
        // Every app knows where the others listen (a docs run reads an img job's result on loopback).
        const ports = { img: await freePort(), docs: await freePort() };
        const auth = { OV_NETWORK_URL: net.url, OV_NETWORK_INTERNAL_URL: net.url, TOOLS_GUARD: 'enforce', TOOLS_SATELLITE_PORTS: `img=${ports.img},docs=${ports.docs}` };
        const img = await start('img', { ...auth, DATA_DIR: path.join(tmp, 'img'), UPLOADS_DIR: path.join(tmp, 'img', 'up'), OUTPUT_DIR: path.join(tmp, 'img', 'out'), HEIF_DEC_PATH: MISSING }, ports.img);
        const docs = await start('docs', { ...auth, DATA_DIR: path.join(tmp, 'docs'), UPLOADS_DIR: path.join(tmp, 'docs', 'up'), OUTPUT_DIR: path.join(tmp, 'docs', 'out'), QPDF_PATH: MISSING }, ports.docs);
        const gw = await start('gateway', {
            ...auth, DATA_DIR: path.join(tmp, 'gw'),
            OV_DOMAINS_URL: 'http://127.0.0.1:9/api/domains', OV_REGISTRY_URL: 'http://127.0.0.1:9/registry',
            TOOLS_GUARD_LIMITS: JSON.stringify({ 'tools-run': { anonymous: { perMinute: 40, burst: 40 } } }),
        });
        const G = gw.base;
        const call = async (p, { method = 'POST', json, form, headers = {}, base = G } = {}) => {
            const h = { 'X-Forwarded-For': headers['X-Forwarded-For'] || freshIp(), ...headers };
            let body;
            if (json !== undefined) { h['Content-Type'] = 'application/json'; body = typeof json === 'string' ? json : JSON.stringify(json); }
            if (form) body = form;
            const r = await fetch(`${base}${p}`, { method, headers: h, body });
            const text = await r.text();
            let parsed = null; try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
            return { status: r.status, h: r.headers, text, body: parsed };
        };
        const run = (id, json, opts = {}) => call(`/api/v1/tools/${id}/run`, { json, ...opts });
        // The gateway reads each satellite's own status on boot (protectpdf without qpdf).
        for (let i = 0; i < 50 && (await call('/api/v1/tools/protectpdf', { method: 'GET' })).body.status !== 'unavailable'; i++) await new Promise(r => setTimeout(r, 100));

        // ── Inline: a dev engine (the page's own code) ──
        let r = await run('jsonminify', { input: { text: '{ "a": [1, 2] }' } });
        assert.strictEqual(r.status, 200, r.text);
        checkRun(r.body, 'jsonminify');
        assert.deepStrictEqual([r.body.state, r.body.tool, r.body.result], ['succeeded', 'jsonminify', { text: '{"a":[1,2]}' }]);
        assert.strictEqual(r.h.get('cache-control'), 'no-store');
        assert.ok(Number.isInteger(r.body.took_ms));
        r = await run('jsonminify', { input: { text: '{ "a": [1, 2] }' } });
        assert.strictEqual(r.h.get('x-ov-cache'), 'hit', 'a pure transform is answered from the cache');
        // A text engine; the JSON a tool answers as data.
        r = await run('count', { input: { text: 'two words' } });
        checkRun(r.body, 'count');
        assert.strictEqual(r.body.result.data.words, 2);
        // Random output is never reused.
        const a = await run('uuid', { input: { count: 1 } }), b = await run('uuid', { input: { count: 1 } });
        assert.notStrictEqual(a.body.result.data.uuids[0], b.body.result.data.uuids[0]);
        assert.ok(!b.h.get('x-ov-cache'));
        // The tool's own failure is a failed run (200), with its problem.
        r = await run('jsonminify', { input: { text: '{ nope' } });
        assert.strictEqual(r.status, 200);
        checkRun(r.body, 'jsonminify failed');
        assert.deepStrictEqual([r.body.state, r.body.error.status, r.body.error.code], ['failed', 422, 'tools.job.failed']);
        r = await run('compare', { input: { a: 'x\n'.repeat(2500), b: 'y' } });
        assert.deepStrictEqual([r.body.state, r.body.error.code], ['failed', 'tools.input.invalid'], 'an engine\'s own code is kept');

        // ── Refusals before the tool runs ──
        r = await run('jsonminify', { input: { text: 'x', nope: 1 } });
        checkProblem(r, 422, 'tools.input.invalid', 'schema');
        assert.deepStrictEqual(r.body.errors, [{ path: '/nope', message: 'is not a field of this tool' }]);
        r = await run('jsonminify', { input: {} });
        assert.deepStrictEqual(r.body.errors, [{ path: '/text', message: 'is required' }]);
        checkProblem(await run('jsonminify', { input: { text: 'x' }, extra: 1 }), 400, 'tools.run.invalid', 'unknown field');
        checkProblem(await run('jsonminify', { input: { text: 'x' }, wait_ms: 60001 }), 400, 'tools.run.invalid', 'wait_ms');
        checkProblem(await run('jsonminify', '{"input":'), 400, 'tools.run.invalid', 'not JSON');
        checkProblem(await run('jsonminify', { input: [] }), 400, 'tools.run.invalid', 'input array');
        checkProblem(await run('jsonminify', { input: { text: 'x' } }, { headers: { 'Idempotency-Key': 'short' } }), 400, 'tools.run.invalid', 'bad key');
        checkProblem(await run('dns', { input: { target: 'a'.repeat(4500) } }), 413, 'tools.input.too_large', 'maxInputBytes');
        checkProblem(await run('nosuchtool', {}), 404, 'tools.tool.not_found', 'unknown');
        checkProblem(await run('yt', {}), 404, 'tools.tool.not_runnable', 'yt: api false');
        checkProblem(await run('regex', { input: {} }), 404, 'tools.tool.not_runnable', 'regex: page only');
        r = await run('traceroute', {});
        checkProblem(r, 503, 'tools.tool.unavailable', 'descriptor status unavailable');
        assert.match(r.body.detail, /raw network access/);
        checkProblem(await run('protectpdf', { input: { password: 'x' } }), 503, 'tools.tool.unavailable', 'qpdf missing on docs');
        checkProblem(await call('/api/v1/tools/jsonminify/run', { method: 'GET' }), 405, 'method_not_allowed', 'GET');

        // ── Net tools through their routes ──
        r = await run('myip', { input: {} }, { headers: { 'X-Forwarded-For': '203.0.113.77' } });
        checkRun(r.body, 'myip');
        assert.deepStrictEqual(r.body.result.data, { ip: '203.0.113.77', version: 4 }, 'the caller\'s own address');
        r = await run('ipv4', { input: { target: '10.1.2.0/24' } });
        checkRun(r.body, 'ipv4');
        assert.strictEqual(r.body.result.data.cidr.usable, 254);
        r = await run('ipv4', { input: { target: '10.1.2.0/24' } });
        assert.strictEqual(r.h.get('x-ov-cache'), 'hit', 'lookups with a cacheTtlMs are reused');
        // A target the SSRF guard refuses: the tool ran and failed with its own code.
        r = await run('headers', { input: { target: 'http://127.0.0.1:1/' } });
        checkRun(r.body, 'headers refused');
        assert.deepStrictEqual([r.body.state, r.body.error.status, r.body.error.code], ['failed', 403, 'tools.net.target_not_public']);

        // ── Probes: a token with tools.net.probe, nobody else ──
        checkProblem(await run('ping', { input: { target: '127.0.0.1' } }), 401, 'token.missing', 'probe, anonymous');
        checkProblem(await run('ping', { input: { target: '127.0.0.1' } }, { headers: { Authorization: `Bearer ${net.user()}` } }), 403, 'capability.denied', 'probe, a person');
        checkProblem(await run('ping', { input: { target: '127.0.0.1' } }, { headers: { Authorization: `Bearer ${net.service(['tools.tool.run'])}` } }), 403, 'capability.denied', 'probe, runner token');
        r = await run('ping', { input: { target: '127.0.0.1', count: 1 } }, { headers: { Authorization: `Bearer ${net.service(['tools.net.probe'], { name: 'prober' })}` } });
        checkRun(r.body, 'ping with tools.net.probe');
        assert.strictEqual(r.body.error.code, 'tools.net.target_not_public', 'authorized: it ran (and the SSRF guard kept it off loopback)');
        checkProblem(await run('jsonminify', { input: { text: '1' } }, { headers: { Authorization: `Bearer ${net.service(['tools.job.read'])}` } }), 403, 'capability.denied', 'a token without tools.tool.run');
        checkProblem(await run('jsonminify', { input: { text: '1' } }, { headers: { Authorization: 'Bearer not.a.token' } }), 401, 'token.invalid', 'a token that does not verify');
        r = await run('jsonminify', { input: { text: '1' } }, { headers: { Authorization: `Bearer ${net.service(['tools.tool.run'])}` } });
        assert.strictEqual(r.body.state, 'succeeded', 'a runner token runs');

        // ── Quotas: the tool's class, per caller ──
        {
            const ip = freshIp();
            const codes = [];
            for (let i = 0; i < 80 && !codes.includes(429); i++) {
                r = await run('slug', { input: { text: `q ${i}` } }, { headers: { 'X-Forwarded-For': ip } });
                codes.push(r.status);
            }
            assert.ok(codes.slice(0, 40).every(c => c === 200), JSON.stringify(codes));
            checkProblem(r, 429, 'tools.quota.exceeded', 'tools-run, anonymous: a burst of 40, then 40 a minute');
            assert.ok(Number(r.h.get('retry-after')) >= 1);
            assert.strictEqual(r.body.quota_class, 'tools-run');
        }

        // ── Inline Idempotency-Key: the same run again, or a conflict ──
        // (anonymous callers are keyed by address: the same one each time)
        const same = await run('lorem', { input: { unit: 'words', count: 4 } }, { headers: { 'Idempotency-Key': 'inline-key-0002', 'X-Forwarded-For': '192.0.2.9' } });
        const replay = await run('lorem', { input: { unit: 'words', count: 4 } }, { headers: { 'Idempotency-Key': 'inline-key-0002', 'X-Forwarded-For': '192.0.2.9' } });
        assert.strictEqual(replay.h.get('idempotent-replayed'), 'true');
        assert.deepStrictEqual(replay.body, same.body, 'a random generator gives the first answer again');
        checkProblem(await run('lorem', { input: { unit: 'words', count: 5 } }, { headers: { 'Idempotency-Key': 'inline-key-0002', 'X-Forwarded-For': '192.0.2.9' } }), 409, 'tools.job.idempotency_conflict', 'same key, other input');

        // ── Job tools through the gateway ──
        const png = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#0a0' } }).png().toBuffer();
        const upload = (fields, files) => {
            const fd = new FormData();
            for (const [k, v] of Object.entries(fields)) fd.append(k, typeof v === 'string' ? v : JSON.stringify(v));
            for (const f of files) fd.append('file', new Blob([f.data], f.type ? { type: f.type } : {}), f.name);
            return fd;
        };
        const person = net.user();
        const as = { Authorization: `Bearer ${person}` };
        // Finished within wait_ms: 200 with the result files.
        r = await call('/api/v1/tools/webp/run', { form: upload({ input: { quality: 70 }, wait_ms: '10000' }, [{ name: 'photo.png', data: png }]), headers: as });
        assert.strictEqual(r.status, 200, r.text);
        checkRun(r.body, 'webp waited');
        assert.strictEqual(r.body.state, 'succeeded');
        assert.deepStrictEqual([r.body.job.tool, r.body.job.service, r.body.job.type], ['webp', 'img', 'img.process']);
        assert.strictEqual(r.body.result.files[0].mime, 'image/webp');
        assert.strictEqual(r.body.result.files[0].name, 'photo.webp');
        assert.strictEqual(r.body.result.data.output.ext, 'webp');
        const webpJob = r.body.job;
        let f = await fetch(`${G}${r.body.result.files[0].url}`, { headers: as });
        assert.strictEqual(f.status, 200);
        assert.strictEqual((await sharp(Buffer.from(await f.arrayBuffer())).metadata()).format, 'webp', 'the file, through the gateway\'s facade');
        // Not waiting: 202 + Location, then the job.
        const k1 = 'job-key-00000001';
        r = await call('/api/v1/tools/png/run', { form: upload({ input: {} }, [{ name: 'x.png', data: png }]), headers: { ...as, 'Idempotency-Key': k1 } });
        assert.strictEqual(r.status, 202, r.text);
        checkRun(r.body, 'png 202');
        assert.ok(['queued', 'running'].includes(r.body.state));
        assert.strictEqual(r.h.get('location'), `/api/v1/jobs/${r.body.job.id}`);
        assert.strictEqual(r.body.location, r.h.get('location'));
        const pngJob = r.body.job.id;
        // The same key and request: the same job (200 + Idempotent-Replayed).
        r = await call('/api/v1/tools/png/run', { form: upload({ input: {} }, [{ name: 'x.png', data: png }]), headers: { ...as, 'Idempotency-Key': k1 } });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.h.get('idempotent-replayed'), 'true');
        assert.strictEqual(r.body.job.id, pngJob);
        checkRun(r.body, 'png replay');
        // Another request under that key: 409.
        r = await call('/api/v1/tools/png/run', { form: upload({ input: { quality: 5 } }, [{ name: 'x.png', data: png }]), headers: { ...as, 'Idempotency-Key': k1 } });
        checkProblem(r, 409, 'tools.job.idempotency_conflict', 'job key reused');
        // A declared type the bytes contradict is corrected; bytes that are no image are refused (415).
        r = await call('/api/v1/tools/png/run', { form: upload({ wait_ms: '10000' }, [{ name: 'x.bin', data: png, type: 'application/octet-stream' }]), headers: as });
        assert.strictEqual(r.body.state, 'succeeded', 'sniffed as PNG whatever the part said');
        r = await call('/api/v1/tools/png/run', { form: upload({}, [{ name: 'x.png', data: Buffer.from('not an image at all') }]), headers: as });
        checkProblem(r, 415, 'tools.file.unsupported_type', 'sniffing');
        r = await call('/api/v1/tools/png/run', { form: upload({}, [{ name: 'a.png', data: png }, { name: 'b.png', data: png }]), headers: as });
        checkProblem(r, 400, 'tools.run.invalid', 'two files for a one-file tool');
        checkProblem(await run('png', { input: {} }, { headers: as }), 400, 'tools.run.invalid', 'no file');
        r = await call('/api/v1/tools/png/run', { form: upload({ input: { quality: 500 } }, [{ name: 'x.png', data: png }]), headers: as });
        checkProblem(r, 422, 'tools.input.invalid', 'job input schema');
        // A program the engine needs is missing (HEIC without libheif): the run fails with tools.unavailable.
        const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(4), Buffer.from('mif1heic'), Buffer.alloc(64)]);
        r = await call('/api/v1/tools/convert/run', { form: upload({ input: { format: 'png' }, wait_ms: '10000' }, [{ name: 'p.heic', data: heic }]), headers: as });
        checkRun(r.body, 'heic');
        assert.deepStrictEqual([r.body.state, r.body.error.status, r.body.error.code], ['failed', 503, 'tools.unavailable'], JSON.stringify(r.body.error));
        checkProblem(await run('heic', { input: {} }, { headers: as }), 503, 'tools.tool.unavailable', 'the heic tool itself');

        // Docs: a session, a sign-in or a token (auth.anonymous false).
        const pdf = async (pages) => { const d = await PDFDocument.create(); for (let i = 0; i < pages; i++) d.addPage([100, 100]); return Buffer.from(await d.save()); };
        const p1 = await pdf(1), p2 = await pdf(2);
        r = await call('/api/v1/tools/mergepdf/run', { form: upload({}, [{ name: 'a.pdf', data: p1 }, { name: 'b.pdf', data: p2 }]) });
        checkProblem(r, 401, 'tools.session_required', 'merge, anonymous');
        r = await call('/api/v1/tools/mergepdf/run', { form: upload({ input: { order: [1, 0] }, wait_ms: '15000' }, [{ name: 'a.pdf', data: p1 }, { name: 'b.pdf', data: p2 }]), headers: as });
        checkRun(r.body, 'merge');
        assert.deepStrictEqual([r.body.state, r.body.result.data.pageCount, r.body.job.service], ['succeeded', 3, 'docs']);
        // A file reference: the webp result (img) into Image to PDF (docs), same owner.
        r = await run('image2pdf', { input: { pageSize: 'fit' }, files: [{ job_id: webpJob.id, index: 0 }], wait_ms: 15000 }, { headers: as });
        checkRun(r.body, 'image2pdf from a job reference');
        assert.strictEqual(r.body.state, 'succeeded', JSON.stringify(r.body.error || r.body));
        assert.strictEqual(r.body.result.data.pageCount, 1);
        // Somebody else's job, or no such file: 404 tools.run.file_not_found.
        checkProblem(await run('image2pdf', { files: [{ job_id: webpJob.id, index: 0 }] }, { headers: { Authorization: `Bearer ${net.user()}` } }), 404, 'tools.run.file_not_found', 'another owner\'s job');
        checkProblem(await run('image2pdf', { files: [{ job_id: webpJob.id, index: 3 }] }, { headers: as }), 404, 'tools.run.file_not_found', 'no such index');
        checkProblem(await run('image2pdf', { files: [{ media_id: 'med_01J00000000000000000000000' }] }, { headers: as }), 404, 'tools.run.file_not_found', 'unknown media id');
        checkProblem(await run('image2pdf', { files: [{ job_id: 'nope' }] }, { headers: as }), 400, 'tools.run.invalid', 'a malformed reference');

        // ── Origin check (CSRF): cookies from another site's page ──
        const session = (await call('/api/context', { method: 'GET', base: img.base })).h.get('set-cookie').split(';')[0];
        const evil = { Cookie: session, Origin: 'https://evil.example' };
        r = await run('slug', { input: { text: 'x' } }, { headers: evil });
        checkProblem(r, 403, 'tools.origin.refused', 'cookie + foreign origin');
        assert.strictEqual(r.h.get('access-control-allow-origin'), '*', 'another site gets CORS without credentials');
        assert.ok(!r.h.get('access-control-allow-credentials'));
        assert.strictEqual((await run('slug', { input: { text: 'x' } }, { headers: { Cookie: session, Origin: 'https://slug.openvibe.tools' } })).status, 200, 'our own pages');
        assert.strictEqual((await run('slug', { input: { text: 'x' } }, { headers: { Origin: 'https://evil.example' } })).status, 200, 'no cookies: nothing to forge');
        assert.strictEqual((await run('slug', { input: { text: 'x' } }, { headers: { ...evil, Authorization: `Bearer ${net.service(['tools.tool.run'])}` } })).status, 200, 'a Bearer token is not a cookie');
        r = await call('/api/v1/tools/png/run', { form: upload({}, [{ name: 'x.png', data: png }]), headers: evil });
        checkProblem(r, 403, 'tools.origin.refused', 'a job tool, checked on its satellite');
        // The older endpoints' CORS already turns a foreign Origin away; a foreign Referer alone is refused here.
        r = await call('/api/process', { base: img.base, form: upload({ tool: 'convert', format: 'webp' }, [{ name: 'x.png', data: png, type: 'image/png' }]), headers: { Cookie: session, Referer: 'https://evil.example/page' } });
        checkProblem(r, 403, 'tools.origin.refused', 'the older endpoints too');
        r = await call('/api/v1/jobs', { base: img.base, form: upload({ type: 'img.process', input: { tool: 'convert' } }, [{ name: 'x.png', data: png, type: 'image/png' }]), headers: { Cookie: session, Origin: 'https://evil.example' } });
        assert.strictEqual(r.status, 403, 'and the job routes');
        // Preflight from another site's page.
        r = await call('/api/v1/tools/slug/run', { method: 'OPTIONS', headers: { Origin: 'https://app.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type,idempotency-key' } });
        assert.strictEqual(r.status, 204);
        assert.strictEqual(r.h.get('access-control-allow-origin'), '*');
        assert.match(r.h.get('access-control-allow-headers'), /Idempotency-Key/);

        // ── The older endpoints: same answers, and what replaces them ──
        r = await call('/api/net/myip', { method: 'GET' });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.ok, true, 'the legacy shape');
        assert.strictEqual(r.h.get('deprecation'), 'true');
        assert.strictEqual(r.h.get('sunset'), 'Thu, 31 Dec 2026 23:59:59 GMT');
        assert.strictEqual(r.h.get('link'), '</api/v1/tools/myip/run>; rel="successor-version"');
        assert.strictEqual((await call('/api/net/dns/example.invalid?types=MX', { method: 'GET' })).h.get('link'), '</api/v1/tools/dns/run>; rel="successor-version"');
        assert.strictEqual((await call('/api/dev/tools', { method: 'GET' })).h.get('link'), '</api/v1/tools?family=dev>; rel="successor-version"');
        r = await call('/api/process', { base: img.base, form: upload({ tool: 'convert', format: 'webp' }, [{ name: 'x.png', data: png, type: 'image/png' }]) });
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.body.success, true, 'the legacy shape');
        assert.strictEqual(r.h.get('deprecation'), 'true');
        assert.strictEqual(r.h.get('link'), '</api/v1/tools/convert/run>; rel="successor-version"');
        {
            // On png.openvibe.tools the successor is png's run route (fetch cannot set Host: node:http).
            const req = new Request('http://x/', { method: 'POST', body: upload({ tool: 'convert' }, [{ name: 'x.png', data: png, type: 'image/png' }]) });
            const bodyBuf = Buffer.from(await req.arrayBuffer());
            const link = await new Promise((resolve, reject) => {
                const q = require('http').request({ host: '127.0.0.1', port: img.port, method: 'POST', path: '/api/process', headers: { Host: 'png.openvibe.tools', 'Content-Type': req.headers.get('content-type'), 'Content-Length': bodyBuf.length, 'X-Forwarded-For': freshIp() } }, (res) => { res.resume(); resolve(res.headers.link); });
                q.on('error', reject); q.end(bodyBuf);
            });
            assert.strictEqual(link, '</api/v1/tools/png/run>; rel="successor-version"', 'the host\'s own tool');
        }

        // ── Health shows the run API ──
        const health = (await call('/api/health', { method: 'GET' })).body;
        assert.ok(health.run.runs > 50 && health.run.cached >= 2 && health.run.proxied >= 5, JSON.stringify(health.run));
        assert.ok(health.run.engines.completed >= 5, 'engines ran in worker threads');
    } finally {
        for (const p of procs) await p.kill('SIGTERM');
        await net.close();
    }
    console.log('run API: inline engines (cache, fresh), net routes (myip, SSRF), refusals and contract codes, probes need tools.net.probe, quotas, inline and job idempotency, job tools via the gateway (wait, 202, sniffing, schema), tools.unavailable vs tools.tool.unavailable, session rule, cross-satellite job references, CSRF origin check + CORS, deprecation headers: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
