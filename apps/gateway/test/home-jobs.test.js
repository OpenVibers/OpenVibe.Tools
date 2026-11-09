'use strict';
const assert = require('assert');
const site = require('../server/pages/site');
const registry = require('../server/registry');
const html = site.pageIndex();
const { tools, families } = registry.get();
for (const f of families) {
    const list = tools.filter(t => t.family === f.id);
    if (!list.length) continue;
    const block = html.split(`id="job-${f.id}"`)[1].split('</section>')[0];
    assert.ok(block.includes(`<h2 id="job-${f.id}-h">`), f.id + ' has a real heading');
    for (const t of list) assert.ok(block.includes(`href="${t.url.replace(/&/g, '&amp;')}"`), t.id + ' is one click from home');
}
const scripts = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].flatMap(m => { const v = JSON.parse(m[1]); return Array.isArray(v) ? v : [v]; });
const lists = scripts.filter(s => s['@type'] === 'ItemList');
assert.equal(lists.length, families.length);
assert.equal(lists.reduce((sum,l) => sum + l.itemListElement.length, 0), tools.length);
assert.match(html, /data-ovk-scroll="drift"/);
assert.match(html, /Ask Vibe which tool/);
assert.match(html.split('<h2>Most popular</h2>')[1].split('</section>')[0], /Usage is temporarily unavailable/);
console.log('home categories: all tools and category JSON-LD passed');
