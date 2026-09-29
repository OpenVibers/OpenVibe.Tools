#!/usr/bin/env node
/**
 * Phase 0 of plan T8 — enforce-mode readiness for the tools guard.
 *
 * In report mode (`TOOLS_GUARD` unset) the guard records every refusal it *would* make into
 * `guard_abuse` with `enforced = 0`. Before flipping `TOOLS_GUARD=enforce`, read those rows and
 * confirm no reason fires on ordinary traffic: a false positive that report mode merely logged
 * becomes a 429 for a real visitor in enforce mode.
 *
 * This groups `guard_abuse WHERE enforced = 0` by (reason, tool) and prints, per reason/tool, how
 * many rows (and how many repeats the `count` column folds in), across how many hashed addresses,
 * and the window it happened in. The PowerShell with `enforced = 1` rows is printed too, for
 * context. It reads copies — never a live file it also writes.
 *
 *   node scripts/guard-abuse-report.js                       # every apps/<app>/data/guard.db
 *   node scripts/guard-abuse-report.js --app maps --app gateway
 *   node scripts/guard-abuse-report.js --db /backups/maps/guard.db
 *   node scripts/guard-abuse-report.js --json                # machine-readable, one JSON document
 *   node scripts/guard-abuse-report.js --pg                  # the migrated database (DATABASE_URL)
 *   node scripts/guard-abuse-report.js --pg --url postgres://…    # a specific PostgreSQL database
 *
 *   --app <name>   only this app (repeatable); default: every app that has data/guard.db
 *   --db <file>    a guard database by path (repeatable; replaces the app discovery)
 *   --pg           read guard_abuse from PostgreSQL (DATABASE_URL, or --url) instead of SQLite files
 *   --url <url>    the PostgreSQL URL (implies --pg)
 *   --json         emit JSON instead of text
 *
 * After the T8 migration the guard's abuse log lives in the one `tools` database, so --pg is the
 * form to use on production once the rows have moved. Before that, the SQLite files are the source.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APPS = path.join(ROOT, 'apps');

/** A package from the first app that has it installed (the repo root has no node_modules). */
function fromApps(name) {
    for (const a of ['gateway', 'maps', 'img', 'docs', 'audio', 'text', 'yt', 'food']) {
        try { return require(require.resolve(name, { paths: [path.join(APPS, a)] })); } catch { /* next */ }
    }
    throw new Error(`${name} is not installed in any app (npm run install:all)`);
}

function parseArgs(argv) {
    const out = { apps: [], dbs: [], pg: false, url: null, json: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--app') out.apps.push(argv[++i]);
        else if (a === '--db') out.dbs.push(argv[++i]);
        else if (a === '--pg') out.pg = true;
        else if (a === '--url') { out.url = argv[++i]; out.pg = true; }
        else if (a === '--json') out.json = true;
        else if (a === '--help' || a === '-h') out.help = true;
        else throw new Error(`unknown option "${a}" (--help for usage)`);
    }
    return out;
}

/** [{ name, file }] when no --db is given: the --app list, else every app with data/guard.db. */
function targets(args) {
    const names = args.apps.length ? args.apps : fs.readdirSync(APPS).filter((a) => !a.startsWith('_')).sort();
    return names.map((name) => ({ name, file: path.join(APPS, name, 'data', 'guard.db') }))
        .filter((t) => args.apps.length || fs.existsSync(t.file));
}

// reason, tool, and how many rows/repeats/minutes/addresses a group covers, plus its window.
const SELECT = `
SELECT reason,
       tool,
       COUNT(*)                        AS rows,
       COALESCE(SUM(count), 0)         AS events,
       COUNT(DISTINCT ip_hash)         AS addresses,
       MIN(at)                         AS first_at,
       MAX(at)                         AS last_at
  FROM guard_abuse
 WHERE enforced = 0
 GROUP BY reason, tool
 ORDER BY events DESC, reason, tool`;

// The enforced rows, only for context (what has actually been refused since the mode flag flipped).
const SELECT_ENFORCED = `
SELECT reason, tool, COUNT(*) AS rows, COALESCE(SUM(count), 0) AS events
  FROM guard_abuse
 WHERE enforced = 1
 GROUP BY reason, tool
 ORDER BY events DESC, reason, tool`;

function tableExists(db, name) {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function reportSqlite(results, target, Database) {
    if (!fs.existsSync(target.file)) { results.push({ app: target.name, file: target.file, present: false }); return; }
    // Read-only: a report never writes to the file it reads (a live file may be in WAL).
    const db = new Database(target.file, { readonly: true, fileMustExist: true });
    try {
        if (!tableExists(db, 'guard_abuse')) { results.push({ app: target.name, file: target.file, present: true, hasTable: false }); return; }
        results.push({
            app: target.name,
            file: target.file,
            present: true,
            hasTable: true,
            mode: 'sqlite',
            reported: db.prepare(SELECT).all(),
            enforced: db.prepare(SELECT_ENFORCED).all(),
        });
    } finally { db.close(); }
}

async function reportPg(results, url) {
    const { Client } = fromApps('pg');
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
        await client.query('BEGIN READ ONLY');
        const reported = (await client.query(SELECT)).rows;
        const enforced = (await client.query(SELECT_ENFORCED)).rows;
        await client.query('ROLLBACK');
        results.push({ app: 'postgres', file: url.replace(/:\/\/[^@/]*@/, '://***@'), present: true, hasTable: true, mode: 'postgresql', reported, enforced });
    } finally { await client.end(); }
}

const fmtTime = (ms) => (ms == null ? '—' : new Date(Number(ms)).toISOString());

function printReport(results, log) {
    let any = false;
    for (const r of results) {
        if (!r.present) { log(`\n${r.app}: no guard database (${r.file}) — skipped`); continue; }
        if (r.hasTable === false) { log(`\n${r.app}: ${r.file} has no guard_abuse table — skipped`); continue; }
        any = true;
        log(`\n${r.app} (${r.file})$  ${r.reported.length} reason/tool group${r.reported.length === 1 ? '' : 's'} recorded but not enforced`);
        if (!r.reported.length) { log('  (nothing was reported: no would-be refusal on this copy)'); }
        for (const row of r.reported) {
            log(`  ${String(row.events).padStart(6)} event${Number(row.events) === 1 ? ' ' : 's'}  reason=${row.reason}  tool=${row.tool || '(none)'}`
                + `  rows=${row.rows}  addresses=${row.addresses}  ${fmtTime(row.first_at)} … ${fmtTime(row.last_at)}`);
        }
        if (r.enforced.length) {
            log('  — already enforced (context):');
            for (const row of r.enforced) log(`  ${String(row.events).padStart(6)} event${Number(row.events) === 1 ? ' ' : 's'}  reason=${row.reason}  tool=${row.tool || '(none)'}`);
        }
    }
    if (!any) log('\nNo guard database with a guard_abuse table was found.');
    log('\nReview each reason/tool pair above: any one that fires on ordinary traffic is a false');
    log('positive that TOOLS_GUARD=enforce would turn into a 429 for a real visitor.');
}

async function main(argv, log = console.log) {
    const args = parseArgs(argv);
    if (args.help) {
        const usage = fs.readFileSync(__filename, 'utf8').split('\n').filter((l) => /^ \*/.test(l)).slice(0, 22).join('\n');
        log(usage.replace(/^ \* ?/gm, ''));
        return;
    }
    const results = [];
    if (args.pg) {
        const url = args.url || process.env.DATABASE_URL;
        if (!url) throw new Error('--pg needs DATABASE_URL or --url');
        await reportPg(results, url);
    } else {
        const Database = fromApps('better-sqlite3');
        const list = args.dbs.length ? args.dbs.map((f) => ({ name: path.basename(path.dirname(path.dirname(f))) || 'db', file: path.resolve(f) })) : targets(args);
        for (const t of list) reportSqlite(results, t, Database);
    }
    if (args.json) log(JSON.stringify({ generated_at: new Date().toISOString(), results }, null, 2));
    else printReport(results, log);
}

if (require.main === module) {
    main(process.argv.slice(2)).catch((err) => { console.error(err.message); process.exit(1); });
}

module.exports = { main, targets, parseArgs, SELECT, SELECT_ENFORCED, fromApps, printReport };
