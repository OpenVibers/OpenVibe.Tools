'use strict';
// openvibe-sdk v0.6.0's Tools client (createToolsClient: registry, run API, jobs facade) against the
// real gateway, img and docs, exactly as a developer uses it: no baseUrl (the `tools` origin), the
// registry read without a token, a sync tool run anonymously, a job tool with an upload (202, then
// wait() over the facade's SSE, then the file), waitMs, Idempotency-Key replays, a job's result fed
// to the next tool by reference, ToolRunError for a failed run, OpenVibeError for a refusal, and a
// probe with a tools.net.probe token.
//
// The SDK is required from a checkout next to this repo (../../../../OpenVibe.SDK, or OV_SDK_DIR);
// without one this test says so and passes (it is not a dependency of any app).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startApp, freePort } = require('../../_shared/test/spawn');
const { startNetwork } = require('../../_shared/test/network');

const SDK = process.env.OV_SDK_DIR || path.join(__dirname, '..', '..', '..', '..', 'OpenVibe.SDK');
if (!fs.existsSync(path.join(SDK, 'src', 'tools.js'))) {
    console.log(`sdk client: skipped (no OpenVibe.SDK checkout with src/tools.js at ${SDK}; set OV_SDK_DIR)`);
    process.exit(0);
}
const sdkVersion = require(path.join(SDK, 'package.json')).version;
const { createClient, isOpenVibeError } = require(path.join(SDK, 'src', 'core'));
const { createToolsClient, isToolRunError } = require(path.join(SDK, 'src', 'tools'));

const APPS = path.join(__dirname, '..', '..');
const sharp = require(require.resolve('sharp', { paths: [path.join(APPS, 'img')] }));
const rejects = (p) => p.then((v) => { throw new Error(`expected a rejection, got ${JSON.stringify(v).slice(0, 200)}`); }, (err) => err);

(async () => {
    assert.ok(/^0\.(6|[7-9])\.|^[1-9]/.test(sdkVersion), `the SDK is v0.6.0 or later (${sdkVersion})`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-sdk-client-'));
    const net = await startNetwork();
    const procs = [];
    const start = async (...a) => { const p = await startApp(...a); procs.push(p); return p; };
    try {
        const ports = { img: await freePort(), docs: await freePort() };
        const env = { OV_NETWORK_URL: net.url, OV_NETWORK_INTERNAL_URL: net.url, TOOLS_SATELLITE_PORTS: `img=${ports.img},docs=${ports.docs}` };
        await start('img', { ...env, DATA_DIR: path.join(tmp, 'img'), UPLOADS_DIR: path.join(tmp, 'img', 'up'), OUTPUT_DIR: path.join(tmp, 'img', 'out') }, ports.img);
        await start('docs', { ...env, DATA_DIR: path.join(tmp, 'docs'), UPLOADS_DIR: path.join(tmp, 'docs', 'up'), OUTPUT_DIR: path.join(tmp, 'docs', 'out') }, ports.docs);
        const gw = await start('gateway', { ...env, DATA_DIR: path.join(tmp, 'gw'), OV_DOMAINS_URL: 'http://127.0.0.1:9/api/domains', OV_REGISTRY_URL: 'http://127.0.0.1:9/registry' });

        // The `tools` service origin is the gateway (what discovery gives in production).
        const client = (token) => createClient({ baseUrls: { tools: gw.base }, autoDiscover: false, ...(token && { token }), onWarning: () => {} });
        const anon = createToolsClient(client());
        const person = createToolsClient(client(net.user()));

        // ── Registry ──
        const list = await anon.list({ family: 'dev', api: true });
        assert.ok(list.count >= 20 && list.tools.every(t => t.family === 'dev' && t.api), 'filtered list');
        const png = await anon.get('png');
        assert.deepStrictEqual([png.id, png.execution, png.run.job.type], ['png', 'job', 'img.process']);
        assert.strictEqual(await anon.get('nosuchtool'), null, 'no such tool → null');
        const schema = await anon.schema('jsonminify');
        assert.deepStrictEqual(schema.$defs.input.required, ['text']);

        // ── A sync tool, anonymously ──
        const out = await anon.run('jsonminify', { text: '{\n  "a": [1, 2]\n}' });
        assert.deepStrictEqual([out.state, out.tool, out.result.text, out.replayed], ['succeeded', 'jsonminify', '{"a":[1,2]}', false]);
        assert.match(out.idempotencyKey, /^[!-~]{8,200}$/, 'the SDK sent an Idempotency-Key');
        assert.strictEqual(await out.wait(), out, 'a finished run waits for nothing');
        const again = await anon.run('jsonminify', { text: '{\n  "a": [1, 2]\n}' }, { idempotencyKey: out.idempotencyKey });
        assert.strictEqual(again.replayed, true, 'the same key again: the same run');
        const lookup = await anon.run('ipv4', { target: '192.0.2.0/30' });
        assert.strictEqual(lookup.result.data.cidr.usable, 2);
        // The tool's own failure → ToolRunError; a refusal → OpenVibeError with the problem's code.
        let err = await rejects(anon.run('jsonminify', { text: '{ bad' }));
        assert.ok(isToolRunError(err), err.message);
        assert.deepStrictEqual([err.state, err.code, err.status, err.tool], ['failed', 'tools.job.failed', 422, 'jsonminify']);
        err = await rejects(anon.run('yt', {}));
        assert.ok(isOpenVibeError(err) && !isToolRunError(err));
        assert.deepStrictEqual([err.status, err.code], [404, 'tools.tool.not_runnable']);
        err = await rejects(anon.run('jsonminify', { text: 'x', nope: true }));
        assert.deepStrictEqual([err.status, err.code], [422, 'tools.input.invalid']);
        assert.ok(Array.isArray(err.errors) && err.errors[0].path === '/nope');
        err = await rejects(anon.run('ping', { target: '192.0.2.1' }));
        assert.deepStrictEqual([err.status, err.code], [401, 'token.missing'], 'probes need a token');

        // ── A job tool: 202, wait() over the facade's events, the file ──
        const image = await sharp({ create: { width: 10, height: 8, channels: 3, background: '#c00' } }).png().toBuffer();
        const queued = await person.run('webp', { quality: 60 }, { files: [{ name: 'photo.png', data: image, type: 'image/png' }] });
        assert.ok(['queued', 'running', 'succeeded'].includes(queued.state), queued.state);
        assert.ok(queued.job && /^\/api\/v1\/jobs\/job_/.test(queued.location));
        const seen = [];
        const done = await queued.wait({ onEvent: (e) => { seen.push(e.event); } });
        assert.deepStrictEqual([done.state, done.tool, done.job.tool], ['succeeded', 'webp', 'webp']);
        assert.ok(queued.state === 'succeeded' || seen.includes('job.succeeded'), `events: ${seen.join(', ')}`);
        const file = done.result.files[0];
        assert.deepStrictEqual([file.name, file.mime], ['photo.webp', 'image/webp']);
        const res = await person.jobs.file(done.job.id, 0);
        assert.strictEqual((await sharp(Buffer.from(await res.arrayBuffer())).metadata()).format, 'webp', 'the file through the facade');
        assert.strictEqual((await person.jobs.get(done.job.id)).state, 'succeeded', 'jobs.get through the facade');

        // waitMs: answered finished (200); an upload without a declared type is sniffed.
        const quick = await person.run('png', {}, { files: [{ name: 'again.bin', data: image }], waitMs: 15000 });
        assert.strictEqual(quick.state, 'succeeded');
        assert.strictEqual(quick.result.files[0].mime, 'image/png');
        // The same key and request again: the same job.
        const key = 'sdk-job-key-0001';
        const k1 = await person.run('jpg', {}, { files: [{ name: 'k.png', data: image, type: 'image/png' }], idempotencyKey: key });
        const k2 = await person.run('jpg', {}, { files: [{ name: 'k.png', data: image, type: 'image/png' }], idempotencyKey: key });
        assert.strictEqual(k2.replayed, true);
        assert.strictEqual(k2.job.id, k1.job.id);
        // One tool's result feeds the next (img → docs), by reference.
        const pdf = await person.run('image2pdf', { pageSize: 'fit' }, { files: [{ job_id: done.job.id, index: 0 }], waitMs: 15000 });
        assert.deepStrictEqual([pdf.state, pdf.result.data.pageCount, pdf.job.service], ['succeeded', 1, 'docs']);
        // A job that fails: ToolRunError with the job attached (retry through the facade).
        const broken = Buffer.concat([image.subarray(0, 40), Buffer.alloc(100, 3)]);
        err = await rejects(person.run('png', {}, { files: [{ name: 'broken.png', data: broken }], waitMs: 15000 }));
        assert.ok(isToolRunError(err), err.message);
        assert.strictEqual(err.state, 'failed');
        assert.ok(err.job && err.job.id);
        const retried = await person.jobs.retry(err.job.id);
        assert.strictEqual(retried.job.retry_of, err.job.id, 'jobs.retry through the facade');

        // ── A probe with tools.net.probe: authorized (the SSRF guard keeps it off this host) ──
        const prober = createToolsClient(client(net.service(['tools.net.probe'], { name: 'prober' })));
        err = await rejects(prober.run('ping', { target: '127.0.0.1', count: 1 }));
        assert.ok(isToolRunError(err));
        assert.strictEqual(err.code, 'tools.net.target_not_public');
    } finally {
        for (const p of procs) await p.kill('SIGTERM');
        await net.close();
    }
    console.log(`sdk client (openvibe-sdk ${sdkVersion}): registry, sync run + replay, ToolRunError vs refusals, job run + wait() + file via the facade, waitMs, idempotent job, job reference chain img → docs, retry, probe token: all checks passed`);
})().catch((err) => { console.error(err); process.exit(1); });
