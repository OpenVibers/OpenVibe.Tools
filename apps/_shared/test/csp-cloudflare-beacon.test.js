'use strict';
/**
 * Every app's Content-Security-Policy lets Cloudflare's analytics beacon load and report (11-07): the text, image,
 * audio, docs and food apps refused static.cloudflareinsights.com, so every page on their own hosts
 * (case.openvibe.tools and the rest) logged a CSP error, found by the browser sweep of every site's inner pages.
 *   node apps/_shared/test/csp-cloudflare-beacon.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const APPS = path.join(__dirname, '..', '..');
const apps = fs.readdirSync(APPS).filter((a) => fs.existsSync(path.join(APPS, a, 'server', 'index.js')));
let checked = 0;
apps.forEach((a) => {
    const src = fs.readFileSync(path.join(APPS, a, 'server', 'index.js'), 'utf8');
    const script = src.match(/scriptSrc:\s*\[([^\]\n]*)\]/);
    if (!script) return;   // an app that sets no CSP of its own
    checked++;
    assert.ok(/static\.cloudflareinsights\.com/.test(script[1]), `${a}: scriptSrc allows Cloudflare's beacon`);
    const connect = src.match(/connectSrc:\s*\[([^\]\n]*)\]/);
    if (connect) assert.ok(/cloudflareinsights\.com/.test(connect[1]), `${a}: connectSrc lets the beacon report`);
});
assert.ok(checked >= 5, `found the apps' CSPs (${checked})`);
console.log(`csp cloudflare beacon: ${checked} apps let the beacon load and report`);
