'use strict';
// ═══════════════════════════════════════════════════════════════
// scripts/migrate-to-postgres.js — the one-time move of every Tools SQLite file into the ONE `tools`
// PostgreSQL database (plan T8, decision 3/6; ADR-035). The operator (Opus) runs it at cutover.
//
//   node scripts/migrate-to-postgres.js                      # production: DATABASE_DIRECT_URL (owner role)
//   node scripts/migrate-to-postgres.js --pglite             # an in-memory rehearsal (report only)
//   node scripts/migrate-to-postgres.js --dry-run --url postgres://…/tools_scratch   # a scratch database
//   node scripts/migrate-to-postgres.js --app maps --app gateway [--json]
//
// Every app's data/<guard|jobs|analytics>.db is imported into the shared tables, tagged with its app id
// (`app` = the app name; the analytics tables already carry `service`). guard_salt and guard_day are not
// copied (Valkey, decision 4); the event outbox and token_revocations are left behind (the SDK re-creates
// its own tables at boot and a revocation cutoff is re-derivable). The SQLite files are opened read-only.
//
// It relies on the newer openvibe-sdk/db (0.25+) and better-sqlite3; OV_SDK_DIR points at an openvibe-sdk
// checkout, else the gateway's node_modules is used. Not part of `npm test`.
// ═══════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const ROOT = path.join(__dirname, '..');
const APPS = path.join(ROOT, 'apps');
const MIGRATIONS = path.join(ROOT, 'migrations');

// One row per kind of file, in every app. `tables` = the target tables that file fills; `app` = the ones
// that carry the app id; `skip` = source tables deliberately not imported (importSqlite would otherwise
// report them as having no target); `omit` = identity columns the target must assign itself (each app's
// ids are per-app and would collide in the one shared table: the import reads a temp table of the same
// name without them, so PostgreSQL issues fresh, globally unique ids — nothing references these ids).
const KINDS = {
    'guard.db': { tables: ['guard_abuse'], app: ['guard_abuse'], skip: ['guard_salt', 'guard_day'], omit: { guard_abuse: ['id'] } },
    'jobs.db': { tables: ['tool_jobs', 'tool_job_events', 'tool_job_references', 'tool_job_usage'], app: ['tool_jobs', 'tool_job_usage'], skip: ['event_outbox'], omit: { tool_job_events: ['seq'] } },
    'analytics.db': { tables: ['analytics_events', 'analytics_hourly', 'analytics_daily', 'analytics_visitor_days', 'analytics_day_salts'], app: [], skip: ['analytics_rate_tracking'], omit: { analytics_events: ['id'], analytics_hourly: ['id'], analytics_daily: ['id'] } },
};
const TARGETS = [...new Set(Object.values(KINDS).flatMap((k) => k.tables))];

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] || null : null; };
const repeat = (n) => argv.flatMap((a, i) => (a === `--${n}` && argv[i + 1] ? [argv[i + 1]] : []));
const quiet = { log() {}, warn: console.warn, error: console.error };

if (has('help')) {
    console.log('usage: node scripts/migrate-to-postgres.js [--pglite | --url <DATABASE_DIRECT_URL>] [--dry-run] [--app <name>]… [--json]');
    process.exit(0);
}

/** Resolve openvibe-sdk/db from OV_SDK_DIR or an app's node_modules (so better-sqlite3 resolves too). */
function sdkRequire() {
    const dir = process.env.OV_SDK_DIR || path.join(APPS, 'gateway', 'node_modules', 'openvibe-sdk');
    try {
        const req = createRequire(path.join(dir, 'package.json'));
        return req('openvibe-sdk/db');
    } catch (err) {
        throw new Error(`openvibe-sdk/db could not be loaded from ${dir} (${err.message}); it needs openvibe-sdk 0.25+ (OV_SDK_DIR overrides)`);
    }
}

/** Every app's data/<name>.db, in a deterministic order, optionally narrowed with --app. */
function discover(apps) {
    const out = [];
    for (const app of fs.readdirSync(APPS).sort()) {
        if (app.startsWith('_') || (apps.length && !apps.includes(app))) continue;
        const dir = path.join(APPS, app, 'data');
        if (!fs.existsSync(dir)) continue;
        for (const name of Object.keys(KINDS).sort()) {
            const file = path.join(dir, name);
            if (fs.existsSync(file) && fs.statSync(file).isFile() && fs.statSync(file).size > 0) out.push({ app, kind: name, file });
        }
    }
    return out;
}

/** Require a module as one app would (so better-sqlite3 resolves from that app's node_modules). */
function appRequire(app, name) {
    return createRequire(path.join(APPS, app, 'package.json'))(name);
}

const q = (x) => `"${String(x).replace(/"/g, '""')}"`;

/**
 * Import one SQLite file. Identity-keyed tables (guard_abuse.id, tool_job_events.seq, the analytics ids)
 * are read through a temp table of the same name without the identity column, so PostgreSQL assigns a
 * fresh, globally unique id (per-app ids would collide in the one shared database). Nothing references
 * those ids. The file is opened read-only.
 */
async function importFile({ app, file, spec, db, importSqlite, first }) {
    const Database = appRequire(app, 'better-sqlite3');
    const src = new Database(file, { readonly: true, fileMustExist: true });
    try {
        for (const [table, drop] of Object.entries(spec.omit || {})) {
            const have = src.prepare(`PRAGMA table_info(${q(table)})`).all().map((c) => c.name);
            if (!have.length) continue;   // the source has no such table (a lazily created one): nothing to import
            const keep = have.filter((c) => !drop.includes(c));
            src.exec(`CREATE TEMP TABLE ${q(table)} AS SELECT ${keep.map(q).join(', ')} FROM main.${q(table)}`);
        }
        return await importSqlite({ sqlite: src, db, only: spec.tables, tables: {}, skipSource: spec.skip, truncate: false, verify: first, log: quiet });
    } finally { src.close(); }
}

async function main() {
    const apps = repeat('app');
    const sdk = sdkRequire();
    const { createDb, importSqlite } = sdk;

    let db;
    if (has('pglite') || (has('dry-run') && !opt('url'))) {
        db = createDb({ pglite: true, service: 'tools-import', log: quiet });
    } else {
        const url = opt('url') || process.env.DATABASE_DIRECT_URL;
        if (!url) throw new Error('set DATABASE_DIRECT_URL (the owner, direct connection), or pass --pglite / --dry-run --url <scratch>');
        if (has('dry-run') && !opt('url')) throw new Error('--dry-run needs an explicit scratch --url (or --pglite) so production is never touched');
        db = createDb({ url, service: 'tools-import', max: 2, log: quiet });
    }

    const files = discover(apps);
    const report = { store: db.store, files: [], tables: {}, problems: [] };
    const sourceCount = {};   // target table → rows seen in the SQLite files
    const doneKind = new Set();

    try {
        await db.migrate({ dir: MIGRATIONS, log: quiet });
        await db.query(`TRUNCATE ${TARGETS.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);

        for (const { app, kind, file } of files) {
            const spec = KINDS[kind];
            const first = !doneKind.has(kind);
            doneKind.add(kind);
            const r = await importFile({ app, file, spec, db, importSqlite, first });
            const rows = {};
            for (const t of r.tables) { rows[t.table] = t.rows; sourceCount[t.table] = (sourceCount[t.table] || 0) + t.rows; }
            // Tag the app-scoped rows this file just inserted (they came in with the '' default).
            for (const t of spec.app) await db.query(`UPDATE "${t}" SET app = $1 WHERE app = ''`, [app]);
            if (!r.ok) for (const p of r.problems) report.problems.push({ app, kind, ...p });
            report.files.push({ app, kind, file: path.relative(ROOT, file), rows, verified: first, checksums: Object.fromEntries(r.tables.map((t) => [t.table, t.checksum]).filter(([, c]) => c)) });
            if (process.stdout.isTTY) process.stderr.write(`[import] ${app}/${kind}: ${JSON.stringify(rows)}\n`);
        }

        // Reconcile counts across apps (per-file verification only covers the first file of a kind).
        for (const t of TARGETS) {
            const pg = Number((await db.maybe(`SELECT count(*) AS n FROM "${t}"`)).n);
            const src = sourceCount[t] || 0;
            report.tables[t] = { source: src, postgres: pg, ok: src === pg };
            if (src !== pg) report.problems.push({ table: t, problem: `count mismatch: ${src} SQLite rows, ${pg} PostgreSQL rows` });
        }
        report.ok = report.problems.length === 0;
    } finally {
        await db.close();
    }

    if (has('json')) { console.log(JSON.stringify(report, null, 2)); }
    else {
        console.log(`import → ${report.store}: ${report.ok ? 'OK' : 'PROBLEMS'}`);
        for (const [t, c] of Object.entries(report.tables)) console.log(`  ${t.padEnd(26)} ${String(c.source).padStart(7)} SQLite rows → ${String(c.postgres).padStart(7)} PostgreSQL rows${c.ok ? '' : '   MISMATCH'}`);
        for (const p of report.problems) console.log(`  problem: ${p.app ? `${p.app}/${p.kind} ` : ''}${p.table}: ${p.problem}`);
    }
    process.exit(report.ok ? 0 : 1);
}

main().catch((err) => { console.error(`migrate-to-postgres: ${err.message}`); process.exit(1); });
