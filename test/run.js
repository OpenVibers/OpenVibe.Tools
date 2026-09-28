'use strict';
// npm test — every app's tests (apps/*/test/*.test.js, apps/_shared/test/*.test.js), each in its own
// process from its app directory, after a syntax check of every server file. Run on Node 22.
//
//   npm test                    # everything
//   npm test -- audio/test      # only files whose path contains one of the words
//   npm test -- --strict        # a skipped test fails the run too (or OV_TEST_STRICT=1)
//
// A test that cannot run something here prints `<label>: skipped (<why>)` (no ffmpeg, no OpenVibe.SDK
// checkout): that file is listed as `skip` with its reasons and not counted as passed, so the summary
// reads `60/62 test files passed, 2 skipped (…)`; only a run with nothing skipped says `N/N test files
// passed`. This is the rule of openvibe-shared/test-runner, copied here because this root runner has no
// dependencies of its own (each app pins openvibe-shared separately).
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APPS = path.join(ROOT, 'apps');
const strict = process.argv.includes('--strict') || process.env.OV_TEST_STRICT === '1';
const only = process.argv.slice(2).filter(a => !a.startsWith('-'));

/** `<label>: skipped (<why>)` on a line of its own (SKIP_RE from openvibe-shared/test-runner). */
const SKIP_RE = /^[ \t]*[\w .,'()/+#-]{1,120}: skipped \((.+)\)[ \t]*$/gm;

/** The skip lines in a test's output, in order, without repeats (skipsIn from openvibe-shared/test-runner). */
function skipsIn(output) {
    const out = [];
    for (const m of String(output || '').matchAll(SKIP_RE)) {
        const line = m[0].trim();
        if (!out.includes(line)) out.push(line);
    }
    return out;
}

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
const skipped = [];
for (const t of tests) {
    const name = path.relative(ROOT, t.file);
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [t.file], { cwd: path.join(APPS, t.app), encoding: 'utf8', timeout: 180_000, env: { ...process.env, NODE_ENV: 'test' } });
    const ms = Date.now() - t0;
    const skips = r.status === 0 ? skipsIn(`${r.stdout}${r.stderr}`) : [];
    if (skips.length) {
        skipped.push({ name, skips });
        console.log(`skip ${name} (${ms} ms)  ${skips.join('; ')}`);
    } else if (r.status === 0) {
        console.log(`ok   ${name} (${ms} ms)${r.stdout.trim() ? ` — ${r.stdout.trim().split('\n').pop()}` : ''}`);
    } else {
        failed.push(name);
        console.error(`FAIL ${name} (${ms} ms)\n${r.stdout}${r.stderr}${r.error ? r.error.message : ''}`);
    }
}
const passed = tests.length - failed.length - skipped.length;
console.log(`\n${passed}/${tests.length} test files passed`
    + (skipped.length ? `, ${skipped.length} skipped (${skipped.map(s => `${s.name}: ${s.skips.join('; ')}`).join(' | ')})` : '')
    + (failed.length ? `; failed: ${failed.join(', ')}` : '')
    + (strict && skipped.length ? ' — strict: skips fail the run' : ''));
process.exit(failed.length || bad || (strict && skipped.length) ? 1 : 0);
