'use strict';
// Img.OpenVibe as a real process: an image job accepted by one process is finished by the next one
// after a SIGKILL; the synchronous endpoint keeps working; the page honours X-OV-Canonical-Host.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { startApp } = require('../../_shared/test/spawn');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-img-'));
    const env = { DATA_DIR: data, UPLOADS_DIR: path.join(data, 'uploads'), OUTPUT_DIR: path.join(data, 'output') };
    const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 30, b: 90 } } }).png().toBuffer();
    let app;
    try {
        // Accepts but runs nothing, so the job is still queued when the process dies.
        app = await startApp('img', { ...env, TOOLS_JOBS_CONCURRENCY_IMG: '0' });
        const fd = new FormData();
        fd.append('type', 'img.process');
        fd.append('input', JSON.stringify({ tool: 'convert', format: 'webp', quality: '80' }));
        fd.append('file', new Blob([png], { type: 'image/png' }), 'red.png');
        let r = await fetch(`${app.base}/api/v1/jobs`, { method: 'POST', body: fd, headers: { 'Idempotency-Key': 'img-test-0001' } });
        assert.strictEqual(r.status, 202, await r.clone().text());
        const cookie = r.headers.get('set-cookie').split(';')[0];
        const job = await r.json();
        assert.strictEqual(job.type, 'img.process');
        assert.strictEqual(job.state, 'queued');
        await app.kill('SIGKILL');

        app = await startApp('img', env, app.port);
        let done;
        for (let i = 0; i < 100; i++) {
            done = await (await fetch(`${app.base}/api/v1/jobs/${job.id}`, { headers: { cookie } })).json();
            if (done.state === 'succeeded' || done.state === 'failed') break;
            await sleep(100);
        }
        assert.strictEqual(done.state, 'succeeded', JSON.stringify(done.error));
        assert.strictEqual(done.result.data.output.ext, 'webp');
        assert.strictEqual(done.result.files[0].name, 'red.webp');
        r = await fetch(`${app.base}${done.result.files[0].url}`, { headers: { cookie } });
        const bytes = Buffer.from(await r.arrayBuffer());
        assert.strictEqual(bytes.slice(8, 12).toString(), 'WEBP', 'the result is a WebP');
        assert.strictEqual((await sharp(bytes).metadata()).width, 64);
        r = await fetch(`${app.base}/api/v1/jobs/${job.id}`);
        assert.strictEqual(r.status, 404, 'another browser cannot see it');

        // A format host fills in its format: through the gateway, the jpg tool converts to JPG.
        const fd2 = new FormData();
        fd2.append('type', 'img.process');
        fd2.append('file', new Blob([png], { type: 'image/png' }), 'x.png');
        r = await fetch(`${app.base}/api/v1/jobs`, { method: 'POST', body: fd2, headers: { cookie, 'X-OV-Tool': 'jpg' } });
        const hosted = await r.json();
        for (let i = 0; i < 100 && hosted.state !== 'succeeded'; i++) { await sleep(100); Object.assign(hosted, await (await fetch(`${app.base}/api/v1/jobs/${hosted.id}`, { headers: { cookie } })).json()); }
        assert.strictEqual(hosted.result.data.output.ext, 'jpg');

        // Errors on the job API are problem+json, including the upload middleware's.
        r = await fetch(`${app.base}/api/v1/jobs`, { method: 'POST', body: (() => { const f = new FormData(); f.append('type', 'img.process'); return f; })() });
        assert.strictEqual(r.status, 400);
        assert.match(r.headers.get('content-type'), /problem\+json/);
        assert.strictEqual((await r.json()).code, 'tools.job.invalid');

        // The synchronous endpoint is unchanged.
        const sync = new FormData();
        sync.append('tool', 'resize'); sync.append('width', '32');
        sync.append('file', new Blob([png], { type: 'image/png' }), 'red.png');
        r = await fetch(`${app.base}/api/process`, { method: 'POST', body: sync });
        const body = await r.json();
        assert.strictEqual(body.success, true);
        assert.match(body.download.downloadUrl, /^\/api\/download\/[a-f0-9]{32}$/);
        assert.strictEqual(body.dimensions.resized.width, 32);

        // Canonical host: through the gateway the page names the host the gateway says.
        // (fetch cannot set Host, so pages are requested with http.request)
        const page = (headers) => new Promise((resolve, reject) => {
            http.get({ host: '127.0.0.1', port: app.port, path: '/', headers }, (res) => {
                let text = ''; res.setEncoding('utf8'); res.on('data', c => { text += c; });
                res.on('end', () => resolve({ status: res.statusCode, headers: { get: (k) => res.headers[k.toLowerCase()] }, text: async () => text }));
            }).on('error', reject);
        });
        let html = await (await page({ Host: 'png.openvibe.tools', 'X-OV-Tool': 'png', 'X-OV-Host-Role': 'short', 'X-OV-Canonical-Host': 'png-converter.example.com', 'X-OV-Short-Host': 'png.openvibe.tools' })).text();
        assert.ok(html.includes('<link rel="canonical" href="https://png-converter.example.com/">'), 'canonical follows X-OV-Canonical-Host');
        assert.ok(html.includes('"url":"https://png-converter.example.com/"'), 'so does the JSON-LD');
        assert.ok(/OpenVibePNG/.test(html), 'and the page is still the PNG tool');
        html = await (await page({ Host: 'png-converter.example.com', 'X-OV-Tool': 'png', 'X-OV-Host-Role': 'canonical', 'X-OV-Canonical-Host': 'png-converter.example.com' })).text();
        assert.ok(/OpenVibePNG/.test(html), 'a custom domain gets its tool through X-OV-Tool');
        html = await (await page({ Host: 'webp.openvibe.tools' })).text();
        assert.ok(html.includes('<link rel="canonical" href="https://webp.openvibe.tools/">'), 'reached directly, each host is its own canonical');
        r = await page({ Host: 'pngs.openvibe.tools', 'X-OV-Tool': 'png', 'X-OV-Host-Role': 'alias', 'X-OV-Canonical-Host': 'png-converter.example.com', 'X-OV-Short-Host': 'png.openvibe.tools' });
        assert.strictEqual(r.status, 301); assert.strictEqual(r.headers.get('location'), 'https://png.openvibe.tools/');
        r = await page({ Host: 'made-up.example.org' });
        assert.strictEqual(r.status, 301, 'a host this app does not serve goes to the tools index');

        await app.kill('SIGTERM');
        console.log('img jobs + canonical host: all checks passed');
    } catch (err) {
        if (app) { console.error(app.output()); await app.kill('SIGKILL'); }
        throw err;
    } finally {
        fs.rmSync(data, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exit(1); });
