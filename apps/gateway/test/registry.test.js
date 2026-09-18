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

// People are sent from the canonical host to the short one; crawlers are not.
{
    const { isPersonNavigating } = require('../server/registry/host-middleware');
    const req = (ua, accept, extra) => ({ method: 'GET', headers: Object.assign({ 'user-agent': ua, accept }, extra || {}) });
    const chrome = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
    assert.equal(isPersonNavigating(req(chrome, 'text/html,application/xhtml+xml', { 'sec-fetch-dest': 'document' })), true);
    assert.equal(isPersonNavigating(req('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'text/html')), false);
    assert.equal(isPersonNavigating(req('Mozilla/5.0 AppleWebKit/537.36 (compatible; GPTBot/1.2)', 'text/html')), false);
    assert.equal(isPersonNavigating(req(chrome, 'application/json')), false, 'API calls are never redirected');
    assert.equal(isPersonNavigating(req(chrome, 'text/html', { 'sec-fetch-dest': 'iframe' })), false);
    console.log('short-host redirect rule: ok');
}

// One entry per tool: builds that exist twice are folded, the second host serves as a mirror.
{
    const cat = registry.catalog();
    assert.ok(!cat.tools.some(t => ['jsonfmt', 'md', 'codediff', 'slugify', 'entities'].includes(t.id)), 'folded builds are not listed');
    const names = cat.tools.map(t => t.name); assert.equal(new Set(names).size, names.length, 'no two tools share a name');
    const json = cat.tools.find(t => t.id === 'json');
    assert.deepEqual(json.hosts.mirrors, ['jsonfmt.openvibe.tools']); assert.deepEqual(json.alsoIn, ['dev']);
    const m = registry.resolveHost('jsonfmt.openvibe.tools');
    assert.deepEqual([m.role, m.tool, m.canonicalHost], ['mirror', 'jsonfmt', 'json.openvibe.tools'], 'mirror serves its own build, canonical is the primary');
    assert.ok(!site.sitemapEntries().some(u => u.loc.includes('jsonfmt.')), 'mirrors stay out of the sitemap');
    assert.equal(site.search('json formatter').filter(t => /json formatter/i.test(t.name)).length, 1, 'search shows it once');
    registry.setOverrides([{ tool_id: 'yt', host: 'youtubedownloader.example.com', role: 'mirror' }]);
    const om = registry.resolveHost('youtubedownloader.example.com');
    assert.deepEqual([om.role, om.port, om.canonicalHost], ['mirror', 4013, 'youtube-downloader.openvibe.tools'], 'owner mirrors are served by the tool and canonicalised');
    registry.setOverrides([]);
    console.log('no duplicates, mirrors canonicalised: ok');
}
