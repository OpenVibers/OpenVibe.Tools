'use strict';
// The guard on the image satellite: no picture over the pixel limit is decoded (sharp's
// limitInputPixels, checked from the header first; BMP and ICO headers too), sniffing refuses a file
// that is not what its name and type say, the sync endpoint's refusals are problem+json, and the
// descriptor tells the same limit. TOOLS_MAX_INPUT_PIXELS is lowered here so small pictures show it.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TOOLS_MAX_INPUT_PIXELS = '10000';   // before anything reads the limit
const sharp = require('sharp');
const codec = require('../server/tools/codec');
const convert = require('../server/tools/convert');
const { startApp } = require('../../_shared/test/spawn');

(async () => {
    // ── The codec: the header's size decides, before anything is decoded ──
    const small = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#336699' } }).png().toBuffer();
    const big = await sharp({ create: { width: 200, height: 100, channels: 3, background: '#336699' } }).png().toBuffer();
    assert.strictEqual(codec.inputPixels(), 10000);
    const ok = await convert(small, { format: 'webp' });
    assert.strictEqual(ok.mime, 'image/webp', '100×100 is within 10 000 pixels');
    await assert.rejects(convert(big, { format: 'webp' }), (e) => e.status === 413 && e.code === 'tools.file.too_large' && e.guardReason === 'pixels' && /200×100/.test(e.message));
    // A BMP header claiming 30 000 × 30 000 is refused without allocating its pixels.
    const bmp = Buffer.alloc(54);
    bmp.write('BM', 0, 'latin1'); bmp.writeUInt32LE(54, 10); bmp.writeUInt32LE(40, 14);
    bmp.writeInt32LE(30000, 18); bmp.writeInt32LE(30000, 22); bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28);
    await assert.rejects(codec.open(bmp), (e) => e.guardReason === 'pixels');
    // An ICO whose directory says 256×256 (65 536 pixels) is refused from the directory.
    const ico = Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 32, 0]), Buffer.from([8, 0, 0, 0, 22, 0, 0, 0]), small.subarray(0, 8)]);
    await assert.rejects(codec.open(ico), (e) => e.guardReason === 'pixels');
    // The descriptors say the same limit.
    const { SPECS } = require('../server/descriptors');
    assert.ok(SPECS.every(s => s.limits.maxPixels === 10000), 'every image tool\'s limits.maxPixels is the guard\'s');

    // ── Through the app ──
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-img-guard-'));
    const app = await startApp('img', { DATA_DIR: data, UPLOADS_DIR: path.join(data, 'uploads'), OUTPUT_DIR: path.join(data, 'output'), TOOLS_MAX_INPUT_PIXELS: '10000' });
    const post = (buf, name, type, p = '/api/process') => {
        const f = new FormData();
        f.append('file', new Blob([buf], { type }), name);
        f.append('tool', 'convert');
        f.append('format', 'png');
        return fetch(`${app.base}${p}`, { method: 'POST', body: f });
    };
    try {
        let r = await post(big, 'big.png', 'image/png');
        assert.strictEqual(r.status, 413, 'the pixel limit applies in report mode too');
        let body = await r.json();
        assert.strictEqual(r.headers.get('content-type'), 'application/problem+json');
        assert.strictEqual(body.code, 'tools.file.too_large');
        r = await post(Buffer.from('%PDF-1.4\n%%EOF\n'), 'photo.png', 'image/png', '/api/process/direct');
        assert.strictEqual(r.status, 415, 'a PDF called photo.png is refused');
        assert.strictEqual((await r.json()).code, 'tools.file.unsupported_type');
        r = await post(small, 'photo.gif', 'image/gif');
        body = await r.json();
        assert.strictEqual(r.status, 200, JSON.stringify(body));
        assert.strictEqual(body.output.ext, 'png');
        // The job API refuses the same picture the same way (hard limit): the job fails with the code.
        const f = new FormData();
        f.append('type', 'img.process');
        f.append('input', JSON.stringify({ tool: 'convert', format: 'png' }));
        f.append('file', new Blob([Buffer.from('not an image at all')], { type: 'image/png' }), 'x.png');
        r = await fetch(`${app.base}/api/v1/jobs`, { method: 'POST', body: f });
        assert.strictEqual(r.status, 415, 'a job upload is sniffed before it is accepted');
        // Answers carry RateLimit headers and the sync endpoint is behind the semaphore.
        assert.ok(r.headers.get('ratelimit-limit'), 'RateLimit-Limit');
        const metrics = await (await fetch(`${app.base}/metrics`)).text();
        assert.match(metrics, /tools_guard_refused_total\{reason="pixels",tool="convert"\} 1/);
        assert.match(metrics, /tools_guard_refused_total\{reason="sniff",tool="convert"\} [12]/);
        assert.match(metrics, /tools_guard_sync\{kind="limit"\} 2/);
        assert.match(metrics, /tools_guard_enforcing 0/);
        assert.ok(fs.existsSync(path.join(data, 'guard.db')), 'guard.db in the data directory');
    } finally {
        await app.kill();
        fs.rmSync(data, { recursive: true, force: true });
    }
    console.log('img guard: pixel limit from headers (PNG, BMP, ICO) and in descriptors, sniffing on sync and job uploads, problem+json, metrics: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
