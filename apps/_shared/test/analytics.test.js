'use strict';
// ADR-021 analytics bounds for every satellite, on PostgreSQL (plan T8, decision 5): a tracked request
// stores no IP, user id, city, raw user agent, raw referer or query string anywhere in the analytics
// tables; paths are route templates; uniques come from day-scoped hashes deleted after the day's rollup;
// pruneRawEventsPg removes strictly-older raw rows and day hashes in bounded batches and never touches
// rollups.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { dep } = require('./deps');
const { testDb, closeAllTestDbs } = require('./testdb');
const { AnalyticsTrackerPg, privacy, pruneRawEventsPg } = dep('openvibe-shared/analytics/pg');
const { sqlTime } = dep('openvibe-shared/analytics/tracker');

const express = dep('express');

const DAY = 86400000;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-tools-analytics-'));
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';
const SUBJECT = 'usr_01J8ZQ4K7M2N3P4Q5R6S7T8V9W';
const dayOf = (ms) => sqlTime(ms).slice(0, 10);

/** Every analytics row as text, to prove a needle is nowhere. */
async function dumpAll(db) {
    const parts = [];
    for (const t of ['analytics_events', 'analytics_hourly', 'analytics_daily', 'analytics_visitor_days', 'analytics_day_salts']) {
        parts.push(JSON.stringify(await db.prepare(`SELECT * FROM ${t}`).all()));
    }
    return parts.join('\n');
}

(async () => {
    try {
        // ── Templates and reducers ──
        const n = privacy.normalisePath;
        assert.strictEqual(n('/watch/dQw4w9WgXcQ?v=1'), '/watch/:param');
        assert.strictEqual(n('/api/info?url=https://youtube.com/watch?v=abc'), '/api/info');
        assert.strictEqual(n('/api/jobs/01J8ZQ4K7M2N3P4Q5R6S7T8V9W/events'), '/api/jobs/:param/events');
        assert.strictEqual(n('/recipe/chicken-tikka'), '/recipe/:param');
        assert.strictEqual(n('/place/@52.37,4.89,14z'), '/place/@:user');
        assert.strictEqual(n('/@alex'), '/@:user');
        assert.strictEqual(n('/api/things/:id'), '/api/things/:id');
        assert.strictEqual(privacy.refererOrigin('https://www.google.com/search?q=secret'), 'https://www.google.com');
        assert.strictEqual(privacy.uaClass(CHROME), 'chrome/windows/desktop');

        // ── A tracked request through express ──
        {
            const db = await testDb(path.join(tmp, 'track'));
            let clock = Date.parse('2026-09-23T10:15:00Z');
            const tracker = new AnalyticsTrackerPg(db, 'openvibe-yt', { timers: false, now: () => clock });
            const app = express();
            app.set('trust proxy', true);
            app.use(tracker.middleware());
            app.use((req, res, next) => { if (req.headers.authorization) req.user = { id: 42, sub: SUBJECT }; next(); });
            app.get('/api/jobs/:id', (req, res) => res.json({ ok: true }));
            app.get('*', (req, res) => res.send('ok'));
            const server = app.listen(0, '127.0.0.1');
            await new Promise((r) => server.once('listening', r));
            const base = `http://127.0.0.1:${server.address().port}`;
            const hdr = (x) => ({ 'user-agent': CHROME, 'x-forwarded-for': '203.0.113.77', referer: 'https://www.google.com/search?q=secret-query', 'cf-ipcountry': 'NL', ...x });
            try {
                await (await fetch(`${base}/api/jobs/98765?token=supersecret`, { headers: hdr({ authorization: 'Bearer x' }) })).text();
                await (await fetch(`${base}/watch/dQw4w9WgXcQ?v=1`, { headers: hdr({ 'user-agent': FIREFOX, 'x-forwarded-for': '198.51.100.9' }) })).text();
                await new Promise((r) => setTimeout(r, 50));
            } finally { server.close(); }
            await tracker.flush();
            const rows = await db.prepare('SELECT * FROM analytics_events ORDER BY id').all();
            assert.deepStrictEqual(rows.map((r) => r.path), ['/api/jobs/:id', '/watch/:param']);
            assert.deepStrictEqual(rows.map((r) => Number(r.authenticated)), [1, 0]);
            for (const r of rows) {
                assert.ok(r.ip === null && r.user_id === null && r.city === null);
                assert.strictEqual(r.referer, 'https://www.google.com');
                assert.ok(/^[0-9a-f]{16}$/.test(r.session_id));
            }
            const all = await dumpAll(db);
            for (const needle of ['203.0.113.77', '198.51.100.9', '127.0.0.1', SUBJECT, 'supersecret', 'secret-query', '98765', 'dQw4w9WgXcQ', 'Mozilla/5.0']) {
                assert.ok(!all.includes(needle), `found ${needle}`);
            }
            await tracker.aggregate();
            const d = await db.prepare("SELECT * FROM analytics_daily WHERE date = '2026-09-23'").get();
            assert.strictEqual(Number(d.unique_visitors), 2);
            assert.strictEqual(Number(d.unique_users), 1);
            clock = Date.parse('2026-09-24T00:10:00Z');
            await tracker.aggregate();
            assert.strictEqual(Number((await db.prepare('SELECT COUNT(*) AS n FROM analytics_visitor_days').get()).n), 0);
            assert.strictEqual(Number((await db.prepare('SELECT COUNT(*) AS n FROM analytics_day_salts').get()).n), 0);
            assert.strictEqual(Number((await db.prepare("SELECT unique_visitors FROM analytics_daily WHERE date = '2026-09-23'").get()).unique_visitors), 2);
            assert.ok((await tracker.getStats({ days: 30 })).summary);
            assert.ok(Array.isArray((await tracker.getBotAnalysis(7)).topBotIPs));
            await tracker.destroy();
        }

        // ── Prune boundaries: strictly-older raw rows and day hashes go; rollups stay ──
        {
            const db = await testDb(path.join(tmp, 'prune'));
            const nowMs = Date.parse('2026-09-23T12:00:00Z');
            const ins = db.prepare("INSERT INTO analytics_events (service, event_type, path, created_at) VALUES ('openvibe-yt', 'pageview', ?, ?)");
            for (let i = 0; i < 5; i++) await ins.run(`/old/${i}`, sqlTime(nowMs - 40 * DAY));
            await ins.run('/recent', sqlTime(nowMs - 20 * DAY));
            const vd = db.prepare('INSERT INTO analytics_visitor_days (service, day, hour, vhash) VALUES (?, ?, ?, ?)');
            await vd.run('openvibe-yt', dayOf(nowMs - 2 * DAY), dayOf(nowMs - 2 * DAY) + 'T00', 'a'.repeat(16));
            await vd.run('openvibe-yt', dayOf(nowMs), dayOf(nowMs) + 'T00', 'b'.repeat(16));
            const ds = db.prepare('INSERT INTO analytics_day_salts (service, day, salt) VALUES (?, ?, ?)');
            await ds.run('openvibe-yt', dayOf(nowMs - 2 * DAY), 'deadbeef');
            await ds.run('openvibe-yt', dayOf(nowMs), 'cafebabe');
            await db.prepare("INSERT INTO analytics_daily (service, date, pageviews) VALUES ('openvibe-yt', ?, 100)").run(dayOf(nowMs - 40 * DAY));

            const r = await pruneRawEventsPg(db, { days: 30, now: () => nowMs });
            assert.strictEqual(r.removed, 5, 'only the strictly-older raw rows');
            const left = (await db.prepare('SELECT path FROM analytics_events ORDER BY path').all()).map((x) => x.path);
            assert.deepStrictEqual(left, ['/recent']);
            assert.strictEqual(Number((await db.prepare('SELECT COUNT(*) AS n FROM analytics_visitor_days').get()).n), 1, "today's visitor day is kept");
            assert.strictEqual(Number((await db.prepare('SELECT COUNT(*) AS n FROM analytics_day_salts').get()).n), 1, "today's salt is kept");
            assert.strictEqual(Number((await db.prepare('SELECT pageviews FROM analytics_daily WHERE date = ?').get(dayOf(nowMs - 40 * DAY))).pageviews), 100, 'rollups are never pruned');
        }

        console.log('analytics ADR-021 (PostgreSQL): tracked request, templates, rollups, prune ok');
    } finally {
        await closeAllTestDbs();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
})().catch((e) => { console.error(e); process.exit(1); });
