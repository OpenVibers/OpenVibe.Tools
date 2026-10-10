'use strict';
// Every proxied location of a satellite vhost drops a client-supplied X-OV-* header, so only the
// gateway (which reaches the satellite directly over loopback, never through nginx) can set one.
// Guards the open-redirect and canonical/og:url poisoning fix (apps/_shared/host-role.js is the app-side
// second line of defence; this is the nginx one). node apps/_shared/test/nginx-xov.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const APPS = path.join(__dirname, '..', '..');
const HEADERS = ['X-OV-Tool', 'X-OV-Host-Role', 'X-OV-Canonical-Host', 'X-OV-Short-Host'];
let locations = 0;

for (const app of fs.readdirSync(APPS)) {
    if (app === 'gateway') continue;   // the gateway strips inbound X-OV-* itself (registry/host-middleware.js)
    const dir = path.join(APPS, app, 'deploy', 'nginx');
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.conf'))) {
        const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n');
        lines.forEach((line, i) => {
            if (!/^\s*proxy_set_header Host \$host;$/.test(line)) return;
            locations++;
            const block = lines.slice(i, i + 7).join('\n');
            for (const h of HEADERS) {
                assert.ok(block.includes(`proxy_set_header ${h} "";`), `${app}/${file}: the proxied location at line ${i + 1} clears ${h}`);
            }
        });
    }
}

assert.ok(locations >= 16, `every satellite proxy location checked (${locations})`);
console.log(`nginx satellite vhosts clear client X-OV-* (${locations} proxied locations): all checks passed`);
