'use strict';
// The gateway's /api/v1/jobs facade (apps/gateway/server/run/jobs-facade.js) on real processes: the
// gateway in front of img and docs, a stand-in Network for tokens.
//   • submits are routed by the job type's prefix: JSON, a multipart `type` part read from the head of
//     the stream (uploads stream on), or ?type=; a type it cannot find or does not know is refused
//   • everything else is routed by the job id: the satellite that answered (remembered), else the one
//     that says it holds the job on loopback (after a gateway restart); reads, cancel, retry (the new
//     job is remembered), references, SSE events and result files all stream through
//   • owners stay the satellite's business (another person gets 404), unknown ids are 404
//   • the loopback probe (GET /api/internal/jobs/:id) answers direct callers only and is never limited
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startApp, freePort } = require('./spawn');
const { startNetwork } = require('./network');

const APPS = path.join(__dirname, '..', '..');
const sharp = require(require.resolve('sharp', { paths: [path.join(APPS, 'img')] }));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-jobs-facade-'));
    const net = await startNetwork();
    const procs = [];
    const start = async (...a) => { const p = await startApp(...a); procs.push(p); return p; };
    try {
        const ports = { img: await freePort(), docs: await freePort(), gw: await freePort() };
        const env = { OV_NETWORK_URL: net.url, OV_NETWORK_INTERNAL_URL: net.url, TOOLS_SATELLITE_PORTS: `img=${ports.img},docs=${ports.docs}` };
        const img = await start('img', { ...env, DATA_DIR: path.join(tmp, 'img'), UPLOADS_DIR: path.join(tmp, 'img', 'up'), OUTPUT_DIR: path.join(tmp, 'img', 'out') }, ports.img);
        // docs never starts a job here: its jobs stay queued (cancel).
        const docs = await start('docs', { ...env, DATA_DIR: path.join(tmp, 'docs'), UPLOADS_DIR: path.join(tmp, 'docs', 'up'), OUTPUT_DIR: path.join(tmp, 'docs', 'out'), TOOLS_JOBS_CONCURRENCY_DOCS: '0' }, ports.docs);
        const gwEnv = { ...env, DATA_DIR: path.join(tmp, 'gw'), OV_DOMAINS_URL: 'http://127.0.0.1:9/api/domains', OV_REGISTRY_URL: 'http://127.0.0.1:9/registry' };
        let gw = await start('gateway', gwEnv, ports.gw);
        const G = gw.base;
        const me = { Authorization: `Bearer ${net.user()}` };
        const other = { Authorization: `Bearer ${net.user()}` };
        const req = async (p, { method = 'GET', headers = {}, body, base = G } = {}) => {
            const r = await fetch(`${base}${p}`, { method, headers, body });
            const text = await r.text();
            let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
            return { status: r.status, h: r.headers, text, body: json };
        };
        const png = await sharp({ create: { width: 6, height: 6, channels: 3, background: '#00f' } }).png().toBuffer();
        const form = (parts) => {
            const fd = new FormData();
            for (const [k, v] of parts) { if (v instanceof Blob) fd.append(k, v, 'x.png'); else fd.append(k, String(v)); }
            return fd;
        };
        const finished = async (id, headers) => {
            for (let i = 0; i < 100; i++) {
                const r = await req(`/api/v1/jobs/${id}`, { headers });
                if (['succeeded', 'failed', 'cancelled'].includes(r.body.state)) return r.body;
                await sleep(50);
            }
            throw new Error(`${id} did not finish`);
        };

        // ── Submit, routed by the multipart type part ──
        let r = await req('/api/v1/jobs', { method: 'POST', headers: me, body: form([['type', 'img.process'], ['input', JSON.stringify({ tool: 'convert', format: 'webp' })], ['file', new Blob([png])]]) });
        assert.strictEqual(r.status, 202, r.text);
        assert.strictEqual(r.body.service, 'img');
        assert.strictEqual(r.h.get('location'), `/api/v1/jobs/${r.body.id}`);
        const job = r.body.id;
        const done = await finished(job, me);
        assert.strictEqual(done.state, 'succeeded', JSON.stringify(done.error));
        // Events stream through (SSE, ids, the terminal event).
        {
            const res = await fetch(`${G}/api/v1/jobs/${job}/events`, { headers: { ...me, Accept: 'text/event-stream' } });
            // Finished and nothing newer than Last-Event-ID 0? It replays the whole log first.
            assert.strictEqual(res.status, 200);
            assert.match(res.headers.get('content-type'), /text\/event-stream/);
            const text = await res.text();
            assert.match(text, /^retry: 3000/);
            assert.match(text, /id: \d+\nevent: job\.succeeded\n/);
            const last = Math.max(...[...text.matchAll(/^id: (\d+)$/gm)].map(m => Number(m[1])));
            const again = await fetch(`${G}/api/v1/jobs/${job}/events`, { headers: { ...me, 'Last-Event-ID': String(last) } });
            assert.strictEqual(again.status, 204, 'nothing after the last event: 204');
        }
        // The result file streams through.
        r = await fetch(`${G}/api/v1/jobs/${job}/files/0`, { headers: me });
        assert.strictEqual(r.status, 200);
        assert.match(r.headers.get('content-disposition'), /attachment; filename="x\.webp"/);
        assert.strictEqual((await sharp(Buffer.from(await r.arrayBuffer())).metadata()).format, 'webp');
        // References through the facade.
        r = await req(`/api/v1/jobs/${job}/references/community:paste:p_1`, { method: 'PUT', headers: me });
        assert.strictEqual(r.status, 201, r.text);
        assert.strictEqual(r.body.expires_at, null);
        r = await req(`/api/v1/jobs/${job}/references/community:paste:p_1`, { method: 'DELETE', headers: me });
        assert.strictEqual(r.status, 200);
        assert.ok(r.body.expires_at);
        // Somebody else: the satellite's 404, as for a job that does not exist.
        r = await req(`/api/v1/jobs/${job}`, { headers: other });
        assert.deepStrictEqual([r.status, r.body.code], [404, 'tools.job.not_found']);
        r = await req('/api/v1/jobs/job_01J00000000000000000000000', { headers: me });
        assert.deepStrictEqual([r.status, r.body.code], [404, 'tools.job.not_found']);
        assert.strictEqual((await req('/api/v1/jobs/not-a-job', { headers: me })).status, 404);

        // ── A failed job, retried through the facade (the new job is remembered) ──
        const broken = Buffer.concat([png.subarray(0, 40), Buffer.alloc(200, 7)]);   // a PNG header, then noise
        r = await req('/api/v1/jobs', { method: 'POST', headers: me, body: form([['type', 'img.process'], ['input', JSON.stringify({ tool: 'convert', format: 'png' })], ['file', new Blob([broken])]]) });
        assert.strictEqual(r.status, 202, r.text);
        const failed = await finished(r.body.id, me);
        assert.strictEqual(failed.state, 'failed');
        r = await req(`/api/v1/jobs/${failed.id}/retry`, { method: 'POST', headers: me });
        assert.strictEqual(r.status, 202, r.text);
        assert.strictEqual(r.body.retry_of, failed.id);
        const retried = r.body.id;
        assert.strictEqual((await finished(retried, me)).state, 'failed');

        // ── docs: JSON body type; ?type= when the type part comes late; cancel a queued job ──
        r = await req('/api/v1/jobs', { method: 'POST', headers: { ...me, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'docs.process', input: { tool: 'merge' } }) });
        assert.deepStrictEqual([r.status, r.body.code], [400, 'tools.job.invalid'], 'routed to docs, which wants files');
        assert.match(r.body.detail, /at least 2 files|needs a file/);
        const big = Buffer.alloc(1024 * 1024, 1);
        const pdfish = Buffer.concat([Buffer.from('%PDF-1.4\n'), big]);
        r = await req('/api/v1/jobs', { method: 'POST', headers: me, body: form([['file', new Blob([pdfish])], ['type', 'docs.process'], ['input', JSON.stringify({ tool: 'compress' })]]) });
        assert.deepStrictEqual([r.status, r.body.code], [400, 'tools.job.invalid'], 'a type part after the first 64 KB of the stream is not looked for');
        r = await req('/api/v1/jobs?type=docs.process', { method: 'POST', headers: me, body: form([['file', new Blob([pdfish])], ['type', 'docs.process'], ['input', JSON.stringify({ tool: 'compress' })]]) });
        assert.strictEqual(r.status, 202, r.text);
        assert.strictEqual(r.body.service, 'docs');
        const queued = r.body.id;
        r = await req(`/api/v1/jobs/${queued}`, { method: 'DELETE', headers: me });
        assert.deepStrictEqual([r.status, r.body.state], [200, 'cancelled']);
        r = await req('/api/v1/jobs', { method: 'POST', headers: { ...me, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'video.process' }) });
        assert.deepStrictEqual([r.status, r.body.code], [400, 'tools.job.unknown_type']);
        r = await req('/api/v1/jobs', { method: 'POST', headers: { ...me, 'Content-Type': 'application/json' }, body: '{"type":' });
        assert.deepStrictEqual([r.status, r.body.code], [400, 'tools.job.invalid']);
        assert.strictEqual((await req('/api/v1/jobs', { headers: me })).status, 405);

        // ── After a gateway restart: nothing remembered, the satellites are asked ──
        const before = (await req('/api/health')).body.jobs;
        assert.ok(before.known >= 4, JSON.stringify(before));
        await gw.kill('SIGTERM');
        procs.splice(procs.indexOf(gw), 1);
        gw = await start('gateway', gwEnv, ports.gw);
        for (const [id, want] of [[job, 'succeeded'], [retried, 'failed'], [queued, 'cancelled']]) {
            r = await req(`/api/v1/jobs/${id}`, { headers: me });
            assert.deepStrictEqual([r.status, r.body.state], [200, want], `${id} found again`);
        }
        const after = (await req('/api/health')).body.jobs;
        assert.strictEqual(after.probed, 3, 'each asked once');
        await req(`/api/v1/jobs/${job}`, { headers: me });
        assert.strictEqual((await req('/api/health')).body.jobs.probed, 3, 'then remembered');

        // ── The loopback probe: direct callers only, never limited ──
        r = await req(`/api/internal/jobs/${job}`, { base: img.base });
        assert.deepStrictEqual([r.status, r.body], [200, { id: job, service: 'img' }]);
        assert.strictEqual((await req(`/api/internal/jobs/${job}`, { base: docs.base })).status, 404, 'not on docs');
        assert.strictEqual((await req(`/api/internal/jobs/${job}`, { base: img.base, headers: { 'X-Forwarded-For': '203.0.113.5' } })).status, 404, 'through a proxy: nothing to see');
        const statuses = await Promise.all(Array.from({ length: 150 }, () => req(`/api/internal/jobs/${job}`, { base: img.base }).then(x => x.status)));
        assert.ok(statuses.every(s => s === 200), 'the facade\'s probes are never rate limited');
        // Through the gateway's host proxy it does not exist either.
        r = await req(`/api/internal/jobs/${job}`, { headers: { 'X-Forwarded-For': '203.0.113.5' } });
        assert.strictEqual(r.status, 404);
    } finally {
        for (const p of procs) await p.kill('SIGTERM');
        await net.close();
    }
    console.log('jobs facade: submit routed by type (multipart head, JSON, ?type=), by id (remembered, then probed after a restart), events/files/references/retry/cancel through, owner 404s, loopback probe: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
