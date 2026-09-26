'use strict';
/**
 * The shared upload factory (roadmap WS-L task 3): memory and disk storage, the declared-type filter
 * (octet-stream let through for the guard's byte check), size and count limits with the { error }
 * answers the apps' pages read, sanitised disk names; and no satellite keeps its own copy.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { dep } = require('./deps');
const { createUploads } = require('../upload');

const express = dep('express');
const multer = dep('multer');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-uploads-'));
const config = { upload: { maxFileSize: 1024, allowedMimes: ['image/png', 'text/plain'] }, uploadsDir: dir };

async function serve(app) {
    const server = await new Promise((r) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => r(s)); });
    return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}
const form = (fields) => { const f = new FormData(); for (const [name, body, type, file] of fields) f.append(name, new Blob([body], { type }), file); return f; };

(async () => {
    assert.throws(() => createUploads({ config }), /needs multer/);
    assert.throws(() => createUploads({ multer }), /needs the app config/);

    const mem = createUploads({ multer, config, storage: 'memory' });
    const disk = createUploads({ multer, config, storage: 'disk', maxFiles: 2, rejectHint: 'Upload a PNG.' });
    const app = express();
    app.post('/mem', mem.uploadSingle, (req, res) => res.json({ size: req.file.size, buffer: Buffer.isBuffer(req.file.buffer) }));
    app.post('/disk', disk.uploadSingle, (req, res) => res.json({ name: path.basename(req.file.path), inDir: path.dirname(req.file.path) === path.resolve(dir) }));
    app.post('/many', disk.uploadMultiple, (req, res) => res.json({ n: req.files.length }));
    app.post('/any', disk.uploadAny, (req, res) => res.json({ n: Object.values(req.files).flat().length }));
    const s = await serve(app);
    const post = async (p, f) => { const r = await fetch(s.base + p, { method: 'POST', body: f }); return { status: r.status, body: await r.json() }; };
    try {
        let r = await post('/mem', form([['file', 'hello', 'text/plain', 'a.txt']]));
        assert.deepStrictEqual([r.status, r.body], [200, { size: 5, buffer: true }], 'memory storage keeps the bytes in req.file.buffer');
        r = await post('/mem', form([['file', 'x', 'application/octet-stream', 'x.bin']]));
        assert.strictEqual(r.status, 200, 'octet-stream is let through for the guard to sniff');
        r = await post('/mem', form([['file', 'x', 'application/zip', 'x.zip']]));
        assert.deepStrictEqual([r.status, r.body.error], [400, 'Unsupported file type: application/zip. Accepted: image/png, text/plain']);
        r = await post('/mem', form([['file', 'x'.repeat(2048), 'text/plain', 'big.txt']]));
        assert.deepStrictEqual([r.status, r.body.error], [413, 'File too large. Maximum 0MB.']);
        r = await post('/mem', form([['other', 'x', 'text/plain', 'a.txt']]));
        assert.strictEqual(r.status, 400);

        r = await post('/disk', form([['file', 'hi', 'text/plain', '../../evil name.TXT;rm']]));
        assert.strictEqual(r.status, 200);
        assert.match(r.body.name, /^[0-9a-f]{32}\.bin$/, 'a disk name is random, and a strange extension becomes .bin');
        assert.strictEqual(r.body.inDir, true, 'it lands in config.uploadsDir');
        r = await post('/disk', form([['file', 'hi', 'image/png', 'Pic.PNG']]));
        assert.match(r.body.name, /^[0-9a-f]{32}\.png$/);
        r = await post('/disk', form([['file', 'x', 'application/zip', 'x.zip']]));
        assert.strictEqual(r.body.error, 'Unsupported file type: application/zip. Upload a PNG.', 'the app\'s own hint');

        r = await post('/many', form([['files', 'a', 'text/plain', 'a.txt'], ['files', 'b', 'text/plain', 'b.txt']]));
        assert.deepStrictEqual([r.status, r.body.n], [200, 2]);
        r = await post('/many', form([['files', 'a', 'text/plain', 'a.txt'], ['files', 'b', 'text/plain', 'b.txt'], ['files', 'c', 'text/plain', 'c.txt']]));
        assert.deepStrictEqual([r.status, r.body.error], [400, 'Too many files. Maximum 2 files per request.']);
        r = await post('/any', form([['file', 'a', 'text/plain', 'a.txt']]));
        assert.deepStrictEqual([r.status, r.body.n], [200, 1]);
    } finally { s.close(); }

    // One runtime: no satellite keeps its own upload middleware.
    const apps = path.join(__dirname, '..', '..');
    for (const a of fs.readdirSync(apps)) {
        if (a.startsWith('_') || !fs.statSync(path.join(apps, a)).isDirectory()) continue;
        assert.ok(!fs.existsSync(path.join(apps, a, 'server', 'middleware', 'upload.js')), `${a} has its own upload middleware again`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('upload (shared runtime): all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
