'use strict';
/** tools.usage: page views and runs by signed-in people become their recent tools in the Network module, merged, deduplicated and capped. */
const assert = require('assert');
const { createRecorder, usagePages } = require('../usage');

const USR = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
const modules = new Map();   // subject -> { data, revision }
let conflictOnce = false;
const calls = [];
const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    const reply = (status, body) => ({ status, ok: status < 300, json: async () => body });
    if (u.pathname === '/oauth/token') { calls.push('token'); return reply(200, { access_token: 'svc', expires_in: 300 }); }
    assert.strictEqual(opts.headers.Authorization, 'Bearer svc');
    const m = u.pathname.match(/^\/internal\/modules\/tools\.usage\/(usr_[0-9A-Z]+)$/);
    assert.ok(m, u.pathname);
    calls.push(`${opts.method}`);
    const rec = modules.get(m[1]);
    if (opts.method === 'GET') return rec ? reply(200, { namespace: 'tools.usage', ...rec }) : reply(404, { code: 'modules.not_found' });
    const want = opts.headers['If-Match'];
    if (conflictOnce) { conflictOnce = false; modules.set(m[1], { data: { recent: [{ tool: 'png', at: '2026-09-24T00:00:00.000Z' }] }, revision: 7 }); return reply(412, { code: 'modules.revision_mismatch' }); }
    if (rec && want !== `"${rec.revision}"`) return reply(412, { code: 'modules.revision_mismatch' });
    const data = JSON.parse(opts.body).data;
    modules.set(m[1], { data, revision: rec ? rec.revision + 1 : 1 });
    return reply(rec ? 200 : 201, { data });
};

(async () => {
    let t = Date.parse('2026-09-24T01:00:00Z');
    const r = createRecorder({ env: { OV_OAUTH_CLIENT_SECRET: 'x'.repeat(40), OV_NETWORK_INTERNAL_URL: 'http://network.test' }, fetchImpl, now: () => t, flushMs: 3_600_000 });
    assert.ok(r.record(USR, 'yaml'));
    assert.ok(!r.record(USR, 'yaml'), 'the same tool again within 10 minutes is not news');
    assert.ok(!r.record('42', 'yaml'), 'only a Network subject counts');
    assert.ok(!r.record(USR, '../etc'), 'only a tool id');
    t += 1000; r.record(USR, 'uuid');
    await r.flush();
    assert.deepStrictEqual(modules.get(USR).data.recent.map((e) => e.tool), ['uuid', 'yaml'], 'newest first');
    assert.strictEqual(calls.filter((c) => c === 'token').length, 1);

    t += 11 * 60 * 1000; r.record(USR, 'yaml');
    conflictOnce = true;
    await r.flush();
    assert.strictEqual(r.stats().conflicts, 1);
    assert.strictEqual(r.stats().pending, 1, 'a conflicting write stays pending');
    await r.flush();
    assert.deepStrictEqual(modules.get(USR).data.recent.map((e) => e.tool), ['yaml', 'png'], 'merged with what another writer put there');

    for (let i = 0; i < 40; i++) { t += 1000; r.record(USR, `tool${i}`); }
    await r.flush();
    assert.strictEqual(modules.get(USR).data.recent.length, 30, 'capped at the namespace limit');
    assert.strictEqual(modules.get(USR).data.recent[0].tool, 'tool39');

    // Favourites (tools.usage v2): starred newest first, kept by every recent-tools write, unstarred.
    assert.deepStrictEqual(await r.setFavorite(USR, 'yaml', true), ['yaml']);
    assert.deepStrictEqual(await r.setFavorite(USR, 'uuid', true), ['uuid', 'yaml']);
    assert.deepStrictEqual(await r.setFavorite(USR, 'uuid', true), ['uuid', 'yaml'], 'starring twice changes nothing');
    const revBefore = modules.get(USR).revision;
    await r.setFavorite(USR, 'png', false);
    assert.strictEqual(modules.get(USR).revision, revBefore, 'unstarring a tool that is not starred writes nothing');
    t += 11 * 60 * 1000; r.record(USR, 'base64');
    await r.flush();
    assert.strictEqual(modules.get(USR).data.recent[0].tool, 'base64');
    assert.deepStrictEqual(modules.get(USR).data.favorites, ['uuid', 'yaml'], 'a recent-tools write keeps the favourites');
    conflictOnce = true;
    await assert.doesNotReject(r.setFavorite(USR, 'md5', true), 'a moved revision is read again');
    assert.deepStrictEqual(await r.favorites(USR), ['md5'], 'after the conflict: starred on top of what the other writer left');
    assert.deepStrictEqual(await r.setFavorite(USR, 'md5', false), []);
    await assert.rejects(r.setFavorite(USR, '../x', true), /bad subject or tool/);

    // The page middleware: a signed-in document request for a tool host counts; assets, APIs and unknown hosts do not.
    const got = [];
    const mw = usagePages({ snapshot: () => ({ tools: [{ id: 'jsonminify', hosts: ['json-minifier.openvibe.tools', 'jsonminify.openvibe.tools'] }] }), rec: { enabled: true, record: (s, id) => got.push(id) } });
    const req = (host, p, headers = {}, user = { subject_id: USR }) => ({ method: 'GET', hostname: host, path: p, user, headers, get: (h) => headers[h.toLowerCase()] });
    const cookies = [];
    const run = (q) => mw(q, { append: (k, v) => { assert.strictEqual(k, 'Set-Cookie'); cookies.push(v); } }, () => {});
    run(req('json-minifier.openvibe.tools', '/', { 'sec-fetch-dest': 'document' }));
    run(req('jsonminify.openvibe.tools', '/', { accept: 'text/html' }));
    run(req('json-minifier.openvibe.tools', '/app.js', { 'sec-fetch-dest': 'script' }));
    run(req('json-minifier.openvibe.tools', '/api/x', { accept: 'text/html' }));
    run(req('openvibe.tools', '/', { 'sec-fetch-dest': 'document', 'x-ov-tool': 'evil' }));
    assert.deepStrictEqual(got, ['jsonminify', 'jsonminify']);

    // Anonymous history: no account write, but the browser's cookie list gets the tool on top.
    cookies.length = 0;
    run(req('json-minifier.openvibe.tools', '/', { 'sec-fetch-dest': 'document', cookie: 'a=1; ov_recent_tools=png.jsonminify.yaml; b=2' }, null));
    assert.deepStrictEqual(got, ['jsonminify', 'jsonminify'], 'nobody signed in: no module write');
    assert.strictEqual(cookies.length, 1);
    assert.ok(cookies[0].startsWith('ov_recent_tools=jsonminify.png.yaml;'), cookies[0]);
    assert.ok(/Domain=\.openvibe\.tools/.test(cookies[0]) && /Secure/.test(cookies[0]) && /SameSite=Lax/.test(cookies[0]));
    const { recentFromCookie } = require('../usage');
    assert.deepStrictEqual(recentFromCookie({ headers: { cookie: 'ov_recent_tools=a-b.x..<script>.a-b' } }), ['a-b', 'x'], 'only tool ids, deduplicated');
    cookies.length = 0;
    const mirror = usagePages({ snapshot: () => ({ tools: [{ id: 'yaml', hosts: ['yaml.example.org'] }] }), rec: { enabled: false } });
    mirror(req('yaml.example.org', '/', { 'sec-fetch-dest': 'document' }, null), { append: (k, v) => cookies.push(v) }, () => {});
    assert.strictEqual(cookies.length, 0, 'no zone cookie from a custom domain');

    // Guest conversion (WS-B task 8): the guest's tools join the account once per account and browser.
    const { mergeGuestTools, MERGED_COOKIE } = require('../usage');
    const recorded = [];
    const fake = { enabled: true, record: (s, tool) => { recorded.push([s, tool]); return true; } };
    const set = [];
    const resOf = () => ({ append: (k, v) => set.push(v) });
    let added = mergeGuestTools({ headers: { cookie: 'ov_recent_tools=png.yaml.jsonminify' } }, resOf(), USR, [{ tool: 'yaml' }], ['png', 'yaml', 'jsonminify'], fake);
    assert.deepStrictEqual(added, ['png', 'jsonminify'], 'only what the account lacks, newest first');
    assert.deepStrictEqual(recorded, [[USR, 'jsonminify'], [USR, 'png']], 'recorded oldest first so the newest ends on top');
    assert.ok(set[0].startsWith(`${MERGED_COOKIE}=${USR};`) && /HttpOnly/.test(set[0]) && /Domain=\.openvibe\.tools/.test(set[0]));
    added = mergeGuestTools({ headers: { cookie: `ov_recent_tools=png; ${MERGED_COOKIE}=${USR}` } }, resOf(), USR, [], ['png'], fake);
    assert.deepStrictEqual(added, [], 'merged once per account and browser');
    assert.deepStrictEqual(mergeGuestTools({ headers: { cookie: `${MERGED_COOKIE}=${USR}` } }, resOf(), 'usr_01JAB2C3D4E5F6G7H8J9K0OTHR', [], ['png'], fake), ['png'], 'another account on the same browser gets them too');
    assert.deepStrictEqual(mergeGuestTools({ headers: {} }, resOf(), USR, [], [], fake), [], 'nothing to merge');
    assert.deepStrictEqual(mergeGuestTools({ headers: {} }, resOf(), USR, [], ['png'], { enabled: false }), [], 'recorder off');

    // Anonymous favourites (WS-L task 1): a browser's stars live in ov_tool_favs on the tools zone; at
    // sign-in they join the account's after its own, once, and the cookie is cleared.
    {
        const { favoritesFromCookie, setCookieFavorite, mergeGuestFavorites, FAV_COOKIE } = require('../usage');
        assert.deepStrictEqual(favoritesFromCookie({ headers: { cookie: `${FAV_COOKIE}=png.x..<b>.png.yaml` } }), ['png', 'x', 'yaml'], 'only tool ids, deduplicated');
        const out = [];
        const res2 = { append: (k, v) => out.push(v) };
        assert.deepStrictEqual(setCookieFavorite({ headers: { cookie: `${FAV_COOKIE}=yaml` } }, res2, 'png', true, 'openvibe.tools'), ['png', 'yaml'], 'newest first');
        assert.match(out[0], /^ov_tool_favs=png\.yaml; Domain=\.openvibe\.tools; Path=\/; Max-Age=31536000; SameSite=Lax; Secure$/);
        assert.deepStrictEqual(setCookieFavorite({ headers: { cookie: `${FAV_COOKIE}=png.yaml` } }, res2, 'png', false, '127.0.0.1'), ['yaml']);
        assert.doesNotMatch(out[1], /Domain=/, 'a host-only cookie off the tools zone');
        assert.match(setCookieFavorite({ headers: { cookie: `${FAV_COOKIE}=png` } }, res2, 'png', false, 'png.openvibe.tools') && out[2], /^ov_tool_favs=; Domain=\.openvibe\.tools; Path=\/; Max-Age=0/, 'the last unstar clears it');
        const many = Array.from({ length: 30 }, (_, i) => `t${i}`);
        assert.strictEqual(setCookieFavorite({ headers: { cookie: `${FAV_COOKIE}=${many.join('.')}` } }, res2, 'new', true, 'openvibe.tools').length, 24, 'at most 24');

        await r.setFavorite(USR, 'uuid', true);
        out.length = 0;
        const merged = await mergeGuestFavorites({ headers: { cookie: `${FAV_COOKIE}=png.uuid.yaml` } }, res2, USR, 'openvibe.tools', r);
        assert.deepStrictEqual(merged, ['uuid', 'png', 'yaml'], "the guest's stars join after the account's own, without duplicates");
        assert.deepStrictEqual(modules.get(USR).data.favorites, ['uuid', 'png', 'yaml']);
        assert.match(out[0], /^ov_tool_favs=; .*Max-Age=0/, 'and the cookie is cleared');
        assert.strictEqual(await mergeGuestFavorites({ headers: {} }, res2, USR, 'openvibe.tools', r), null, 'nothing to merge');
        assert.strictEqual(await mergeGuestFavorites({ headers: { cookie: `${FAV_COOKIE}=png` } }, res2, USR, 'openvibe.tools', { enabled: false }), null, 'recorder off: the cookie stays');
        for (const id of ['uuid', 'png', 'yaml']) await r.setFavorite(USR, id, false);
    }

    const off = createRecorder({ env: {}, fetchImpl });
    assert.strictEqual(off.enabled, false);
    assert.strictEqual(off.record(USR, 'yaml'), false, 'off without a service secret');
    r.stop();
    console.log('tools usage: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
