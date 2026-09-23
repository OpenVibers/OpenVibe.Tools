'use strict';
// The PDF tools that used to pretend: Protect re-saved the file unencrypted, Unlock re-saved still
// encrypted content, PDF to image drew a placeholder card, Split returned only its first part. Now:
// qpdf AES-256 encryption and decryption, poppler rendering, a ZIP of every part, a page limit on
// every operation, and 503 tools.unavailable (API and page) while qpdf or poppler is not installed.
//
// The real encrypt/decrypt and render checks run when the programs are there (on PATH, or QPDF_PATH /
// PDFTOPPM_PATH / PDFINFO_PATH); the 503 path is always checked by pointing them at nothing.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

process.env.PDF_MAX_PAGES = '6';   // before the tools are loaded: a small limit to test against
const { PDFDocument } = require('pdf-lib');
const { getTool, listTools } = require('../server/tools');
const pdf = require('../server/tools/pdf');
const { startApp } = require('../../_shared/test/spawn');

async function makePdf(pages) {
    const doc = await PDFDocument.create();
    for (let i = 0; i < pages; i++) doc.addPage([200, 300]).drawText(`page ${i + 1}`, { x: 20, y: 150 });
    return Buffer.from(await doc.save());
}

/** A stored ZIP → [{ name, data }] (enough for what pdf.zip writes). */
function unzip(buf) {
    const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    assert.ok(end >= 0, 'end of central directory');
    const count = buf.readUInt16LE(end + 10);
    let at = buf.readUInt32LE(end + 16);
    const out = [];
    for (let i = 0; i < count; i++) {
        assert.strictEqual(buf.readUInt32LE(at), 0x02014b50);
        const size = buf.readUInt32LE(at + 20), nameLen = buf.readUInt16LE(at + 28), local = buf.readUInt32LE(at + 42), crc = buf.readUInt32LE(at + 16);
        const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
        const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const data = buf.subarray(dataAt, dataAt + size);
        assert.strictEqual(pdf.crc32(data), crc, `crc of ${name}`);
        out.push({ name, data });
        at += 46 + nameLen;
    }
    return out;
}

/** Run fn with a binary pointed at nothing (or restore it). */
function withMissing(binary, envVar, fn) {
    const saved = process.env[envVar];
    process.env[envVar] = '/nonexistent/' + binary.name;
    binary.detect();
    return Promise.resolve().then(fn).finally(() => {
        if (saved === undefined) delete process.env[envVar]; else process.env[envVar] = saved;
        binary.detect();
    });
}

const run = (name, buf, opts) => getTool(name).handler(buf, opts);
const is503 = (e) => e.status === 503 && e.code === 'tools.unavailable' && /being set up/.test(e.message);

(async () => {
    const three = await makePdf(3);
    const seven = await makePdf(7);

    // ── Page limit (PDF_MAX_PAGES) on every operation ────────
    for (const [tool, input, opts] of [['rotate', seven, { angle: 90 }], ['watermark', seven, { text: 'x' }], ['split', seven, { mode: 'all' }], ['metadata', seven, { mode: 'view' }], ['compress', seven, {}]]) {
        await assert.rejects(run(tool, input, opts), (e) => e.status === 413 && e.code === 'tools.pdf.too_many_pages', `${tool} refuses 7 pages`);
    }
    await assert.rejects(getTool('merge').handler([three, await makePdf(4)], {}), (e) => e.status === 413 && /merged PDF has 7 pages/.test(e.message));
    assert.strictEqual((await run('rotate', three, { angle: 90 })).pageCount, 3, 'under the limit works');

    // ── Split: every part, in one ZIP ────────────────────────
    let r = await run('split', three, { mode: 'all' });
    assert.deepStrictEqual([r.ext, r.mime, r.parts], ['zip', 'application/zip', 3]);
    let parts = unzip(r.buffer);
    assert.deepStrictEqual(parts.map(p => p.name), ['part-1-page-1.pdf', 'part-2-page-2.pdf', 'part-3-page-3.pdf']);
    for (const p of parts) assert.strictEqual((await PDFDocument.load(p.data)).getPageCount(), 1);
    r = await run('split', three, { ranges: '1-2,3' });
    parts = unzip(r.buffer);
    assert.deepStrictEqual(parts.map(p => p.name), ['part-1-pages-1-2.pdf', 'part-2-page-3.pdf']);
    r = await run('split', three, { ranges: '2-3' });
    assert.strictEqual(r.ext, 'pdf', 'one range is still one PDF');

    // ── Missing programs: 503 tools.unavailable, never a pretend result ──
    await withMissing(pdf.qpdf, 'QPDF_PATH', async () => {
        await assert.rejects(run('protect', three, { password: 'pw' }), is503, 'protect without qpdf');
        await assert.rejects(run('unlock', three, { password: 'pw' }), is503, 'unlock without qpdf');
        const listed = listTools().find(t => t.id === 'protect');
        assert.strictEqual(listed.available, false, '/api/tools says so');
    });
    await withMissing(pdf.pdftoppm, 'PDFTOPPM_PATH', async () => {
        await assert.rejects(run('pdf2img', three, {}), is503, 'pdf2img without pdftoppm');
    });

    // ── qpdf, when installed: real AES-256 ───────────────────
    if (pdf.qpdf.available()) {
        const qpdfBin = pdf.qpdf.get().path;
        const locked = await run('protect', three, { password: 's3cret pass', allowPrint: 'false' });
        assert.strictEqual(locked.pageCount, 3);
        assert.deepStrictEqual(locked.encryption, { method: 'AES-256', printing: false, copying: true });
        await assert.rejects(PDFDocument.load(locked.buffer), /encrypted/i, 'pdf-lib cannot open it without the password');
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-docs-q-'));
        const file = path.join(tmp, 'locked.pdf');
        fs.writeFileSync(file, locked.buffer);
        const shown = execFileSync(qpdfBin, ['--show-encryption', '--password=s3cret pass', file]).toString();
        assert.match(shown, /R = 6/, 'security handler revision 6 (AES-256)');
        assert.match(shown, /print high resolution: not allowed/);
        assert.throws(() => execFileSync(qpdfBin, ['--show-npages', file], { stdio: 'pipe' }), 'qpdf itself needs the password');
        fs.rmSync(tmp, { recursive: true, force: true });

        await assert.rejects(run('protect', locked.buffer, { password: 'again' }), /already password-protected/);
        await assert.rejects(run('protect', three, {}), (e) => e.status === 400);
        await assert.rejects(run('unlock', locked.buffer, { password: 'wrong' }), (e) => e.status === 400 && e.code === 'tools.pdf.wrong_password');
        const open = await run('unlock', locked.buffer, { password: 's3cret pass' });
        const doc = await PDFDocument.load(open.buffer);   // no ignoreEncryption: really decrypted
        assert.strictEqual(doc.getPageCount(), 3);
        const plain = await run('unlock', three, { password: '' });
        assert.match(plain.note, /not password-protected/);
        await assert.rejects(run('protect', seven, { password: 'pw' }), (e) => e.code === 'tools.pdf.too_many_pages', 'the page limit applies to qpdf tools too');
        console.log(`  qpdf: ${qpdfBin}: AES-256 encrypt, wrong password, decrypt checked`);
    } else {
        console.log('  qpdf not installed here: checked the 503 path only');
    }

    // ── pdftoppm, when installed: real pages ─────────────────
    if (pdf.pdftoppm.available() && pdf.pdfinfo.available()) {
        let img = await run('pdf2img', three, { format: 'png', dpi: 144, pages: '2' });
        assert.strictEqual(img.mime, 'image/png');
        assert.strictEqual(img.buffer.readUInt32BE(0), 0x89504e47, 'PNG signature');
        assert.strictEqual(img.buffer.readUInt32BE(16), 400, '200 pt at 144 dpi = 400 px wide');
        assert.deepStrictEqual(img.pages, [2]);
        img = await run('pdf2img', three, { format: 'jpg', pages: '1,3' });
        assert.deepStrictEqual([img.ext, img.pageCount], ['zip', 2]);
        const pages = unzip(img.buffer);
        assert.deepStrictEqual(pages.map(p => p.name), ['page-1.jpg', 'page-3.jpg']);
        for (const p of pages) assert.strictEqual(p.data.readUInt16BE(0), 0xffd8, 'JPEG signature');
        await assert.rejects(run('pdf2img', await makePdf(6), { dpi: 600 }), (e) => e.status === 413 && /at most 5 pages/.test(e.message));
        await assert.rejects(run('pdf2img', three, { pages: '9' }), (e) => e.status === 400);
        console.log(`  poppler: ${pdf.pdftoppm.get().path}: pages rendered`);
    } else {
        console.log('  poppler-utils not installed here: checked the 503 path only');
    }

    // ── As a real process without qpdf: the API answers 503 and the page is told ──
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-docs-tools-'));
    const app = await startApp('docs', { DATA_DIR: data, UPLOADS_DIR: path.join(data, 'uploads'), OUTPUT_DIR: path.join(data, 'output'), QPDF_PATH: '/nonexistent/qpdf' });
    try {
        const fd = new FormData();
        fd.append('type', 'docs.process');
        fd.append('input', JSON.stringify({ tool: 'protect', password: 'pw' }));
        fd.append('file', new Blob([three], { type: 'application/pdf' }), 'doc.pdf');
        let res = await fetch(`${app.base}/api/v1/jobs`, { method: 'POST', body: fd });
        assert.strictEqual(res.status, 503, 'the job is refused up front');
        assert.strictEqual(res.headers.get('content-type'), 'application/problem+json');
        let p = await res.json();
        assert.strictEqual(p.code, 'tools.unavailable');
        assert.match(p.detail, /being set up/);

        const sync = new FormData();
        sync.append('tool', 'unlock');
        sync.append('file', new Blob([three], { type: 'application/pdf' }), 'doc.pdf');
        res = await fetch(`${app.base}/api/process`, { method: 'POST', body: sync });
        assert.strictEqual(res.status, 503);
        p = await res.json();
        assert.strictEqual(p.code, 'tools.unavailable');

        const ctx = await (await fetch(`${app.base}/api/context`, { headers: { 'X-OV-Tool': 'protectpdf' } })).json();
        assert.strictEqual(ctx.defaultOp, 'protect');
        assert.strictEqual(ctx.tools.find(t => t.id === 'protect').available, false, 'the protect page is told it is not set up');
        assert.strictEqual(ctx.tools.find(t => t.id === 'rotate').available, true);
        const ready = await (await fetch(`${app.base}/api/ready`)).json();
        assert.ok(ready.degraded.includes('qpdf'), 'readiness lists qpdf as degraded, not down');
    } finally {
        await app.kill();
        fs.rmSync(data, { recursive: true, force: true });
    }
    console.log('docs pdf tools (qpdf, poppler, page limit, split ZIP, 503): all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
