'use strict';
// No Google Fonts (the owner, 2026-11-12: "make sure no remnants of font awesome or other libraries are still being
// used rather than our openvibe.design systems"). Every app draws with the house stack — Inter/system-ui for text and
// ui-monospace for code — and no page, stylesheet or script asks fonts.googleapis.com or fonts.gstatic.com for a face.
//   node test/no-google-fonts.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const walk = (dir, ok, out = []) => {
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'vendor' || e.name === 'data' || e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, ok, out); else if (ok.test(e.name)) out.push(p);
    }
    return out;
};
const rel = (p) => path.relative(ROOT, p);
const GOOGLE_FONTS = /fonts\.(?:googleapis|gstatic)\.com/;

const apps = path.join(ROOT, 'apps');
const pages = walk(apps, /\.html$/);
const styles = walk(apps, /\.css$/);
const scripts = walk(apps, /\.js$/);

for (const p of pages) {
    assert.ok(!GOOGLE_FONTS.test(fs.readFileSync(p, 'utf8')), `${rel(p)} links Google Fonts`);
}
for (const p of styles) {
    assert.ok(!GOOGLE_FONTS.test(fs.readFileSync(p, 'utf8')), `${rel(p)} imports Google Fonts`);
}
for (const p of scripts) {
    assert.ok(!GOOGLE_FONTS.test(fs.readFileSync(p, 'utf8')), `${rel(p)} requests Google Fonts`);
}

console.log(`no google fonts: ${pages.length} pages, ${styles.length} stylesheets, ${scripts.length} scripts clean`);
