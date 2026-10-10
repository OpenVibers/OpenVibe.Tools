#!/usr/bin/env node
/** Raw analytics retention in PostgreSQL. Dry run by default.
 * Usage: node scripts/analytics-prune.js [--days N] [--apply]
 */
'use strict';
const path = require('path');
const APPS = path.join(__dirname, '..', 'apps');
function fromApps(name) {
    for (const a of ['yt', 'maps', 'food', 'img', 'docs', 'audio', 'text', 'gateway']) {
        try { return require(require.resolve(name, { paths: [path.join(APPS, a)] })); } catch { /* next */ }
    }
    throw new Error(`${name} is not installed in any app (npm run install:all)`);
}
/**
 * Prune raw analytics rows in the one tools database. Rollups stay.
 * Without --apply the command only counts. Retention covers every service.
 */
async function pgMain(argv, log) {
    if (argv.includes('--app')) {
        throw new Error('--app does not apply to the one tools database: the PostgreSQL prune covers every service at once. '
            + 'Drop --app to prune them all.');
    }
    if (!String(process.env.DATABASE_URL || '').trim()) throw new Error('DATABASE_URL is required to prune analytics');
    const i = argv.indexOf('--days');
    const raw = i >= 0 ? parseInt(argv[i + 1], 10) : 30;
    const days = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 3650) : 30;
    const apply = argv.includes('--apply');
    const { createDb } = fromApps('openvibe-sdk/db');
    const { pruneRawEventsPg } = fromApps('openvibe-shared/analytics/pg');
    const db = createDb({ url: process.env.DATABASE_URL, service: 'tools-analytics-prune', max: 1, log });
    try {
        const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
        const rows = await db.query('SELECT service, COUNT(*)::bigint AS n FROM analytics_events WHERE created_at < $1 GROUP BY service ORDER BY service', [cutoff]);
        for (const r of rows) log(`${r.service}: ${r.n} raw events older than ${days} days`);
        if (!rows.length) log(`nothing older than ${days} days`);
        if (apply) {
            const r = await pruneRawEventsPg(db, { days });
            log(`removed ${r.removed} raw events, plus visitor days and day salts, older than ${r.cutoff}`);
        } else {
            log('dry run: nothing changed (pass --apply)');
        }
    } finally {
        await db.close();
    }
}

function main(argv, log = console.log) {
    if (argv.includes('--help') || argv.includes('-h')) { log('Usage: node scripts/analytics-prune.js [--days N] [--apply]'); return; }
    const allowed = new Set(['--days', '--apply']);
    for (const arg of argv) if (arg.startsWith('--') && !allowed.has(arg)) throw new Error(`unknown option ${arg}`);
    if (!String(process.env.DATABASE_URL || '').trim()) throw new Error('DATABASE_URL is required to prune analytics');
    return pgMain(argv, log);
}
if (require.main === module) Promise.resolve().then(() => main(process.argv.slice(2))).catch((err) => { console.error(err.message); process.exit(1); });
module.exports = { main, pgMain };
