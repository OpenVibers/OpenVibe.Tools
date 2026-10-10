#!/usr/bin/env node
/** Report guard abuse rows from PostgreSQL. Usage: node scripts/guard-abuse-report.js [--url URL] [--json] */
'use strict';
const path = require('path');
const APPS = path.join(__dirname, '..', 'apps');
function fromApps(name) {
    for (const a of ['gateway', 'maps', 'img', 'docs', 'audio', 'text', 'yt', 'food']) {
        try { return require(require.resolve(name, { paths: [path.join(APPS, a)] })); } catch { /* next */ }
    }
    throw new Error(`${name} is not installed in any app (npm run install:all)`);
}
function parseArgs(argv) {
    const out = { url: null, json: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--url') out.url = argv[++i];
        else if (a === '--json') out.json = true;
        else if (a === '--help' || a === '-h') out.help = true;
        else throw new Error(`unknown option "${a}" (--help for usage)`);
    }
    return out;
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
        log(`\n${r.app} (${r.file})  ${r.reported.length} reason/tool group${r.reported.length === 1 ? '' : 's'} recorded but not enforced`);
        if (!r.reported.length) { log('  (nothing was reported: no would-be refusal in the database)'); }
        for (const row of r.reported) {
            log(`  ${String(row.events).padStart(6)} event${Number(row.events) === 1 ? ' ' : 's'}  reason=${row.reason}  tool=${row.tool || '(none)'}`
                + `  rows=${row.rows}  addresses=${row.addresses}  ${fmtTime(row.first_at)} … ${fmtTime(row.last_at)}`);
        }
        if (r.enforced.length) {
            log('  — already enforced (context):');
            for (const row of r.enforced) log(`  ${String(row.events).padStart(6)} event${Number(row.events) === 1 ? ' ' : 's'}  reason=${row.reason}  tool=${row.tool || '(none)'}`);
        }
    }
    if (!any) log('\nNo guard abuse rows were found.');
    log('\nReview each reason/tool pair above: any one that fires on ordinary traffic is a false');
    log('positive that TOOLS_GUARD=enforce would turn into a 429 for a real visitor.');
}

async function main(argv, log = console.log) {
    const args = parseArgs(argv);
    if (args.help) {
        log('Usage: node scripts/guard-abuse-report.js [--url URL] [--json]');
        return;
    }
    const results = [];
    const url = args.url || process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL or --url is required');
    await reportPg(results, url);
    if (args.json) log(JSON.stringify({ generated_at: new Date().toISOString(), results }, null, 2));
    else printReport(results, log);
}

if (require.main === module) {
    main(process.argv.slice(2)).catch((err) => { console.error(err.message); process.exit(1); });
}

module.exports = { main, parseArgs, SELECT, SELECT_ENFORCED, fromApps, printReport };
