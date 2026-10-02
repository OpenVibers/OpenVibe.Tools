'use strict';
// Exercise the real server entry points: a router mounted by a test cannot prove a route is gone.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startApp, freePort } = require('../../_shared/test/spawn');

const NET = [
    '/tools', '/myip', '/ip/:target?', '/ipv4/:target?', '/ipv6/:target?',
    '/dns/:target?', '/rdns/:target?', '/rdap/:target?', '/whois/:target?',
    '/ssl/:target?', '/headers/:target?', '/redirects/:target?',
    '/port/:target?', '/ping/:target?', '/lookup/:target?',
    '/robots/:target?', '/sitemap/:target?', '/uptime/:target?',
    '/smtp/:target?', '/blacklist/:target?', '/dnsprop/:target?',
];
const DEV = ['/tools', '/opengraph'];
const PROCESS = ['/api/process', '/api/process/direct', '/api/process/multi', '/api/process/anything', '/api/process/anything/nested'];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-sunset-routes-'));

function declaredRoutes(file, from = 0) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'server', file), 'utf8').slice(from);
    return [...source.matchAll(/router\.(get|post)\(\s*['"]([^'"]+)['"]/g)]
        .map(([, method, route]) => `${method.toUpperCase()} ${route}`);
}

function checkInventory() {
    assert.deepStrictEqual(declaredRoutes('net/routes.js'), NET.map(p => `GET ${p}`), 'update the sunset test for every net route');
    const devSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'dev', 'routes.js'), 'utf8');
    assert.deepStrictEqual(
        declaredRoutes('dev/routes.js', devSource.indexOf('module.exports = function createDevRoutes')),
        DEV.map(p => `GET ${p}`), 'update the sunset test for every dev route',
    );
}

async function request(base, route, { method = 'GET', headers = {}, body } = {}) {
    const r = await fetch(base + route, { method, headers, body });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* a failure message may be HTML */ }
    return { status: r.status, headers: r.headers, text, json };
}

async function gone(base, method, route, app) {
    const r = await request(base, route, { method });
    assert.strictEqual(r.status, 404, `${app} ${method} ${route}: ${r.status} ${r.text.slice(0, 200)}`);
}

(async () => {
    checkInventory();
    const procs = [];
    const start = async (...args) => { const p = await startApp(...args); procs.push(p); return p; };
    try {
        const ports = { img: await freePort(), audio: await freePort(), docs: await freePort() };
        const common = {
            DATABASE_URL: '', DATABASE_DIRECT_URL: '',
            OV_NETWORK_URL: 'http://127.0.0.1:9', OV_NETWORK_INTERNAL_URL: 'http://127.0.0.1:9',
            OV_COMMUNITY_URL: 'http://127.0.0.1:9', OV_COMMUNITY_INTERNAL_URL: 'http://127.0.0.1:9',
        };
        const satellites = {};
        for (const app of ['img', 'audio', 'docs']) {
            satellites[app] = await start(app, {
                ...common, DATA_DIR: path.join(tmp, app),
                UPLOADS_DIR: path.join(tmp, app, 'uploads'), OUTPUT_DIR: path.join(tmp, app, 'outputs'),
            }, ports[app]);
        }
        const gateway = await start('gateway', {
            ...common, DATA_DIR: path.join(tmp, 'gateway'),
            OV_DOMAINS_URL: 'http://127.0.0.1:9/api/domains', OV_REGISTRY_URL: 'http://127.0.0.1:9/registry',
            TOOLS_SATELLITE_PORTS: `img=${ports.img},audio=${ports.audio},docs=${ports.docs},yt=9,text=9,maps=9,food=9`,
        });

        for (const [prefix, routes] of [['net', NET], ['dev', DEV]]) {
            for (const route of routes) {
                const base = `/api/${prefix}${route.replace('/:target?', '')}`;
                await gone(gateway.base, 'GET', base, 'gateway');
                if (route.endsWith('/:target?')) {
                    // Invalid percent encoding would be rejected before any network call if a router reappears.
                    await gone(gateway.base, 'GET', `${base}/%`, 'gateway');
                }
            }
        }
        for (const [app, proc] of Object.entries(satellites)) {
            for (const route of PROCESS) {
                for (const method of ['GET', 'POST']) await gone(proc.base, method, route, app);
            }
        }

        const origin = { Origin: 'https://openvibe.tools' };
        const made = await request(gateway.base, '/api/dev/webhook/bins', { method: 'POST', headers: origin });
        assert.strictEqual(made.status, 200, made.text);
        assert.match(made.json.binId, /^[a-f0-9]{24}$/);
        const cookie = String(made.headers.get('set-cookie') || '').split(';')[0];
        assert.match(cookie, /^ov_tools_jobs=/);
        const bin = `/api/dev/webhook/bins/${made.json.binId}`;
        const received = await request(gateway.base, `${bin}/in`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sunset: 'kept' }),
        });
        assert.strictEqual(received.status, 200, received.text);
        const read = await request(gateway.base, bin, { headers: { Cookie: cookie } });
        assert.strictEqual(read.status, 200, read.text);
        assert.strictEqual(read.json.requestCount, 1);
        assert.strictEqual(read.json.requests[0].body.sunset, 'kept');

        const run = await request(gateway.base, '/api/v1/tools/jsonminify/run', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ input: { text: '{ "sunset": true }' } }),
        });
        assert.strictEqual(run.status, 200, run.text);
        assert.deepStrictEqual([run.json.state, run.json.tool, run.json.result],
            ['succeeded', 'jsonminify', { text: '{"sunset":true}' }]);

        console.log(`sunset routes: ${NET.length} net and ${DEV.length} dev patterns gone; process variants gone on img/audio/docs; webhook bins and dev run preserved`);
    } finally {
        for (const proc of procs.reverse()) await proc.kill();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
