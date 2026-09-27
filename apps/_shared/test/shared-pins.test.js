'use strict';
// D42 (roadmap WS-P task 4): Tools pages load the shared browser files (navbar, footer, theme loader, bell…) from
// their own app's pin at /shared (mounted by apps/_shared/release.js), never from openvibe.network, and only files
// that pin serves. A page that still pointed at openvibe.network would run whatever Network pins, and lose its frame
// while Network is down.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const APPS = path.join(__dirname, '..', '..');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(path.join(dir, e.name))) : [path.join(dir, e.name)]));
let pages = 0; let refs = 0;
for (const app of fs.readdirSync(APPS).filter((a) => !a.startsWith('_') && fs.existsSync(path.join(APPS, a, 'public')))) {
    let files = null;
    try { files = createRequire(path.join(APPS, app, 'server', 'index.js'))('openvibe-shared/files'); } catch { files = require('openvibe-shared/files'); }
    for (const f of walk(path.join(APPS, app, 'public')).filter((x) => /\.(html|js)$/.test(x))) {
        const src = fs.readFileSync(f, 'utf8');
        const rel = path.relative(APPS, f);
        assert.ok(!/https:\/\/openvibe\.network\/shared\/[\w.-]+\.js/.test(src), `${rel} loads a shared file from openvibe.network, not its own /shared`);
        const used = [...src.matchAll(/["'(]\/shared\/([\w.-]+\.js)/g)].map((m) => m[1]);
        if (used.length) pages++;
        for (const name of used) { refs++; assert.ok(files.isBrowserFile(name), `${rel}: /shared/${name} is not a browser file of ${app}'s openvibe-shared`); }
    }
}
assert.ok(pages >= 40 && refs >= 200, `pages ${pages}, references ${refs}`);
console.log(`shared pins: ${pages} pages, ${refs} references, all to their app's own /shared`);
