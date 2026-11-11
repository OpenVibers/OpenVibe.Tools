'use strict';
// /workers (its look 2026-11-11): one h1, the facts as chips, three steps in the order a person takes them (Check,
// Install, Turn on), the check command with a Copy button, and a HowTo for search and AI readers whose steps are the
// page's own.
const assert = require('assert');
const { pageWorkers } = require('../server/pages/site');

const html = pageWorkers();
assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, 'one h1');
assert.match(html, /<h1>Run Tools on your own machine<\/h1>/);
const chips = [...html.matchAll(/<li><svg[^]*?<\/svg>([^<]+)<\/li>/g)].map((m) => m[1]);
assert.deepEqual(chips, ['Outbound only', '16 MiB in, 16 MiB out', 'Two jobs at once', '2 CPU cores, 2 GiB', 'Updates itself daily'], 'the facts as chips');
const steps = [...html.matchAll(/<li class="wk-step[^"]*"><h2>([^<]+)<\/h2>/g)].map((m) => m[1]);
assert.deepEqual(steps, ['Check', 'Install', 'Turn on'], 'three steps, in order');
assert.match(html, /<code id="wk-check">bash install\.sh --dry-run --prefix \/tmp\/tools-worker-check-new<\/code><button type="button" class="wk-copy" data-wk-copy="wk-check"/, 'the command, with Copy');
assert.match(html, /href="\/worker\/install\.sh"/, 'the installer');
assert.match(html, /href="\/developers#worker-routing"/, 'the API routing link');
const blocks = [...html.matchAll(/<script type="application\/ld\+json">([^<]+)<\/script>/g)].map((m) => JSON.parse(m[1]));
const howTo = blocks.flat().find((b) => b && b['@type'] === 'HowTo');
assert.ok(howTo, 'a HowTo');
assert.deepEqual(howTo.step.map((s) => s.name), steps, "the HowTo's steps are the page's");
console.log('workers page: one h1, five facts, Check → Install → Turn on, the command with Copy, a HowTo with the same steps');
