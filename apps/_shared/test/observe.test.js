'use strict';
// Track O for Tools, against real processes: every satellite and the gateway serve GET /metrics to
// direct loopback callers only (route templates, never raw URLs), a truthful GET /api/ready (status,
// latency_ms and checked_at on every check; 503 only when a required check fails), tools_jobs from
// the job store, and the gateway reports a down satellite as degraded (200), never as down itself.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startApp, freePort } = require('./spawn');
const { dep } = require('./deps');
const { observe, checks, which } = require('../observe');

const express = dep('express');
const metrics = dep('openvibe-shared/metrics');
const ready = dep('openvibe-shared/ready');

const get = async (url, headers = {}) => { const r = await fetch(url, { headers }); return { status: r.status, text: await r.text() }; };
const json = async (url) => { const r = await fetch(url); return { status: r.status, body: await r.json() }; };

function assertShape(body, service) {
    assert.strictEqual(body.service, service);
    assert.strictEqual(typeof body.ready, 'boolean');
    assert.ok(['ready', 'degraded', 'not_ready'].includes(body.status));
    assert.ok(Array.isArray(body.failed) && Array.isArray(body.degraded));
    for (const [name, c] of Object.entries(body.checks)) {
        assert.ok(['ok', 'fail'].includes(c.status), `${service} ${name} status`);
        assert.strictEqual(typeof c.required, 'boolean', `${service} ${name} required`);
        assert.strictEqual(typeof c.latency_ms, 'number', `${service} ${name} latency_ms`);
        assert.ok(!Number.isNaN(Date.parse(c.checked_at)), `${service} ${name} checked_at`);
    }
}

(async () => {
    const procs = [];
    try {
        // ── In process: a required failure is 503; optional failures are degraded 200 ──
        {
            const app = express();
            let dbOk = true;
            const obs = observe({
                app, metrics, ready, service: 'tools-test', release: 'abc1234567',
                checks: [
                    { name: 'db', required: true, check: () => (dbOk ? true : 'SQLITE_IOERR') },
                    checks.upstream('satellite_dead', `http://127.0.0.1:${await freePort()}/api/ready`),
                    checks.binary('nope', 'definitely-not-a-binary-ov'),
                ],
            });
            app.get('/x/:id', (_q, s) => s.json({ ok: true }));
            const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
            const base = `http://127.0.0.1:${server.address().port}`;
            let r = await json(`${base}/api/ready`);
            assert.strictEqual(r.status, 200, 'optional failures keep it ready');
            assert.strictEqual(r.body.status, 'degraded');
            assert.deepStrictEqual(r.body.degraded.sort(), ['nope', 'satellite_dead']);
            assertShape(r.body, 'tools-test');
            dbOk = false;
            r = await json(`${base}/api/ready`);
            assert.strictEqual(r.status, 503);
            assert.deepStrictEqual(r.body.failed, ['db']);
            assert.strictEqual(r.body.checks.db.error, 'SQLITE_IOERR');
            obs.stop();
            server.close();
            assert.ok(which('node') || which(process.execPath), 'which() finds executables');
        }

        // ── img satellite: jobs, metrics, readiness ──
        const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-obs-img-'));
        const img = await startApp('img', { DATA_DIR: data, UPLOADS_DIR: path.join(data, 'uploads'), OUTPUT_DIR: path.join(data, 'output'), TOOLS_JOBS_CONCURRENCY_IMG: '0' });
        procs.push(img);
        const fd = new FormData();
        fd.append('type', 'img.process');
        fd.append('input', JSON.stringify({ tool: 'convert', format: 'webp' }));
        fd.append('file', new Blob([Buffer.from('not really a png')], { type: 'image/png' }), 'a.png');
        const sub = await fetch(`${img.base}/api/v1/jobs`, { method: 'POST', body: fd });
        assert.strictEqual(sub.status, 202, await sub.clone().text());
        const job = await sub.json();
        const cookie = (sub.headers.get('set-cookie') || '').split(';')[0];
        const seen = await fetch(`${img.base}/api/v1/jobs/${job.id}?secret=zzz`, { headers: { cookie } });
        assert.strictEqual(seen.status, 200);

        let r = await json(`${img.base}/api/ready`);
        assertShape(r.body, 'tools-img');
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        for (const n of ['jobs_db', 'job_runtime', 'data_dir', 'uploads_dir', 'output_dir']) {
            assert.strictEqual(r.body.checks[n].required, true, `${n} is required`);
            assert.strictEqual(r.body.checks[n].status, 'ok', `${n} ok`);
        }
        assert.strictEqual(r.body.checks.job_runtime.detail.queued, 1, 'the queued job is counted');
        assert.strictEqual(r.body.checks.network_key.required, false);
        assert.strictEqual(r.body.checks.network_key.status, 'fail', 'the test Network is unreachable, and readiness says so');
        assert.ok(r.body.degraded.includes('network_key'));
        assert.strictEqual(r.body.status, 'degraded');

        let m = await get(`${img.base}/metrics`);
        assert.strictEqual(m.status, 200);
        assert.ok(m.text.includes('tools_jobs{app="img",state="queued"} 1\n'), m.text);
        assert.ok(m.text.includes('tools_jobs_executing{app="img",kind="limit"} 0\n'));
        assert.ok(m.text.includes('release_info{service="tools-img",'));
        assert.ok(m.text.includes('http_requests_total{method="POST",route="/api/v1/jobs",status_class="2xx"} 1\n'));
        assert.ok(m.text.includes('http_requests_total{method="GET",route="/api/v1/jobs/:id",status_class="2xx"} 1\n'));
        const labels = m.text.split('\n').filter(l => l.startsWith('http_')).map(l => (l.match(/\{[^}]*\}/) || [''])[0]).join('\n');
        assert.ok(!labels.includes(job.id) && !labels.includes('secret'), 'no job ids or queries in labels');
        m = await get(`${img.base}/metrics`, { 'X-Forwarded-For': '203.0.113.7' });
        assert.strictEqual(m.status, 404, 'a proxied caller never sees metrics');

        // Required failure on a real satellite: its uploads directory stops being writable.
        fs.chmodSync(path.join(data, 'uploads'), 0o500);
        r = await json(`${img.base}/api/ready`);
        fs.chmodSync(path.join(data, 'uploads'), 0o700);
        if (process.getuid && process.getuid() !== 0) {
            assert.strictEqual(r.status, 503, 'a required dependency down is not ready');
            assert.deepStrictEqual(r.body.failed, ['uploads_dir']);
        }

        // ── Other satellites answer the same shape ──
        for (const [app, service, extra] of [['text', 'tools-text', {}], ['yt', 'tools-yt', { DOWNLOADS_DIR: path.join(data, 'yt') }]]) {
            fs.mkdirSync(path.join(data, 'yt'), { recursive: true });
            const p = await startApp(app, { DATA_DIR: data, ...extra });
            procs.push(p);
            const x = await json(`${p.base}/api/ready`);
            assertShape(x.body, service);
            assert.strictEqual(x.status, 200, JSON.stringify(x.body));
            const mm = await get(`${p.base}/metrics`);
            assert.ok(mm.text.includes(`release_info{service="${service}",`));
        }

        // ── Gateway: satellites are optional checks; one up, the rest down → degraded 200 ──
        const deadPorts = await Promise.all(['maps', 'food', 'yt', 'audio', 'text', 'docs'].map(async n => `${n}=${await freePort()}`));
        const gwPort = await freePort();
        const gw = await startApp('gateway', { TOOLS_SATELLITE_PORTS: [`img=${img.port}`, ...deadPorts].join(','), OV_COMMUNITY_INTERNAL_URL: `http://127.0.0.1:${await freePort()}` }, gwPort);
        procs.push(gw);
        r = await json(`${gw.base}/api/ready`);
        assertShape(r.body, 'tools');
        assert.strictEqual(r.status, 200, 'down satellites never make the gateway not ready');
        assert.strictEqual(r.body.ready, true);
        assert.strictEqual(r.body.status, 'degraded');
        assert.strictEqual(r.body.checks.catalog.required, true);
        assert.strictEqual(r.body.checks.catalog.status, 'ok');
        assert.strictEqual(r.body.checks.satellite_img.status, 'ok');
        assert.strictEqual(r.body.checks.satellite_img.detail.status, 'degraded', 'the satellite\'s own degradation is passed on');
        for (const n of ['maps', 'food', 'yt', 'audio', 'text', 'docs']) {
            assert.strictEqual(r.body.checks[`satellite_${n}`].status, 'fail', n);
            assert.ok(r.body.degraded.includes(`satellite_${n}`));
        }
        assert.ok(r.body.degraded.includes('community'));
        await fetch(`${gw.base}/api/catalog.json?x=1`);
        m = await get(`${gw.base}/metrics`);
        assert.strictEqual(m.status, 200);
        assert.ok(m.text.includes('release_info{service="tools",'));
        assert.ok(/http_requests_total\{method="GET",route="\/api\/ready",status_class="2xx"\} 1\n/.test(m.text));
        assert.ok(!m.text.includes('x=1'));
        console.log('observe (metrics + readiness, gateway and satellites): all checks passed');
    } finally {
        await Promise.all(procs.map(p => p.kill('SIGKILL')));
    }
})().catch((err) => { console.error(err); process.exit(1); });
