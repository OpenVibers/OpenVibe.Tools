'use strict';
// Request telemetry for Tools (plan T1 step 10): observe() mounts openvibe-sdk/service's process-wide telemetry middleware
// when the app passes it (a no-op until init); every app passes it and calls telemetry.init() with its own service id
// into the tools database; the gateway alone prunes the shared table to 14 days. Five hits on one route flush as ONE
// aggregated http.request sample, /metrics makes none, and the migration's table takes the retention.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { dep } = require('./deps');
const { observe } = require('../observe');
const { testDb, closeAllTestDbs } = require('./testdb');

const express = dep('express');
const metrics = dep('openvibe-shared/metrics');
const ready = dep('openvibe-shared/ready');
const { telemetry } = dep('openvibe-sdk/service');
const { pruneTelemetry } = dep('openvibe-sdk/telemetry');
const SERVICES = {'audio': 'tools-audio', 'docs': 'tools-docs', 'food': 'tools-food', 'gateway': 'tools', 'img': 'tools-img', 'maps': 'tools-maps', 'text': 'tools-text', 'yt': 'tools-yt'};

(async () => {
    const apps = path.resolve(__dirname, '..', '..');
    for (const [app, service] of Object.entries(SERVICES)) {
        const src = fs.readFileSync(path.join(apps, app, 'server', 'index.js'), 'utf8');
        assert.match(src, /observe\(\{ telemetry,/, `${app} passes telemetry to observe()`);
        assert.ok(src.includes(`telemetry.init({ service: '${service}', sink: createPgTelemetrySink({ db: toolsDb.db`), `${app} starts its collector`);
        assert.ok(/telemetry\.stop\(\)/.test(src), `${app} flushes on stop`);
        assert.strictEqual(/startTelemetryRetention\(/.test(src), app === 'gateway', `${app}: only the gateway prunes`);
        assert.ok(src.indexOf("require('openvibe-sdk/service')") < src.indexOf('observe({ telemetry,'), `${app} requires telemetry before observe() uses it`);
    }

    const app = express();
    observe({ app, metrics, ready, service: 'tools-test', release: 'test', telemetry });
    app.get('/hello', (req, res) => res.send('hi'));
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const samples = [];
    telemetry.init({ service: 'tools-test', sink: async (batch) => { samples.push(...batch); }, intervalMs: 3600e3 });
    const requests = () => samples.filter((s) => s.operation === 'http.request');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-telemetry-'));
    try {
        for (let i = 0; i < 5; i++) assert.strictEqual((await fetch(`${base}/hello`)).status, 200);
        await telemetry.flush();
        const hit = requests().filter((s) => s.resource === '/hello' && s.status === '2xx');
        assert.strictEqual(hit.length, 1, JSON.stringify(requests()));
        assert.strictEqual(hit[0].service, 'tools-test');
        assert.strictEqual(hit[0].extra.count, 5);
        samples.length = 0;
        await fetch(`${base}/metrics`);
        await telemetry.flush();
        assert.deepStrictEqual(requests(), [], '/metrics makes no sample');

        const db = await testDb(dir);
        const insert = (days) => db.query("INSERT INTO telemetry_samples (at, service, operation) VALUES (now() - make_interval(days => $1), 'tools', 'http.request')", [days]);
        await insert(20);
        await insert(1);
        assert.strictEqual(await pruneTelemetry({ db, olderThanDays: 14 }), 1);
        assert.strictEqual((await db.query('SELECT count(*)::int AS n FROM telemetry_samples')).rows[0].n, 1);
        console.log('telemetry ok');
    } finally {
        await telemetry.stop();
        await new Promise((r) => server.close(r));
        await closeAllTestDbs();
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exit(1); });
