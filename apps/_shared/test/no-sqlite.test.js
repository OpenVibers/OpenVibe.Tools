'use strict';
// The SQLite era is gone (plan T8): every Tools app serves from PostgreSQL (openvibe-sdk/db) and the
// job store lives in the one `tools` database. Nothing under apps/ may require better-sqlite3, and no
// apps/*/package.json may list it. This fails loudly if either comes back.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const APPS = path.resolve(__dirname, '..', '..');
const SKIP = new Set(['node_modules', 'data', 'dist', 'build', 'coverage', '.git']);
const REQUIRE_RE = /\b(?:require\s*\(\s*['"]better-sqlite3['"]|dep\s*\(\s*['"]better-sqlite3['"]|from\s+['"]better-sqlite3['"])/;

/** Every file under dir (source and manifests), skipping node_modules and build output. */
function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (/\.(?:js|mjs|cjs|ts|json)$/.test(e.name)) out.push(p);
    }
    return out;
}

const files = walk(APPS).filter((f) => !/\.test\.js$/.test(f) || f !== __filename);
const offenders = files
    .filter((f) => path.basename(f) !== 'no-sqlite.test.js')
    .filter((f) => REQUIRE_RE.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(APPS, f));

assert.deepStrictEqual(offenders, [], `these files still require better-sqlite3:\n  ${offenders.join('\n  ')}`);

// The dependency must be gone from every app manifest (and the root, if it ever had one).
const manifests = [path.join(APPS, '..', 'package.json'), ...fs.readdirSync(APPS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !SKIP.has(e.name))
    .map((e) => path.join(APPS, e.name, 'package.json'))
    .filter((p) => fs.existsSync(p))];
for (const m of manifests) {
    const pkg = JSON.parse(fs.readFileSync(m, 'utf8'));
    assert.ok(!(pkg.dependencies && pkg.dependencies['better-sqlite3']), `${path.relative(APPS, m)} still depends on better-sqlite3`);
}

console.log(`no sqlite (nothing under apps/ requires better-sqlite3): all checks passed (${files.length} files scanned)`);
