'use strict';
// The maps page renders OpenStreetMap names, descriptions, fees, amenities and coordinates into
// innerHTML. Every such value must be escaped and every href limited to http(s) — the high finding:
// an OSM name with an onerror handler ran under the page's unsafe-inline CSP and could read the
// zone-wide ov_token cookie. This checks the helper the fix added behaves, and that no flagged field
// is interpolated raw into markup. node apps/maps/test/frontend-escape.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
const escDef = src.match(/const esc = v => [^\n]+;/);
const urlDef = src.match(/function httpUrl\(u\) \{[\s\S]*?\n  \}/);
assert.ok(escDef, 'an HTML-escape helper is defined');
assert.ok(urlDef, 'a http(s)-only URL helper is defined');

const { esc, httpUrl } = vm.runInNewContext(`${escDef[0]}\n${urlDef[0]}\n({ esc, httpUrl })`, { URL, location: { origin: 'https://maps.openvibe.tools' } });
assert.strictEqual(esc('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;', 'markup is escaped');
assert.strictEqual(esc('a"b\'c&d'), 'a&quot;b&#39;c&amp;d', 'quotes and ampersands are escaped');
assert.strictEqual(httpUrl('javascript:alert(1)'), '', 'javascript: is not a URL');
assert.strictEqual(httpUrl('data:text/html,<script>'), '', 'data: is not a URL');
assert.strictEqual(httpUrl('https://example.org/x'), 'https://example.org/x', 'https is kept');

// None of the OSM-derived fields the review flagged is interpolated raw into a template any more.
for (const raw of [
    "${loc.name||'Unknown'}", "${loc.type||'Unknown'}", "${loc.source||", '${loc._id}',
    '${loc.description}', '${truncate(loc.description,100)}', '${loc.fee}', '${a}',
    "${b.name||", '${b.address}', "${s.name||", '${s.address}',
]) {
    assert.ok(!src.includes(raw), `raw interpolation must be escaped: ${raw}`);
}
assert.ok(src.includes('${esc(loc.name'), 'the result card escapes the name');
assert.ok(src.includes('${esc(loc.description)'), 'the detail panel escapes the description');
assert.ok(src.includes('${esc(a)}'), 'amenities are escaped');

console.log('maps front end escapes OSM data (XSS): all checks passed');
