'use strict';
/**
 * The gateway's outbound requests go where they are meant to (roadmap WS-R task 5, the SSRF class).
 * net-ssrf.test.js and net-family.test.js drive every tool that connects to a host a visitor chose
 * through the egress guard; this suite adds what they do not:
 *
 *   - the guard's address rule IS openvibe-shared/egress's (the rule Live, Events, Chat and Sources
 *     use), not a copy that can drift (Media's and Sources' copies had);
 *   - the paste proxy (/api/pastes/* → OpenVibe.Community) forwards only to Community's paste API:
 *     "/api/pastes/../../internal/x", its %2e%2e form and encoded slashes resolved to other Community
 *     routes, with the visitor's token (the same hole Community's own Live proxy had);
 *   - a ratchet: every file under apps/ that makes an outbound request itself is on a reviewed list
 *     with where it goes; a new one fails until it uses the egress guard or is reviewed here.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { startApp } = require('../../_shared/test/spawn');

const APPS = path.join(__dirname, '..', '..');
let failures = 0;
const check = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failures++; console.log(`  ✗ ${name}\n    ${String(e.stack || e.message).split('\n').slice(0, 8).join('\n    ')}`); } };

/** A raw request line: the path goes out exactly as written (no client-side dot-segment removal). */
function rawGet(port, p, headers = {}) {
    return new Promise((resolve) => {
        const s = net.connect(port, '127.0.0.1', () => s.write(`GET ${p} HTTP/1.1\r\nHost: tools.test\r\nConnection: close\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`));
        let data = '';
        s.on('data', (c) => { data += c; });
        s.on('end', () => resolve(data));
        s.on('error', () => resolve(data));
        setTimeout(() => { s.destroy(); resolve(data); }, 5000);
    });
}

(async () => {
    await check('the egress guard\'s address rule is openvibe-shared/egress\'s own', () => {
        const guard = require('../../_shared/egress');
        const shared = require(require.resolve('openvibe-shared/egress', { paths: [path.join(APPS, 'gateway')] }));
        assert.strictEqual(guard.isPublicAddress, shared.isPublicAddress);
    });

    // A stand-in Community that records every path it is asked for.
    const seen = [];
    const community = http.createServer((req, res) => { seen.push(req.url); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ path: req.url, secret: req.url.startsWith('/api/pastes') ? null : 'internal-route-reached' })); });
    await new Promise((r) => community.listen(0, '127.0.0.1', r));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-sec-'));
    const gw = await startApp('gateway', { DATA_DIR: tmp, OV_COMMUNITY_INTERNAL_URL: `http://127.0.0.1:${community.address().port}`, OV_DOMAINS_URL: 'http://127.0.0.1:9/api/domains', OV_REGISTRY_URL: 'http://127.0.0.1:9/registry' });
    const port = Number(new URL(gw.base).port);
    try {
        await check('the paste proxy forwards paste API paths (control)', async () => {
            const r = await rawGet(port, '/api/pastes/recent?limit=5', { 'X-Forwarded-For': '198.18.0.1' });
            assert.match(r, /^HTTP\/1\.1 200/, r.slice(0, 200));
            assert.ok(seen.includes('/api/pastes/recent?limit=5'), seen.join(', '));
        });
        await check('the paste proxy never reaches another Community route (dot segments, %2e%2e, encoded slashes, backslashes)', async () => {
            let n = 0;
            for (const p of ['/api/pastes/../../internal/x', '/api/pastes/%2e%2e/%2e%2e/internal/x', '/api/pastes/%2E%2E/%2E%2E/internal/x', '/api/pastes/.%2e/.%2e/internal/x',
                '/api/pastes/..%2f..%2finternal%2fx', '/api/pastes/..%5c..%5cinternal%5cx', '/api/pastes/x/%2e%2e/%2e%2e/%2e%2e/api/v1/admin']) {
                const r = await rawGet(port, p, { 'X-Forwarded-For': `198.18.1.${++n}` });
                assert.ok(!r.includes('internal-route-reached'), `${p}: ${r.slice(0, 160)}`);
            }
            const outside = seen.filter((u) => !u.startsWith('/api/pastes'));
            assert.deepStrictEqual(outside, [], 'Community was asked for a path outside its paste API');
            assert.ok(!seen.some((u) => /%2f|%5c/i.test(u)), `an encoded separator reached Community: ${seen.join(', ')}`);
        });
    } finally {
        gw.kill('SIGTERM');
        await gw.exited;
        community.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }

    await check('ratchet: every file that makes an outbound request itself is reviewed', () => {
        const REVIEWED = {
            'gateway/server/auth/routes.js': 'Network JWKS, OAuth token and revoke (configured)',
            'gateway/server/index.js': 'OpenVibe.Community paste API (configured; paths held to /api/pastes) and the satellites on loopback',
            'gateway/server/net/routes.js': 'visitor-chosen hosts, through the egress guard',
            'gateway/server/registry/descriptors.js': 'the satellites on loopback',
            'gateway/server/registry/host-middleware.js': 'the satellites on loopback (fixed ports)',
            'gateway/server/registry/index.js': 'the satellites on loopback',
            'gateway/server/registry/services.js': 'Network registry (configured)',
            'gateway/server/revocation-events.js': 'OpenVibe.Events (configured)',
            'gateway/server/run/jobs-facade.js': 'the satellites on loopback',
            'gateway/server/search-index.js': 'OpenVibe.Search (configured)',
            'food/server/index.js': 'the maps satellite (configured; fixed paths, only the query string is the visitor\'s)',
            'maps/server/index.js': 'fixed third-party map, weather and geocoding hosts',
            'maps/server/sources/bathrooms.js': 'fixed third-party host', 'maps/server/sources/bridges.js': 'fixed third-party host',
            'maps/server/sources/freecampsites.js': 'fixed third-party host', 'maps/server/sources/grocery.js': 'fixed third-party host',
            'maps/server/sources/ioverlander.js': 'fixed third-party host', 'maps/server/sources/nps.js': 'fixed third-party host (NPS)',
            'maps/server/sources/openchargemap.js': 'fixed third-party host (OpenChargeMap)', 'maps/server/sources/overpass.js': 'fixed third-party host (Overpass)',
            'maps/server/sources/resources.js': 'fixed third-party host', 'maps/server/sources/ridb.js': 'fixed third-party host (RIDB)',
            'maps/server/sources/scraper.js': 'fixed third-party hosts', 'maps/server/sources/terrain.js': 'fixed third-party host',
            'maps/server/sources/usfs.js': 'fixed third-party host', 'maps/server/sources/utils.js': 'fixed third-party host (Overpass)',
            'maps/server/sources/weather.js': 'fixed third-party host',
            '_shared/guard/tokens.js': 'Network JWKS / token endpoint (configured)',
            '_shared/jobs/client.js': 'the satellites on loopback', '_shared/jobs/http.js': 'the satellites on loopback',
            '_shared/jobs/index.js': 'OpenVibe.Events (configured)', '_shared/jobs/media.js': 'OpenVibe.Media (configured)',
            '_shared/observe.js': 'the satellites on loopback', '_shared/tools/proxy.js': 'the satellites on loopback',
            '_shared/tools/run.js': 'the satellites on loopback', '_shared/usage.js': 'Network user modules (configured)',
            '_shared/egress.js': 'the egress guard itself',
        };
        const found = [];
        const walk = (dir) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                if (e.name === 'node_modules' || e.name === 'test' || e.name === 'public' || e.name === 'data') continue;
                const f = path.join(dir, e.name);
                if (e.isDirectory()) walk(f);
                else if (e.name.endsWith('.js')) {
                    const src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
                    if (/(^|[^.\w])(fetch|fetchImpl)\(|\bhttps?\.(get|post|request)\(|\bmod\.(get|request)\(|new WebSocket\(|require\(['"](axios|got|node-fetch|undici)['"]\)/m.test(src)) found.push(path.relative(APPS, f));
                }
            }
        };
        for (const app of fs.readdirSync(APPS)) {
            if (app === '_shared') { for (const e of fs.readdirSync(path.join(APPS, '_shared'), { withFileTypes: true })) { if (e.isFile() && e.name.endsWith('.js')) { const f = path.join(APPS, '_shared', e.name); const src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1'); if (/(^|[^.\w])(fetch|fetchImpl)\(|\bhttps?\.(get|post|request)\(|\bmod\.(get|request)\(|new WebSocket\(|require\(['"](axios|got|node-fetch|undici)['"]\)/m.test(src)) found.push(path.relative(APPS, f)); } else if (e.isDirectory() && !['node_modules', 'test'].includes(e.name)) walk(path.join(APPS, '_shared', e.name)); } continue; }
            if (fs.existsSync(path.join(APPS, app, 'server'))) walk(path.join(APPS, app, 'server'));
        }
        assert.ok(found.length >= 20, `the scan finds the known sites (${found.length})`);
        assert.deepStrictEqual(found.filter((f) => !REVIEWED[f]).sort(), [], 'a new outbound request site: a visitor-chosen host goes through apps/_shared/egress.js; then add the file here with where it goes');
    });

    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
    console.log('\ngateway security-ssrf: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
