'use strict';
// No app defaults its LISTEN address to 0.0.0.0 (all interfaces): nginx reaches every app on
// 127.0.0.1, so an open host firewall must not expose an app directly and skip nginx's rate limits.
// (The finding: maps and text — and the gateway — defaulted to 0.0.0.0.) node apps/_shared/test/bind-loopback.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const APPS = path.join(__dirname, '..', '..');
let checked = 0;
for (const app of fs.readdirSync(APPS)) {
    const file = path.join(APPS, app, 'server', 'config.js');
    if (!fs.existsSync(file)) continue;
    checked++;
    const src = fs.readFileSync(file, 'utf8');
    assert.ok(!/process\.env\.HOST\s*\|\|\s*'0\.0\.0\.0'/.test(src), `${app}/server/config.js must not default to 0.0.0.0`);
}
assert.ok(checked >= 7, `every app's config checked (${checked})`);
console.log(`every app binds loopback by default (${checked} configs): all checks passed`);
