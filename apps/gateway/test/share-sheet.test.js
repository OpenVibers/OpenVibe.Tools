'use strict';
// The network's one Share sheet (openvibe-shared 4.114.0): a tool result that has a public link offers the one Share
// button (data-ov-share-sheet) with that link, and Text.OpenVibe's generated text is sent the same way. The old
// device-sheet/copy helpers are gone, so no page carries a second share path.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const net = fs.readFileSync(path.join(__dirname, '..', 'public', 'net.html'), 'utf8');
assert.ok(net.includes("kit.share({ title: o.title || document.title, url: `${location.origin}${location.pathname}?q="), 'a result shares its own public link');
assert.ok(net.includes('small: true'), 'the answer actions keep their size');
assert.ok(!net.includes('data-ovk-share'), 'the old kit menu item is gone');

const zalgo = fs.readFileSync(path.join(__dirname, '..', '..', 'text', 'public', 'zalgo.html'), 'utf8');
assert.ok(zalgo.includes('data-ov-share-sheet'), 'Share is the one button');
assert.ok(zalgo.includes("data-url=\"https://text.openvibe.tools/zalgo.html\""), 'the page address');
assert.ok(zalgo.includes('dataset.text = lastOutput'), 'the generated text goes with it');
assert.ok(!zalgo.includes('OpenVibeUI.shareText'), 'the old device sheet is gone');

const shared = fs.readFileSync(path.join(__dirname, '..', '..', 'text', 'public', 'js', 'shared.js'), 'utf8');
assert.ok(!shared.includes('navigator.share') && !shared.includes('shareText'), 'no second share path in the text suite');

console.log('share sheet ok');
