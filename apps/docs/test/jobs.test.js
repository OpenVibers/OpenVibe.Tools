'use strict';
// Docs.OpenVibe as a real process: a multi-file merge job accepted before a SIGKILL finishes after
// the restart; single-file and view-only jobs; the synchronous endpoints still answer; canonical host.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const { startApp } = require('../../_shared/test/spawn');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function pdf(pages, title) {
    const doc = await PDFDocument.create();
    for (let i = 0; i < pages; i++) doc.addPage([200, 300]);
    if (title) doc.setTitle(title);
    return Buffer.from(await doc.save());
}

async function finished(app, id, cookie) {
    for (let i = 0; i < 150; i++) {
        const job = await (await fetch(`${app.base}/api/v1/jobs/${id}`, { headers: { cookie } })).json();
        if (['succeeded', 'failed', 'cancelled'].includes(job.state)) return job;
        await sleep(100);
    }
    throw new Error(`job ${id} did not finish`);
}

(async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-docs-'));
    const env = { DATA_DIR: data, UPLOADS_DIR: path.join(data, 'uploads'), OUTPUT_DIR: path.join(data, 'output') };
    const a = await pdf(2, 'First'), b = await pdf(3);
    let app;
    try {
        app = await startApp('docs', { ...env, TOOLS_JOBS_CONCURRENCY_DOCS: '0' });
        const fd = new FormData();
        fd.append('type', 'docs.process');
        fd.append('input', JSON.stringify({ tool: 'merge' }));
        fd.append('files', new Blob([a], { type: 'application/pdf' }), 'first.pdf');
        fd.append('files', new Blob([b], { type: 'application/pdf' }), 'second.pdf');
        let r = await fetch(`${app.base}/api/v1/jobs`, { method: 'POST', body: fd });
        assert.strictEqual(r.status, 202, await r.clone().text());
        const cookie = r.headers.get('set-cookie').split(';')[0];
        const merge = await r.json();
        await app.kill('SIGKILL');

        app = await startApp('docs', env, app.port);
        const merged = await finished(app, merge.id, cookie);
        assert.strictEqual(merged.state, 'succeeded', JSON.stringify(merged.error));
        assert.strictEqual(merged.result.data.pageCount, 5);
        assert.strictEqual(merged.result.data.fileCount, 2);
        r = await fetch(`${app.base}${merged.result.files[0].url}`, { headers: { cookie } });
        assert.strictEqual((await PDFDocument.load(Buffer.from(await r.arrayBuffer()))).getPageCount(), 5, 'the merged PDF has every page');

        // Single file, and a view-only tool (no result file, only data).
        const one = async (input, file = a) => {
            const f = new FormData();
            f.append('type', 'docs.process'); f.append('input', JSON.stringify(input));
            f.append('file', new Blob([file], { type: 'application/pdf' }), 'doc.pdf');
            const res = await fetch(`${app.base}/api/v1/jobs`, { method: 'POST', body: f, headers: { cookie } });
            return finished(app, (await res.json()).id, cookie);
        };
        const rotated = await one({ tool: 'rotate', angle: '90', pages: 'all' });
        assert.strictEqual(rotated.state, 'succeeded');
        assert.strictEqual(rotated.result.files[0].name, 'doc.pdf');
        const info = await one({ tool: 'metadata', mode: 'view' });
        assert.strictEqual(info.state, 'succeeded');
        assert.strictEqual(info.result.files.length, 0);
        assert.strictEqual(info.result.data.viewOnly, true);
        assert.strictEqual(info.result.data.metadata.title, 'First');
        const bad = await one({ tool: 'rotate', angle: '90' }, Buffer.from('%PDF-1.4 not really'));
        assert.strictEqual(bad.state, 'failed');
        assert.strictEqual(bad.error.code, 'tools.job.failed');
        r = await fetch(`${app.base}/api/v1/jobs`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ type: 'docs.process', input: { tool: 'merge' } }) });
        assert.strictEqual(r.status, 400, 'a job without files is refused');

        // The synchronous endpoint is unchanged (after the burst limiter's 5 s window: jobs count too).
        await sleep(5100);
        const sync = new FormData();
        sync.append('files', new Blob([a], { type: 'application/pdf' }), 'a.pdf');
        sync.append('files', new Blob([b], { type: 'application/pdf' }), 'b.pdf');
        sync.append('tool', 'merge');
        r = await fetch(`${app.base}/api/process/multi`, { method: 'POST', body: sync });
        const body = await r.json();
        assert.strictEqual(body.success, true, JSON.stringify(body)); assert.strictEqual(body.pageCount, 5);

        // Canonical host through the gateway.
        const html = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: app.port, path: '/', headers: { Host: 'mergepdf.openvibe.tools', 'X-OV-Tool': 'mergepdf', 'X-OV-Host-Role': 'short', 'X-OV-Canonical-Host': 'merge-pdf.openvibe.tools' } }, (res) => {
            let t = ''; res.setEncoding('utf8'); res.on('data', c => { t += c; }); res.on('end', () => resolve(t));
        }).on('error', reject));
        assert.ok(html.includes('<link rel="canonical" href="https://merge-pdf.openvibe.tools/">'), 'canonical follows X-OV-Canonical-Host');

        await app.kill('SIGTERM');
        console.log('docs jobs + canonical host: all checks passed');
    } catch (err) {
        if (app) { console.error(app.output()); await app.kill('SIGKILL'); }
        throw err;
    } finally {
        fs.rmSync(data, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exit(1); });
