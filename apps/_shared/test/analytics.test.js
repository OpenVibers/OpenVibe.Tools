'use strict';
// ADR-021 analytics bounds for every satellite (apps/_shared/analytics, scripts/analytics-prune.js):
// a tracked request stores no IP, user id, city, raw user agent, raw referer or query string anywhere
// in analytics.db; paths are route templates; uniques come from day-scoped hashes deleted after the
// day's rollup; prune removes strictly-older raw rows in bounded batches and never touches rollups;
// scrub rewrites legacy rows without changing a rollup counter; the CLI dry run changes nothing and
// --apply needs --backup or --no-backup.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { dep } = require('./deps');
const { AnalyticsTracker, privacy, retention } = require('../analytics');
const { sqlTime } = require('../analytics/tracker');
const cli = require('../../../scripts/analytics-prune');

const express = dep('express');
const Database = dep('better-sqlite3');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-tools-analytics-'));
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';
const SUBJECT = 'usr_01J8ZQ4K7M2N3P4Q5R6S7T8V9W';
const newDb = (name) => { const db = new Database(path.join(tmp, name)); db.pragma('journal_mode = WAL'); return db; };
const dumpAll = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").pluck().all()
    .map((t) => JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all())).join('\n');

function seedLegacy(db, nowMs) {
    new AnalyticsTracker(db, 'openvibe-yt', { timers: false }).destroy();
    const ins = db.prepare(`INSERT INTO analytics_events (service, event_type, path, method, status_code, user_id, session_id, ip, city, user_agent, referer, created_at)
        VALUES ('openvibe-yt', 'pageview', ?, 'GET', 200, ?, ?, ?, ?, ?, ?, ?)`);
    const cutoffMs = nowMs - 30 * 86400000;
    for (let i = 0; i < 10; i++) ins.run(`/watch/dQw4w9WgXc${i}?v=${i}`, 7, 'tokentail' + i, '198.51.100.' + i, 'Lyon', CHROME, 'https://t.co/x?y=1', sqlTime(nowMs - (40 + i) * 86400000));
    ins.run('/edge-older', null, null, '198.51.100.50', null, CHROME, '', sqlTime(cutoffMs - 1000));
    ins.run('/edge-exact', null, null, '198.51.100.51', null, CHROME, '', sqlTime(cutoffMs));
    ins.run('/api/info/abc123def?url=https://youtube.com/watch?v=x', 9, 'abcdef0123456789', '198.51.100.52', 'Oslo', FIREFOX, 'https://www.reddit.com/r/a', sqlTime(nowMs - 2 * 86400000));
    const tops = JSON.stringify([{ path: '/watch/dQw4w9WgXcQ', cnt: 3 }, { path: '/watch/9bZkp7q19f0', cnt: 2 }]);
    const refs = JSON.stringify([{ referer: 'https://www.google.com/search?q=x', cnt: 4 }]);
    db.prepare('INSERT INTO analytics_daily (service, date, pageviews, api_calls, unique_visitors, unique_users, new_users, top_paths, top_referers) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run('openvibe-yt', sqlTime(nowMs - 60 * 86400000).slice(0, 10), 100, 40, 30, 10, 2, tops, refs);
    db.prepare('INSERT INTO analytics_hourly (service, hour, pageviews, api_calls, unique_visitors, unique_users, top_paths, top_referers) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('openvibe-yt', sqlTime(nowMs - 3 * 86400000).slice(0, 13) + ':00:00', 10, 4, 3, 1, tops, refs);
    db.prepare("INSERT INTO analytics_rate_tracking (ip, window_start, hit_count) VALUES ('198.51.100.99', 1, 1)").run();
}

(async () => {
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
        const db = newDb('track.db');
        let clock = Date.parse('2026-09-23T10:15:00Z');
        const tracker = new AnalyticsTracker(db, 'openvibe-yt', { timers: false, now: () => clock });
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
        tracker.flush();
        const rows = db.prepare('SELECT * FROM analytics_events ORDER BY id').all();
        assert.deepStrictEqual(rows.map((r) => r.path), ['/api/jobs/:id', '/watch/:param']);
        assert.deepStrictEqual(rows.map((r) => r.authenticated), [1, 0]);
        for (const r of rows) {
            assert.ok(r.ip === null && r.user_id === null && r.city === null);
            assert.strictEqual(r.referer, 'https://www.google.com');
            assert.ok(/^[0-9a-f]{16}$/.test(r.session_id));
        }
        const all = dumpAll(db);
        for (const needle of ['203.0.113.77', '198.51.100.9', '127.0.0.1', SUBJECT, 'supersecret', 'secret-query', '98765', 'dQw4w9WgXcQ', 'Mozilla/5.0']) {
            assert.ok(!all.includes(needle), `found ${needle}`);
        }
        tracker.aggregate();
        const d = db.prepare("SELECT * FROM analytics_daily WHERE date = '2026-09-23'").get();
        assert.strictEqual(d.unique_visitors, 2);
        assert.strictEqual(d.unique_users, 1);
        clock = Date.parse('2026-09-24T00:10:00Z');
        tracker.aggregate();
        assert.strictEqual(db.prepare('SELECT COUNT(*) FROM analytics_visitor_days').pluck().get(), 0);
        assert.strictEqual(db.prepare('SELECT COUNT(*) FROM analytics_day_salts').pluck().get(), 0);
        assert.strictEqual(db.prepare("SELECT unique_visitors FROM analytics_daily WHERE date = '2026-09-23'").pluck().get(), 2);
        assert.ok(tracker.getStats({ days: 30 }).summary);
        assert.ok(Array.isArray(tracker.getBotAnalysis(7).topBotIPs));
        tracker.destroy();
        db.close();
    }

    // ── Prune boundaries, rollups untouched ──
    {
        const db = newDb('prune.db');
        const nowMs = Date.parse('2026-09-23T12:00:00Z');
        seedLegacy(db, nowMs);
        const totals = retention.rollupTotals(db);
        const part = await retention.pruneRawEvents(db, { days: 30, batchSize: 4, maxBatches: 1, now: () => nowMs });
        assert.deepStrictEqual([part.deleted, part.complete], [4, false]);
        const rest = await retention.pruneRawEvents(db, { days: 30, batchSize: 4, now: () => nowMs });
        assert.strictEqual(rest.deleted, 7);
        assert.deepStrictEqual(db.prepare('SELECT path FROM analytics_events ORDER BY created_at').pluck().all().map((p) => p.split('?')[0]), ['/edge-exact', '/api/info/abc123def']);
        assert.deepStrictEqual(retention.rollupTotals(db), totals);
        assert.strictEqual(db.prepare('SELECT COUNT(*) FROM analytics_rate_tracking').pluck().get(), 0);

        // Scrub the survivors and the rollup lists.
        await retention.scrubEvents(db, { batchSize: 1 });
        retention.scrubRollups(db);
        assert.deepStrictEqual(retention.rollupTotals(db), totals);
        const rows = db.prepare('SELECT * FROM analytics_events ORDER BY created_at').all();
        assert.deepStrictEqual(rows.map((r) => r.path), ['/edge-exact', '/api/info/:id']);
        assert.deepStrictEqual(rows.map((r) => r.authenticated), [0, 1]);
        assert.deepStrictEqual(JSON.parse(db.prepare('SELECT top_paths FROM analytics_daily').pluck().get()), [{ path: '/watch/:param', cnt: 5 }]);
        const all = dumpAll(db);
        for (const needle of ['198.51.100.', 'Lyon', 'Oslo', 'q=x', 'dQw4w9WgXcQ', 'Mozilla/5.0']) assert.ok(!all.includes(needle), needle);
        db.close();
    }

    // ── CLI ──
    {
        const out = [];
        const log = (l) => out.push(l);
        const make = (name) => {
            const file = path.join(tmp, name, 'data', 'analytics.db');
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const db = new Database(file);
            db.pragma('journal_mode = WAL');
            seedLegacy(db, Date.now() + 120000); // edge rows clear of the CLI's own cutoff: 10 older rows
            db.pragma('wal_checkpoint(TRUNCATE)');
            db.close();
            return file;
        };
        const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
        const yt = make('yt');
        const food = make('food');
        const hashes = [sha(yt), sha(food)];

        assert.strictEqual(await cli.main(['--db', yt, '--db', food, '--scrub'], log), 0);
        assert.deepStrictEqual([sha(yt), sha(food)], hashes, 'dry run changed a file');
        assert.ok(out.some((l) => /prune\s+10 rows/.test(l)), out.join('\n'));
        assert.ok(out.some((l) => /dry run: nothing changed/.test(l)));

        assert.strictEqual(await cli.main(['--db', yt, '--apply'], log), 2);
        assert.strictEqual(await cli.main(['--db', yt, '--apply', '--no-backup', '--days', '45'], log), 2);
        assert.deepStrictEqual([sha(yt), sha(food)], hashes, 'a refused run changed a file');

        const bdir = path.join(tmp, 'backups');
        assert.strictEqual(await cli.main(['--db', yt, '--db', food, '--apply', '--scrub', '--backup', bdir], log), 0, out.join('\n'));
        for (const [name, file] of [['yt', yt], ['food', food]]) {
            const b = new Database(path.join(bdir, `${name}.analytics.db`), { readonly: true });
            assert.strictEqual(b.prepare('SELECT COUNT(*) FROM analytics_events').pluck().get(), 13);
            b.close();
            const db = new Database(file, { readonly: true });
            assert.strictEqual(db.prepare('SELECT COUNT(*) FROM analytics_events').pluck().get(), 3);
            assert.strictEqual(db.prepare('SELECT COUNT(*) FROM analytics_events WHERE ip IS NOT NULL OR user_id IS NOT NULL OR city IS NOT NULL').pluck().get(), 0);
            assert.strictEqual(db.prepare('SELECT SUM(pageviews) FROM analytics_daily').pluck().get(), 100);
            db.close();
        }
        // Existing backup targets are refused.
        assert.strictEqual(await cli.main(['--db', yt, '--db', food, '--apply', '--backup', bdir], log), 2);
    }

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('analytics ADR-021: tracked request, templates, rollups, prune, scrub, CLI ok');
})().catch((e) => { console.error(e); process.exit(1); });
