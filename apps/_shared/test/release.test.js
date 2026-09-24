'use strict';
// GET /release.json for each Tools app (apps/_shared/release.js, openvibe-shared ≥ 1.5.1 release.mount):
//   • the four apps that pin openvibe-contracts serve manifest 1.1.0 with their components (shell: what
//     their pages are made of; server: the rest), valid against their own contracts
//   • the others serve the 1.0.0 fields their (absent) contracts allow
//   • mount answers GET /release.json and takes the navbar's POST /release-metrics into /metrics
const assert = require('assert');
const path = require('path');
const { createRequire } = require('module');
const { toolsRelease } = require('../release');

const APPS = path.join(__dirname, '..', '..');
const requireOf = (app) => createRequire(path.join(APPS, app, 'server', 'index.js'));
const quiet = { warn() {}, log() {}, error() {} };

(async () => {
    for (const app of ['gateway', 'img', 'audio', 'docs']) {
        const req = requireOf(app);
        const r = toolsRelease(app, req, { logger: quiet });
        const m = r.manifest();
        assert.deepStrictEqual(Object.keys(m.components).sort(), ['server', 'shell'], app);
        assert.strictEqual(m.components.shell.kind, 'script');
        assert.strictEqual(m.components.server.kind, 'server');
        assert.match(m.release, /^[0-9a-f]{7,12}$/);
        const v = r.validate({ contracts: req('openvibe-contracts') });
        assert.strictEqual(v.valid, true, `${app}: ${JSON.stringify(v.errors)}`);
    }
    for (const app of ['maps', 'food', 'text', 'yt']) {
        const m = toolsRelease(app, requireOf(app), { logger: quiet }).manifest();
        assert.ok(!('components' in m), `${app}: no contracts pinned, so the 1.0.0 fields`);
        assert.strictEqual(m.service, 'tools');
    }

    // The mount: GET /release.json, POST /release-metrics → release_client_updates_total.
    const req = requireOf('gateway');
    const express = req('express');
    const metrics = req('openvibe-shared/metrics');
    const app = express();
    const inst = metrics.instrument(app, { service: 'tools', release: 'test' });
    const release = toolsRelease('gateway', req, { logger: quiet });
    release.mount(app, { registry: inst.registry });
    const srv = await new Promise(res => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
    const base = `http://127.0.0.1:${srv.address().port}`;
    try {
        let r = await fetch(`${base}/release.json`);
        assert.strictEqual(r.status, 200);
        const body = await r.json();
        assert.strictEqual(body.metrics_url, '/release-metrics');
        assert.ok(body.components.shell.version);
        r = await fetch(`${base}/release-metrics`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ counts: { applied: { style: 2 } } }) });
        assert.strictEqual(r.status, 204);
        const text = await (await fetch(`${base}/metrics`)).text();
        assert.match(text, /release_client_updates_total\{outcome="applied",reason="style"\} 2/);
    } finally { await new Promise(res => srv.close(res)); inst.stop && inst.stop(); }
    console.log('release: gateway/img/audio/docs serve components (shell, server) valid against their contracts; the others 1.0.0; mount serves /release.json and /release-metrics');
})().catch((err) => { console.error(err); process.exit(1); });
