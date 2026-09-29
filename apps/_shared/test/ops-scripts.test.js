'use strict';
// The operational scripts and the deploy fallback after better-sqlite3 left every app (plan T8):
//   - deploy/scripts/*.sh never ask an app to load better-sqlite3 (the legacy deploy's load checks would
//     abort every deploy once the dependency is gone);
//   - scripts/ carries better-sqlite3 itself (scripts/package.json) for the cutover importer and the
//     SQLite-era reports, and they load it through scripts/sqlite.js, not from an app;
//   - analytics-prune on the one tools database refuses --app instead of silently pruning every service.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const SQLITE = ['better', 'sqlite3'].join('-');

(async () => {
    // 1. The deploy scripts.
    const deployDir = path.join(ROOT, 'deploy', 'scripts');
    for (const f of fs.readdirSync(deployDir).filter((n) => n.endsWith('.sh'))) {
        const src = fs.readFileSync(path.join(deployDir, f), 'utf8');
        assert.ok(!src.includes(`require('${SQLITE}')`) && !src.includes(`require("${SQLITE}")`), `deploy/scripts/${f} still loads ${SQLITE}`);
    }
    const legacy = fs.readFileSync(path.join(deployDir, 'deploy-legacy.sh'), 'utf8');
    assert.match(legacy, /require\('openvibe-sdk\/db'\); require\('\.\.\/_shared\/jobs'\)/, 'the jobs runtime check loads openvibe-sdk/db');
    assert.match(legacy, /require\('openvibe-sdk\/db'\); require\('\.\.\/_shared\/guard'\)/, 'the guard check loads openvibe-sdk/db');

    // 2. scripts/ owns the dependency; the scripts load it through scripts/sqlite.js.
    const pkg = JSON.parse(fs.readFileSync(path.join(SCRIPTS, 'package.json'), 'utf8'));
    assert.ok(pkg.dependencies && pkg.dependencies[SQLITE], `scripts/package.json lists ${SQLITE}`);
    assert.ok(fs.existsSync(path.join(SCRIPTS, 'package-lock.json')), 'with a lockfile');
    for (const f of ['migrate-to-postgres.js', 'analytics-prune.js', 'guard-abuse-report.js']) {
        const src = fs.readFileSync(path.join(SCRIPTS, f), 'utf8');
        assert.match(src, /require\('\.\/sqlite'\)/, `${f} loads it through scripts/sqlite.js`);
        assert.ok(!src.includes(`'${SQLITE}'`), `${f} does not resolve it by name from an app`);
    }
    try {
        require(path.join(SCRIPTS, 'sqlite.js')).loadSqlite();
    } catch (err) {
        assert.match(err.message, /npm --prefix scripts install/, 'a missing dependency says how to install it');
    }

    // 3. analytics-prune: --app on the one tools database is refused, before anything is opened.
    const prune = require(path.join(SCRIPTS, 'analytics-prune.js'));
    await assert.rejects(prune.pgMain(['--app', 'yt'], () => {}), /--app does not apply to the one tools database/);
    const before = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://nobody@127.0.0.1:1/none';
    try {
        await assert.rejects(Promise.resolve().then(() => prune.main(['--app', 'yt', '--apply'], () => {})), /--app does not apply/,
            'DATABASE_URL set, no --db: the PostgreSQL branch, and --app is refused rather than pruning every service');
    } finally {
        if (before === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = before;
    }

    console.log('ops scripts: deploy checks without the SQLite dependency, scripts/ owns it, analytics-prune refuses --app on PostgreSQL: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
