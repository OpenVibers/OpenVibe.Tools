'use strict';
// ═══════════════════════════════════════════════════════════════
// apps/_shared is a versioned package (roadmap WS-L task 3): apps/_shared/package.json carries its
// version, CHANGELOG.md says what each version changed, and every app declares the range it was
// written against in its own package.json:
//
//   "openvibeToolsShared": "^1.0.0"
//
// The apps still require it by relative path from the same checkout (no install step), so the
// declaration is checked when an app boots: toolsRelease() calls requireShared(app), and an app
// whose range the checked-out _shared does not satisfy refuses to start instead of running against
// a runtime it was not written for. A breaking change to _shared bumps the major and every app's
// range with it, in the same commit, after each app is checked.
//
// Ranges: "^M.m.p" (same major, at least M.m.p; for 0.x the same minor), "~M.m.p" (same minor), or
// an exact "M.m.p".
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const FIELD = 'openvibeToolsShared';
const VERSION = require('./package.json').version;
const APPS = path.join(__dirname, '..');

const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '').trim());
    return m ? m.slice(1).map(Number) : null;
};
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Whether version satisfies range (^, ~ or exact). Anything else is false. */
function satisfies(version, range) {
    const v = parse(version);
    const r = String(range || '').trim();
    const op = r[0] === '^' || r[0] === '~' ? r[0] : '';
    const want = parse(op ? r.slice(1) : r);
    if (!v || !want) return false;
    if (!op) return cmp(v, want) === 0;
    if (cmp(v, want) < 0) return false;
    if (op === '~' || want[0] === 0) return v[0] === want[0] && v[1] === want[1];
    return v[0] === want[0];
}

/** The range an app declares, or null. */
function declared(app, appsDir = APPS) {
    try { return JSON.parse(fs.readFileSync(path.join(appsDir, app, 'package.json'), 'utf8'))[FIELD] || null; } catch { return null; }
}

/** Throws unless the app declares a range this _shared satisfies. Returns { version, range }. */
function requireShared(app, { appsDir = APPS, version = VERSION } = {}) {
    const range = declared(app, appsDir);
    if (!range) throw new Error(`apps/${app}/package.json declares no "${FIELD}" range (apps/_shared is ${version})`);
    if (!satisfies(version, range)) throw new Error(`apps/${app} needs apps/_shared ${range}; this checkout has ${version}`);
    return { version, range };
}

module.exports = { VERSION, FIELD, satisfies, declared, requireShared };
