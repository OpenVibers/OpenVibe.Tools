#!/usr/bin/env node
/**
 * Raw analytics retention and one-time scrub for the satellites' analytics.db files (ADR-021).
 *
 *   node scripts/analytics-prune.js                             # dry run over every apps/<app>/data/analytics.db
 *   node scripts/analytics-prune.js --app yt --scrub            # dry run for one app, including the scrub
 *   node scripts/analytics-prune.js --apply --scrub --backup <dir>   # back up each db into <dir>, then prune + scrub
 *   node scripts/analytics-prune.js --apply --no-backup         # prune without a backup (explicit)
 *
 * Options:
 *   --app <name>     only this app (repeatable); default: every app that has data/analytics.db
 *                    (an app's DATA_DIR other than data/ needs --db)
 *   --db <file>      an analytics database by path (repeatable; replaces the app discovery)
 *   --days <n>       keep raw events newer than n days, 1..30 (default 30)
 *   --scrub          after pruning, rewrite the remaining rows: ip/user_id/city → NULL, path → route
 *                    template, referer → origin, user_agent → class, legacy session ids → NULL; same
 *                    path/referer reduction in the rollups' top lists (their counts are untouched)
 *   --backup <path>  one database: a new file; several: a directory, each backup `<app>.analytics.db`
 *                    in it (sqlite online backup, verified with quick_check and a row count)
 *   --no-backup      explicitly skip the backup
 *   --no-vacuum      skip the VACUUM after an --apply (it needs ~2x the database size free)
 *   --batch <n>      rows per write batch (default 5000)
 *
 * --apply refuses to run without --backup or --no-backup. Rollup totals are compared before and after
 * every database; any difference exits 1. Safe to run while the satellites are up.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const retention = require('../apps/_shared/analytics/retention');

const ROOT = path.join(__dirname, '..');
const APPS = path.join(ROOT, 'apps');

/** better-sqlite3 from the first app that has it installed (the repo root has no node_modules). */
function loadSqlite() {
    for (const a of ['yt', 'maps', 'food', 'img', 'docs', 'audio', 'text', 'gateway']) {
        try { return require(require.resolve('better-sqlite3', { paths: [path.join(APPS, a)] })); } catch { /* next */ }
    }
    throw new Error('better-sqlite3 is not installed in any app (npm run install:all)');
}

function parseArgs(argv) {
    const a = { apply: false, scrub: false, vacuum: true, backup: null, noBackup: false, days: retention.MAX_DAYS, batch: retention.DEFAULT_BATCH, apps: [], dbs: [] };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        const val = () => { if (i + 1 >= argv.length) throw new Error(`${k} needs a value`); return argv[++i]; };
        if (k === '--apply') a.apply = true;
        else if (k === '--scrub') a.scrub = true;
        else if (k === '--no-vacuum') a.vacuum = false;
        else if (k === '--no-backup') a.noBackup = true;
        else if (k === '--backup') a.backup = val();
        else if (k === '--days') a.days = Number(val());
        else if (k === '--batch') a.batch = Number(val());
        else if (k === '--app') a.apps.push(val());
        else if (k === '--db') a.dbs.push(val());
        else if (k === '-h' || k === '--help') a.help = true;
        else throw new Error(`unknown option ${k}`);
    }
    retention.checkDays(a.days);
    if (!Number.isInteger(a.batch) || a.batch < 1 || a.batch > 100000) throw new Error('--batch must be 1..100000');
    if (a.backup && a.noBackup) throw new Error('--backup and --no-backup are exclusive');
    return a;
}

/** [{ name, file }] to process. */
function targets(args) {
    if (args.dbs.length) {
        const seen = new Map();
        return args.dbs.map((f) => {
            const file = path.resolve(f);
            // apps/<app>/data/analytics.db → "<app>"; anything else → the file name without extension.
            let name = path.basename(path.dirname(file)) === 'data' ? path.basename(path.dirname(path.dirname(file))) : path.basename(file, path.extname(file));
            const n = (seen.get(name) || 0) + 1;
            seen.set(name, n);
            if (n > 1) name = `${name}-${n}`;
            return { name, file };
        });
    }
    const names = args.apps.length ? args.apps : fs.readdirSync(APPS).filter((a) => !a.startsWith('_')).sort();
    return names.map((name) => ({ name, file: path.join(APPS, name, 'data', 'analytics.db') }))
        .filter((t) => args.apps.length || fs.existsSync(t.file));
}

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
function fileBytes(f) { try { return fs.statSync(f).size; } catch { return 0; } }
function freeBytes(dir) { try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return null; } }

async function runOne(Database, t, args, backupTarget, log) {
    if (!fs.existsSync(t.file)) { log(`error: ${t.file} does not exist`); return 2; }
    const db = new Database(t.file, args.apply ? { fileMustExist: true } : { readonly: true, fileMustExist: true });
    try {
        db.pragma('busy_timeout = 5000');
        const walBytes = fileBytes(t.file + '-wal');
        const before = retention.inspect(db, { days: args.days });
        log(`\n[${t.name}] ${t.file}`);
        log(`size       ${mb(before.bytes)} (+ ${mb(walBytes)} WAL); a backup needs about ${mb(before.bytes + walBytes)}; VACUUM about ${mb(2 * before.bytes)} more`);
        log(`raw events ${before.events} (oldest ${before.oldest || '-'}, newest ${before.newest || '-'})`);
        log(`prune      ${before.older} rows created before ${before.cutoff} UTC (${args.days} days); ${before.remaining} stay`);
        if (before.toScrub) {
            const s = before.toScrub;
            log(`scrub      of the rows that stay: ${s.personal} with ip/user_id/city, ${s.paths} paths to template, ${s.referers} referers to origin, ${s.user_agents} user agents to class, ${s.sessions} legacy session ids${args.scrub ? '' : '  (needs --scrub)'}`);
        }
        log(`rate rows  ${before.rateRows || 0} (IP counters; the satellites keep them in memory now)`);
        for (const [k, v] of Object.entries(before.rollups)) log(`rollups    ${k}: ${v.rows} rows, ${v.pageviews} pageviews, ${v.api_calls} api calls (kept)`);
        if (!args.apply) return 0;

        if (backupTarget) {
            if (fs.existsSync(backupTarget)) { log(`error: backup target ${backupTarget} already exists; choose a new path`); return 2; }
            const need = before.bytes + walBytes;
            const free = freeBytes(path.dirname(backupTarget));
            if (free != null && free < need * 1.1) { log(`error: ${mb(free)} free at ${path.dirname(backupTarget)}, the backup needs about ${mb(need)}`); return 2; }
            await db.backup(backupTarget);
            const b = new Database(backupTarget, { readonly: true });
            try {
                const ok = b.pragma('quick_check', { simple: true });
                const n = b.prepare("SELECT COUNT(*) FROM sqlite_master WHERE name = 'analytics_events'").pluck().get()
                    ? b.prepare('SELECT COUNT(*) FROM analytics_events').pluck().get() : 0;
                if (ok !== 'ok' || n < before.events) { log(`error: backup check failed (quick_check=${ok}, rows=${n})`); return 1; }
            } finally { b.close(); }
            log(`backup     ${backupTarget} (${mb(fileBytes(backupTarget))}, quick_check ok)`);
        }

        db.pragma('secure_delete = ON');
        const totalsBefore = retention.rollupTotals(db);
        const pruned = await retention.pruneRawEvents(db, { days: args.days, batchSize: args.batch });
        log(`pruned     ${pruned.deleted} rows in ${pruned.batches} batches`);
        if (args.scrub) {
            const s = await retention.scrubEvents(db, { batchSize: args.batch });
            const r = retention.scrubRollups(db);
            log(`scrubbed   ${s.rows} raw rows in ${s.batches} batches; rollup top lists rewritten in ${r.hourly} hourly and ${r.daily} daily rows`);
        }
        const totalsAfter = retention.rollupTotals(db);
        if (JSON.stringify(totalsBefore) !== JSON.stringify(totalsAfter)) {
            log(`error: rollup totals changed!\n before ${JSON.stringify(totalsBefore)}\n after  ${JSON.stringify(totalsAfter)}`);
            return 1;
        }
        log('rollups    totals unchanged');
        if (args.vacuum && (pruned.deleted || args.scrub)) {
            db.pragma('wal_checkpoint(TRUNCATE)');
            db.exec('VACUUM');
            db.pragma('wal_checkpoint(TRUNCATE)');
            log(`vacuumed   ${mb(fileBytes(t.file))}`);
        }
        const after = retention.inspect(db, { days: args.days });
        log(`now        ${after.events} raw events, ${after.older} older than ${args.days} days${after.toScrub ? `, ${after.toScrub.personal} with ip/user_id/city` : ''}`);
        return 0;
    } finally {
        db.close();
    }
}

async function main(argv, log = console.log) {
    let args;
    try { args = parseArgs(argv); } catch (e) { log(`error: ${e.message}`); return 2; }
    if (args.help) { log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 29).join('\n')); return 0; }
    const list = targets(args);
    if (!list.length) { log('no analytics databases found (use --app or --db)'); return 2; }
    if (args.apply && !args.backup && !args.noBackup) {
        log('refusing --apply without a backup: pass --backup <new file or directory> (sqlite online backup) or --no-backup');
        return 2;
    }
    let backupFor = () => null;
    if (args.apply && args.backup) {
        const target = path.resolve(args.backup);
        if (list.length === 1) {
            backupFor = () => target;
        } else {
            if (fs.existsSync(target) && !fs.statSync(target).isDirectory()) { log(`error: ${target} is a file; several databases need a directory`); return 2; }
            const clash = list.map((t) => path.join(target, `${t.name}.analytics.db`)).filter((f) => fs.existsSync(f));
            if (clash.length) { log(`error: backup targets already exist: ${clash.join(', ')}`); return 2; }
            fs.mkdirSync(target, { recursive: true });
            backupFor = (t) => path.join(target, `${t.name}.analytics.db`);
        }
    }
    const Database = loadSqlite();
    let worst = 0;
    for (const t of list) {
        const code = await runOne(Database, t, args, backupFor(t), log);
        worst = Math.max(worst, code);
        if (code) { log(`[${t.name}] stopped (exit ${code}); later databases not touched`); break; }
    }
    if (!args.apply && worst === 0) log('\ndry run: nothing changed. Re-run with --apply --backup <file|dir> (or --no-backup).');
    return worst;
}

if (require.main === module) {
    main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(err); process.exit(1); });
}

module.exports = { main, parseArgs, targets };
