'use strict';
// npm test — every app's tests (apps/*/test/*.test.js, apps/_shared/test/*.test.js), each in its own
// process from its app directory, after a syntax check of every server file. Run on Node 22.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APPS = path.join(ROOT, 'apps');
const only = process.argv.slice(2);

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'data' || e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
}

const apps = fs.readdirSync(APPS).filter(a => fs.statSync(path.join(APPS, a)).isDirectory()).sort();

// 1. Syntax: every server-side file and the shared runtime.
let bad = 0;
const sources = apps.flatMap(a => (fs.existsSync(path.join(APPS, a, 'server')) ? walk(path.join(APPS, a, 'server')) : []))
    .concat(walk(path.join(APPS, '_shared')));
for (const f of sources) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) { bad++; console.error(`syntax: ${path.relative(ROOT, f)}\n${r.stderr}`); }
}
console.log(`syntax: ${sources.length - bad}/${sources.length} files ok`);

// 2. Tests.
const tests = apps.flatMap(a => {
    const dir = path.join(APPS, a, 'test');
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.test.js')).sort().map(f => ({ app: a, file: path.join(dir, f) })) : [];
}).filter(t => !only.length || only.some(o => t.file.includes(o)));

const failed = [];
for (const t of tests) {
    const name = path.relative(ROOT, t.file);
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [t.file], { cwd: path.join(APPS, t.app), encoding: 'utf8', timeout: 180_000, env: { ...process.env, NODE_ENV: 'test' } });
    const ms = Date.now() - t0;
    if (r.status === 0) {
        console.log(`ok   ${name} (${ms} ms)${r.stdout.trim() ? ` — ${r.stdout.trim().split('\n').pop()}` : ''}`);
    } else {
        failed.push(name);
        console.error(`FAIL ${name} (${ms} ms)\n${r.stdout}${r.stderr}${r.error ? r.error.message : ''}`);
    }
}
console.log(`\n${tests.length - failed.length}/${tests.length} test files passed${failed.length ? `; failed: ${failed.join(', ')}` : ''}`);
process.exit(failed.length || bad ? 1 : 0);
