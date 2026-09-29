#!/usr/bin/env node
/**
 * Raw analytics retention and one-time scrub for the satellites' analytics.db files (ADR-021). The
 * command itself is openvibe-shared/analytics/prune-cli; this wrapper passes a better-sqlite3 from an
 * installed app, the --app flag and the discovery of apps/<app>/data/analytics.db.
 *
 *   node scripts/analytics-prune.js                             # dry run over every apps/<app>/data/analytics.db
 *   node scripts/analytics-prune.js --app yt --scrub            # dry run for one app, including the scrub
 *   node scripts/analytics-prune.js --apply --scrub --backup <dir>   # back up each db into <dir>, then prune + scrub
 *   node scripts/analytics-prune.js --apply --no-backup         # prune without a backup (explicit)
 *   node scripts/analytics-prune.js --help                      # every option
 *
 *   --app <name>     only this app (repeatable); default: every app that has data/analytics.db
 *                    (an app's DATA_DIR other than data/ needs --db)
 *   --db <file>      an analytics database by path (repeatable; replaces the app discovery)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APPS = path.join(ROOT, 'apps');

/** A package from the first app that has it installed (the repo root has no node_modules). */
function fromApps(name) {
    for (const a of ['yt', 'maps', 'food', 'img', 'docs', 'audio', 'text', 'gateway']) {
        try { return require(require.resolve(name, { paths: [path.join(APPS, a)] })); } catch { /* next */ }
    }
    throw new Error(`${name} is not installed in any app (npm run install:all)`);
}

/** better-sqlite3 from the first app that has it installed. */
function loadSqlite() {
    return fromApps('better-sqlite3');
}

/** [{ name, file }] when no --db is given: the --app list, else every app with data/analytics.db. */
function targets(args) {
    const names = args.apps.length ? args.apps : fs.readdirSync(APPS).filter((a) => !a.startsWith('_')).sort();
    return names.map((name) => ({ name, file: path.join(APPS, name, 'data', 'analytics.db') }))
        .filter((t) => args.apps.length || fs.existsSync(t.file));
}

const USAGE_APPS = `  --app <name>     only this app (repeatable); default: every app that has data/analytics.db
                   (an app's DATA_DIR other than data/ needs --db)
  --pg             prune the one tools database (DATABASE_URL) with openvibe-shared/analytics/pg instead
                   of the apps' analytics.db files; --days <n> and --apply apply here too`;

/** The tracker's service names in the one tools database (plan T8). */
const SERVICES = ['openvibe-gateway', 'openvibe-maps', 'openvibe-food', 'openvibe-img', 'openvibe-yt', 'openvibe-audio', 'openvibe-text', 'openvibe-docs'];

/**
 * The PostgreSQL branch (plan T8, decision 5): after the cutover the raw analytics events are rows in the
 * one tools database, not SQLite files. Prunes them with openvibe-shared/analytics/pg (the rollups stay);
 * without --apply it counts only, as the SQLite dry run does. The backup/scrub/VACUUM options are for the
 * pre-cutover files and do not apply here.
 */
async function pgMain(argv, log) {
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

function main(argv, log) {
    if (argv.includes('--pg') || (process.env.DATABASE_URL && !argv.includes('--db'))) return pgMain(argv, log);
    const cli = fromApps('openvibe-shared/analytics/prune-cli');
    return cli.main(argv, {
        Database: loadSqlite(),
        log,
        options: { '--app': 'apps' },
        targets,
        usage: cli.USAGE.replace('\nOptions:\n', `\nOptions:\n${USAGE_APPS}\n`),
    });
}

if (require.main === module) fromApps('openvibe-shared/analytics/prune-cli').run(main);

module.exports = { main, pgMain, targets, loadSqlite, SERVICES };
