'use strict';
// Docs.OpenVibe's worker pool on a real process (apps/_shared/jobs/pool.js, S5):
//   • /api/health keeps answering in milliseconds while a large synchronous merge runs (pdf-lib is
//     in a worker thread, not on the event loop), and the merge still comes back whole
//   • a merge job that needs more heap than TOOLS_WORKER_MEMORY_MB fails cleanly: the job ends
//     failed with 413 tools.input.too_large, the process stays up, and the next job succeeds
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { startApp } = require('../../_shared/test/spawn');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function bigPdf(pages) {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < pages; i++) doc.addPage([300, 300]).drawText(`Page ${i + 1} ${'x'.repeat(200)}`, { x: 10, y: 150, size: 8, font });
    return Buffer.from(await doc.save());
}

async function finished(app, id, cookie) {
    for (let i = 0; i < 1200; i++) {   // up to two minutes on a busy machine
        const job = await (await fetch(`${app.base}/api/v1/jobs/${id}`, { headers: { cookie } })).json();
        if (['succeeded', 'failed', 'cancelled'].includes(job.state)) return job;
        await sleep(100);
    }
    throw new Error(`job ${id} did not finish`);
}

function mergeForm(files, job) {
    const fd = new FormData();
    if (job) { fd.append('type', 'docs.process'); fd.append('input', JSON.stringify({ tool: 'merge' })); } else fd.append('tool', 'merge');
    files.forEach((b, i) => fd.append('files', new Blob([b], { type: 'application/pdf' }), `part-${i}.pdf`));
    return fd;
}

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-docs-pool-'));
    const envFor = (n) => ({ DATA_DIR: path.join(tmp, n), UPLOADS_DIR: path.join(tmp, n, 'uploads'), OUTPUT_DIR: path.join(tmp, n, 'output'), PDF_MAX_PAGES: '100000' });
    const big = await bigPdf(2500);
    const apps = [];
    try {
        // ── Health stays fast during a large merge ──
        const app = await startApp('docs', envFor('a'));
        apps.push(app);
        const ctx = await fetch(`${app.base}/api/context`);
        const cookie = ctx.headers.get('set-cookie').split(';')[0];
        const t0 = Date.now();
        const merging = fetch(`${app.base}/api/process/multi`, { method: 'POST', body: mergeForm([big, big]), headers: { cookie } }).then(async r => ({ status: r.status, body: await r.json(), at: Date.now() }));
        const latencies = [];
        let done = null;
        merging.then(r => { done = r; });
        await sleep(150);                          // the upload is in and pdf-lib is working
        while (!done) {
            const s = Date.now();
            const h = await fetch(`${app.base}/api/health`);
            assert.strictEqual(h.status, 200);
            const body = await h.json();
            latencies.push(Date.now() - s);
            if (!done && latencies.length === 3) assert.strictEqual(body.workers.busy, 1, 'the merge is in a worker thread');
            await sleep(40);
        }
        const took = done.at - t0;
        assert.strictEqual(done.status, 200, JSON.stringify(done.body));
        assert.strictEqual(done.body.pageCount, 5000, 'every page of both documents');
        assert.ok(took > 700, `the merge is large enough to measure (${took} ms)`);
        assert.ok(latencies.length >= 5, `health was asked during the merge (${latencies.length} times)`);
        const worst = Math.max(...latencies);
        // On the event loop the merge would hold every request for its whole length; in a worker thread
        // health answers in milliseconds (the bound leaves room for a busy test machine).
        assert.ok(worst < Math.max(250, took / 3), `/api/health stayed fast during a ${took} ms merge (worst ${worst} ms)`);
        const health = await (await fetch(`${app.base}/api/health`)).json();
        assert.strictEqual(health.workers.completed, 1);
        assert.strictEqual(health.workers.busy, 0);

        // ── Over the heap limit: the job fails cleanly and the next one works ──
        const small = await startApp('docs', { ...envFor('b'), TOOLS_WORKER_MEMORY_MB: '32' });
        apps.push(small);
        const c2 = (await fetch(`${small.base}/api/context`)).headers.get('set-cookie').split(';')[0];
        let r = await fetch(`${small.base}/api/v1/jobs`, { method: 'POST', body: mergeForm([big, big, big], true), headers: { cookie: c2 } });
        assert.strictEqual(r.status, 202, await r.clone().text());
        const oom = await finished(small, (await r.json()).id, c2);
        assert.strictEqual(oom.state, 'failed');
        assert.deepStrictEqual([oom.error.status, oom.error.code], [413, 'tools.input.too_large'], JSON.stringify(oom.error));
        assert.match(oom.error.detail, /32 MB/);
        assert.strictEqual(oom.retryable, false);
        assert.strictEqual((await fetch(`${small.base}/api/health`)).status, 200, 'the process is still up');
        const tiny = await bigPdf(2);
        r = await fetch(`${small.base}/api/v1/jobs`, { method: 'POST', body: mergeForm([tiny, tiny], true), headers: { cookie: c2 } });
        const next = await finished(small, (await r.json()).id, c2);
        assert.strictEqual(next.state, 'succeeded', JSON.stringify(next.error));
        assert.strictEqual(next.result.data.pageCount, 4);
        const stats = (await (await fetch(`${small.base}/api/health`)).json()).workers;
        assert.strictEqual(stats.out_of_memory, 1);
        // The synchronous endpoint says the same (413, the legacy { error, code } shape).
        r = await fetch(`${small.base}/api/process/multi`, { method: 'POST', body: mergeForm([big, big, big]), headers: { cookie: c2 } });
        assert.strictEqual(r.status, 413);
        assert.strictEqual((await r.json()).code, 'tools.input.too_large');
    } finally {
        for (const a of apps) await a.kill('SIGTERM');
    }
    console.log('docs pool: health fast during a 5000-page merge in a worker; heap limit fails the job (413) and the next one succeeds');
})().catch((err) => { console.error(err); process.exit(1); });
