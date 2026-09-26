'use strict';
/**
 * apps/_shared as a versioned package (roadmap WS-L task 3): the version and its changelog entry,
 * the range matcher, every app's declared range, and the boot check toolsRelease() runs.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { VERSION, FIELD, satisfies, declared, requireShared } = require('../version');

const SHARED = path.join(__dirname, '..');
const APPS = path.join(SHARED, '..');

// The version is semver and the changelog says what it is.
assert.match(VERSION, /^\d+\.\d+\.\d+$/);
assert.ok(fs.readFileSync(path.join(SHARED, 'CHANGELOG.md'), 'utf8').includes(`## ${VERSION} `), `CHANGELOG.md has an entry for ${VERSION}`);
assert.deepStrictEqual(Object.keys(require('../package.json').dependencies || {}), [], '_shared takes packages from the app that requires it');

// The range matcher.
for (const [v, r, ok] of [
    ['1.0.0', '^1.0.0', true], ['1.4.2', '^1.0.0', true], ['2.0.0', '^1.0.0', false], ['0.9.0', '^1.0.0', false],
    ['1.2.0', '^1.3.0', false], ['1.3.5', '~1.3.0', true], ['1.4.0', '~1.3.0', false],
    ['0.2.5', '^0.2.1', true], ['0.3.0', '^0.2.1', false],
    ['1.0.0', '1.0.0', true], ['1.0.1', '1.0.0', false],
    ['1.0.0', '>=1.0.0', false], ['1.0.0', '', false], ['1.0.0', null, false], ['x', '^1.0.0', false],
]) assert.strictEqual(satisfies(v, r), ok, `${v} ${ok ? 'satisfies' : 'does not satisfy'} ${r}`);

// Every app declares a range this checkout satisfies.
const apps = fs.readdirSync(APPS).filter((a) => !a.startsWith('_') && fs.existsSync(path.join(APPS, a, 'package.json')));
assert.ok(apps.length >= 8, `found ${apps.length} apps`);
for (const a of apps) {
    const range = declared(a);
    assert.ok(range, `apps/${a}/package.json declares "${FIELD}"`);
    assert.ok(satisfies(VERSION, range), `apps/${a} needs ${range}; _shared is ${VERSION}`);
    assert.deepStrictEqual(requireShared(a), { version: VERSION, range });
    // and it boots through toolsRelease, which checks it
    assert.match(fs.readFileSync(path.join(APPS, a, 'server', 'index.js'), 'utf8'), /_shared\/release'\)\.toolsRelease\(/, `apps/${a} boots through toolsRelease`);
}

// An app without a range, or with one this checkout does not satisfy, does not boot.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-shared-ver-'));
const app = (name, pkg) => { fs.mkdirSync(path.join(dir, name)); fs.writeFileSync(path.join(dir, name, 'package.json'), JSON.stringify(pkg)); };
app('none', { name: 'x' });
app('old', { [FIELD]: '^0.9.0' });
app('next', { [FIELD]: '^2.0.0' });
assert.throws(() => requireShared('none', { appsDir: dir }), /declares no "openvibeToolsShared" range/);
assert.throws(() => requireShared('old', { appsDir: dir, version: '1.0.0' }), /needs apps\/_shared \^0\.9\.0; this checkout has 1\.0\.0/);
assert.throws(() => requireShared('next', { appsDir: dir, version: '1.0.0' }), /needs apps\/_shared \^2\.0\.0/);
assert.throws(() => require('../release').toolsRelease('no-such-app', require), /declares no "openvibeToolsShared" range/, 'toolsRelease refuses an undeclared app before anything else');
fs.rmSync(dir, { recursive: true, force: true });

// deploy.sh walks apps/*/ to install, resolve and preflight each app; _shared has a package.json now
// but is not an app (2026-09-26: the guard preflight tried to load better-sqlite3 from it and aborted).
const deploy = fs.readFileSync(path.join(APPS, '..', 'deploy', 'scripts', 'deploy.sh'), 'utf8');
const loops = deploy.split('\n').map((l, i, all) => [l, all[i + 1] || '']).filter(([l]) => /^for app in apps\/\*\/; do/.test(l));
assert.ok(loops.length >= 3, 'deploy.sh has its app loops');
for (const [, next] of loops) assert.match(next, /case "\$app" in apps\/_\*\) continue ;; esac/, 'each app loop in deploy.sh skips apps/_*');

console.log('_shared version: all checks passed');
