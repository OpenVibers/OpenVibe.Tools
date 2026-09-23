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
                   (an app's DATA_DIR other than data/ needs --db)`;

function main(argv, log) {
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

module.exports = { main, targets, loadSqlite };
