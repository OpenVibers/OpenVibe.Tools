'use strict';
const assert = require('assert');
const registry = require('../server/registry');
const site = require('../server/pages/site');

const c = registry.catalog();
assert.ok(c.tools.length > 100 && c.families.length >= 8, 'catalog is populated');
assert.equal(new Set(c.tools.map(t => t.id)).size, c.tools.length, 'tool ids are unique');
for (const t of c.tools) { assert.ok(t.name && t.tagline && t.description && t.icon && t.hosts.canonical, `complete record: ${t.id}`); assert.ok(!/\b(free|\$0|no ads|ad-free)\b/i.test(t.tagline), `no cost claims: ${t.id}`); }

const r = (h) => registry.resolveHost(h);
assert.equal(r('openvibe.tools').kind, 'apex');
assert.equal(r('www.openvibe.tools').kind, 'apex');
assert.deepEqual([r('yt.openvibe.tools').role, r('youtube.openvibe.tools').role, r('youtube-downloader.openvibe.tools').role], ['short', 'alias', 'canonical']);
assert.equal(r('yt.openvibe.tools').port, 4013);
assert.equal(r('poopy.openvibe.tools').kind, 'unknown', 'made-up subdomains are not tools');
assert.equal(r('poopy.openvibe.tools').inZone, true);
assert.equal(r('evil.example').inZone, false);

// Owner overrides: a custom domain becomes canonical, the old canonical keeps working as an alias.
registry.setOverrides([{ tool_id: 'yt', host: 'youtubedownloadonline.com', role: 'canonical' }, { tool_id: 'nope', host: 'x.com', role: 'alias' }, { tool_id: 'yt', host: 'openvibe.tools', role: 'alias' }, { tool_id: 'yt', host: 'bad host', role: 'alias' }]);
const yt = registry.catalog().tools.find(t => t.id === 'yt');
assert.equal(yt.hosts.canonical, 'youtubedownloadonline.com');
assert.ok(yt.hosts.aliases.includes('youtube-downloader.openvibe.tools'));
assert.equal(r('youtubedownloadonline.com').role, 'canonical');
assert.equal(r('x.com').kind, 'unknown', 'override for an unknown tool is ignored');
assert.equal(r('openvibe.tools').kind, 'apex', 'the apex cannot be claimed');
assert.ok(site.sitemapEntries().some(u => u.loc === 'https://youtubedownloadonline.com/'), 'sitemap uses the canonical host');
assert.ok(!site.sitemapEntries().some(u => u.loc === 'https://yt.openvibe.tools/'), 'short hosts stay out of the sitemap');
registry.setOverrides([]);
assert.equal(registry.catalog().tools.find(t => t.id === 'yt').hosts.canonical, 'youtube-downloader.openvibe.tools');

assert.equal(site.search('merge pdf')[0].id, 'mergepdf');
assert.equal(site.search('youtube to mp3')[0].id, 'yt');
assert.deepEqual(site.search(''), []);
console.log('registry + site: all checks passed');
