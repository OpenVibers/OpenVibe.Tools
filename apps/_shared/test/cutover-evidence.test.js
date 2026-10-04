'use strict';
// The T8 closeout record must exist and keep its checks, and the README must no longer say the cutover is
// pending (plan T8; a silent re-draft would lose the evidence). This fails loudly if either regresses.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const doc = path.join(ROOT, 'docs', 'cutover-evidence-t8.md');
const readme = path.join(ROOT, 'README.md');

assert.ok(fs.existsSync(doc), 'docs/cutover-evidence-t8.md is missing');
const md = fs.readFileSync(doc, 'utf8');
for (const key of ['health tools', 'origin/main HEAD', 'env', 'Valkey ACL', 'Row parity', 'Reproduce']) {
    assert.ok(md.includes(key), `docs/cutover-evidence-t8.md is missing "${key}"`);
}

assert.ok(fs.existsSync(readme), 'README.md is missing');
const readmeText = fs.readFileSync(readme, 'utf8');
assert.ok(!readmeText.includes('the cutover is pending'), 'README.md still contains "the cutover is pending"');

console.log('cutover evidence exists, records its checks, and the README no longer says the cutover is pending: passed');
