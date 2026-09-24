'use strict';
// The guard on the PDF satellite: uploads go to disk (never 50 × 100 MB in memory) and are deleted
// after the synchronous call, the bytes are checked against the tool's accept list (a picture called
// .pdf is refused, and Image to PDF refuses a PDF), the page's context call starts the session PDF
// tools need, and a caller without one is recorded in report mode (TOOLS_GUARD=enforce refuses it).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const sharp = require('sharp');
const { startApp } = require('../../_shared/test/spawn');

async function makePdf(pages) {
    const doc = await PDFDocument.create();
    for (let i = 0; i < pages; i++) doc.addPage([200, 300]).drawText(`page ${i + 1}`, { x: 20, y: 150 });
    return Buffer.from(await doc.save());
}

(async () => {
    const pdf = await makePdf(2);
    const png = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#aa3355' } }).png().toBuffer();
    for (const mode of ['report', 'enforce']) {
        const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-docs-guard-'));
        const uploads = path.join(data, 'uploads');
        const app = await startApp('docs', { DATA_DIR: data, UPLOADS_DIR: uploads, OUTPUT_DIR: path.join(data, 'output'), TOOLS_GUARD: mode });
        // Each call from its own address, so the older burst limiter (4 in 5 s per address) stays out of it.
        let n = 0;
        const post = (files, fields, cookie, p = '/api/process') => {
            const f = new FormData();
            for (const [k, v] of Object.entries(fields)) f.append(k, v);
            for (const [buf, name, type, field = 'file'] of files) f.append(field, new Blob([buf], { type }), name);
            return fetch(`${app.base}${p}`, { method: 'POST', body: f, headers: { 'X-Forwarded-For': `198.51.100.${++n}`, ...(cookie ? { cookie } : {}) } });
        };
        try {
            const ctx = await fetch(`${app.base}/api/context`, { headers: { Host: 'compresspdf.openvibe.tools' } });
            const cookie = String(ctx.headers.get('set-cookie') || '').split(';')[0];
            assert.match(cookie, /^ov_tools_jobs=/);

            let r = await post([[pdf, 'doc.pdf', 'application/pdf']], { tool: 'compress' }, cookie);
            let body = await r.json();
            assert.strictEqual(r.status, 200, JSON.stringify(body));
            assert.strictEqual(body.output.ext, 'pdf');
            assert.deepStrictEqual(fs.readdirSync(uploads), [], 'the upload was on disk and is gone after the call');

            r = await post([[png, 'doc.pdf', 'application/pdf']], { tool: 'compress' }, cookie);
            assert.strictEqual(r.status, 415, 'a PNG called doc.pdf is refused (in both modes)');
            assert.strictEqual((await r.json()).code, 'tools.file.unsupported_type');
            r = await post([[png, 'a.png', 'image/png', 'files'], [pdf, 'b.png', 'image/png', 'files']], { tool: 'img2pdf' }, cookie, '/api/process/multi');
            assert.strictEqual(r.status, 415, 'Image to PDF takes pictures only: file 2 is a PDF');
            assert.match((await r.json()).detail, /File 2 is a PDF file/);
            r = await post([[png, 'a.png', 'image/png', 'files'], [png, 'b.png', 'image/png', 'files']], { tool: 'img2pdf' }, cookie, '/api/process/multi');
            assert.strictEqual(r.status, 200);
            assert.deepStrictEqual(fs.readdirSync(uploads), []);

            // No session, no sign-in, no token: PDF tools (auth.anonymous false) record or refuse it.
            r = await post([[pdf, 'doc.pdf', 'application/pdf']], { tool: 'compress' }, null);
            if (mode === 'report') assert.strictEqual(r.status, 200, 'report mode lets it through');
            else {
                assert.strictEqual(r.status, 401);
                assert.strictEqual((await r.json()).code, 'tools.session_required');
            }
            const m = await (await fetch(`${app.base}/metrics`)).text();
            assert.match(m, /tools_guard_refused_total\{reason="session",tool="compresspdf"\} 1/);
            assert.match(m, /tools_guard_refused_total\{reason="sniff",tool="compresspdf"\} 1/);
            assert.match(m, /tools_guard_refused_total\{reason="sniff",tool="image2pdf"\} 1/);
        } finally {
            await app.kill();
            fs.rmSync(data, { recursive: true, force: true });
        }
    }
    console.log('docs guard: disk uploads cleaned up, sniffing per tool (PDF vs pictures), context session, session rule report/enforce: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
