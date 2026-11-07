'use strict';
// One canonical address per tool: the directory's /tool/<id> is a pointer to the tool's primary host. This starts
// the real gateway (not a router in a test) so the redirect and the Markdown twin are the ones production serves.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startApp } = require('../../_shared/test/spawn');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-tool-canonical-'));

(async () => {
    const gateway = await startApp('gateway', {
        DATABASE_URL: '', DATABASE_DIRECT_URL: '', DATA_DIR: tmp,
        OV_NETWORK_URL: 'http://127.0.0.1:9', OV_NETWORK_INTERNAL_URL: 'http://127.0.0.1:9',
        OV_DOMAINS_URL: 'http://127.0.0.1:9/api/domains', OV_REGISTRY_URL: 'http://127.0.0.1:9/registry',
        TOOLS_SATELLITE_PORTS: 'yt=9,text=9,img=9,audio=9,docs=9,maps=9,food=9',
    });
    try {
        const canonical = 'https://youtube-downloader.openvibe.tools/';

        const get = (p) => fetch(gateway.base + p, { redirect: 'manual' });
        const html = await get('/tool/yt');
        assert.strictEqual(html.status, 301, await html.text());
        assert.strictEqual(html.headers.get('location'), canonical);

        const query = await get('/tool/yt?ref=directory');
        assert.deepStrictEqual([query.status, query.headers.get('location')], [301, `${canonical}?ref=directory`]);

        assert.strictEqual((await get('/tool/not-a-tool')).status, 404, 'unknown ids stay 404');

        const twin = await get('/tool/yt.md');
        const twinText = await twin.text();
        assert.strictEqual(twin.status, 200, twinText);
        assert.match(twin.headers.get('content-type') || '', /^text\/markdown/);
        assert.ok(twinText.includes(`canonical: ${JSON.stringify(canonical)}`), 'the twin names the primary host');

        const map = await get('/sitemap.xml');
        const mapText = await map.text();
        assert.strictEqual(map.status, 200);
        assert.ok(mapText.includes(`<loc>${canonical}</loc>`), 'the primary is listed');
        assert.ok(!mapText.includes('openvibe.tools/tool/'), 'no /tool/ duplicate is listed');
        console.log('tool canonical redirect + sitemap: all checks passed');
    } finally {
        await gateway.kill();
    }
})().catch((err) => { console.error(err); process.exit(1); });
