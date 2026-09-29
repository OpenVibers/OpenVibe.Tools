'use strict';
/**
 * The gateway's secrets never reach a visitor (roadmap WS-R task 5, the internal-secret class). The
 * first check is static: the retired internal key (X-Internal-Key, plan T2) is read nowhere in the
 * serving code. Then the
 * gateway starts with a sentinel as its Network OAuth client secret and its
 * Events subscription secret, and with no network (the no-network preload: every third-party call
 * and lookup fails at once, so the net tools and the sign-in, registry and search calls all take
 * their error paths). Then its pages, APIs, every tool in its registry (description and schema) and
 * every net tool with hosts, internal addresses and nonsense are requested; and the sign-in callback
 * with a forged code (it posts the client secret to Network). No body or header may carry a sentinel,
 * nor may the process's output.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startApp } = require('../../_shared/test/spawn');

const SECRETS = {
    OV_OAUTH_CLIENT_SECRET: 'sentinel-not-a-secret-tools-oauth-client',
    TOOLS_EVENTS_SECRET: 'sentinel-not-a-secret-tools-events-subscription',
};
const NET_TOOLS = ['blacklist', 'dnsprop', 'dns', 'headers', 'ip', 'ipv4', 'ipv6', 'lookup', 'ping', 'port', 'rdap', 'rdns', 'redirects', 'robots', 'sitemap', 'smtp', 'ssl', 'uptime', 'whois'];
let seq = 0;
const client = () => { seq++; return { 'x-forwarded-for': `198.18.${(seq >> 8) & 255}.${seq & 255}` }; };

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-sec-'));
    const gw = await startApp('gateway', {
        ...SECRETS, DATA_DIR: tmp, OV_OAUTH_CLIENT_ID: 'tools',
        OV_DOMAINS_URL: 'http://127.0.0.1:9/api/domains', OV_REGISTRY_URL: 'http://127.0.0.1:9/registry', OV_COMMUNITY_INTERNAL_URL: 'http://127.0.0.1:9',
        NODE_OPTIONS: `--require ${path.join(__dirname, '..', '..', '_shared', 'test', 'no-network.js')}`,
    });
    let failures = 0;
    const check = async (name, fn) => { try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failures++; console.log(`  ✗ ${name}\n    ${String(e.stack || e.message).split('\n').slice(0, 8).join('\n    ')}`); } };
    const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    const RETIRED_KEY = /\bINTERNAL_API_KEY\b|\bOV_INTERNAL_KEY\b|x-internal-key/i;
    await check('no server file or _shared helper reads the retired internal key', () => {
        const roots = [path.join(__dirname, '..', '..'), path.join(__dirname, '..', '..', '_shared')];
        const files = [];
        const walk = (dir) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) { if (e.name === 'node_modules' || e.name === 'test') continue; walk(full); }
                else if (/\.(js|cjs|mjs|ts)$/.test(e.name)) files.push(full);
            }
        };
        for (const root of roots) {
            for (const e of fs.readdirSync(root, { withFileTypes: true })) {
                const full = path.join(root, e.name);
                if (!e.isDirectory() || e.name !== 'server') continue;
                for (const f of fs.readdirSync(full)) if (/\.js$/.test(f)) files.push(path.join(full, f));
            }
        }
        walk(roots[1]);
        assert.ok(files.length > 10, `found ${files.length} files to scan`);
        const hits = files.filter((f) => RETIRED_KEY.test(stripComments(fs.readFileSync(f, 'utf8'))));
        assert.deepStrictEqual(hits.map((f) => path.relative(path.join(__dirname, '..', '..'), f)), []);
    });
    const get = async (p, opts = {}) => {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 15000);
        try {
            const r = await fetch(gw.base + p, { redirect: 'manual', signal: ac.signal, ...opts, headers: { ...client(), ...(opts.headers || {}) } });
            const text = await r.text().catch(() => '');
            return { status: r.status, text: text + JSON.stringify([...r.headers.entries()]) };
        } catch { return { status: 0, text: '' }; } finally { clearTimeout(timer); }
    };
    try {
        const paths = ['/', '/all-tools', '/tools', '/developers', '/updates', '/tos', '/llms.txt', '/robots.txt', '/sitemap.xml', '/search?q=x', '/me', '/login', '/logout',
            '/callback?code=forged&state=forged', '/auth/callback?code=forged&state=forged', '/api/health', '/api/ready', '/api/brand', '/api/catalog.json', '/api/v1/openapi.json',
            '/api/v1/me/recent-tools', '/api/internal/analytics', '/api/nope', '/nope', '/.env', '/api/%', '/api/pastes/x', '/webhook/bins/nope', '/myip', '/opengraph?url=http://127.0.0.1/',
            '/api/v1/tools', '/api/v1/tools?q=x'];
        const tools = await get('/api/v1/tools');
        let ids = [];
        try { ids = (JSON.parse(tools.text.slice(0, tools.text.lastIndexOf('[['))).tools || []).map((t) => t.id); } catch { /* listed below */ }
        for (const id of ids) paths.push(`/api/v1/tools/${encodeURIComponent(id)}`, `/api/v1/tools/${encodeURIComponent(id)}/schema`, `/tool/${encodeURIComponent(id)}`);
        for (const tool of NET_TOOLS) {
            for (const target of ['example.com', '127.0.0.1', '169.254.169.254', "'\"<x>"]) paths.push(`/${tool}/${encodeURIComponent(target)}`, `/api/net/${tool}?target=${encodeURIComponent(target)}&host=${encodeURIComponent(target)}`);
        }
        const found = [];
        const statuses = {};
        const limited = [];
        await check(`every page, API, registered tool and net tool (${paths.length} paths): no sentinel`, async () => {
            for (const p of paths) {
                const r = await get(p);
                statuses[r.status] = (statuses[r.status] || 0) + 1;
                if (r.status === 429) limited.push(p);
                for (const [k, v] of Object.entries(SECRETS)) if (r.text.includes(v)) found.push(`GET ${p} → ${r.status} carries ${k}`);
            }
            for (const p of ['/api/pastes/x', '/api/net/port', '/auth/fedcm', '/webhook/bins']) {
                const r = await get(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"broken": ' });
                for (const [k, v] of Object.entries(SECRETS)) if (r.text.includes(v)) found.push(`POST ${p} → ${r.status} carries ${k}`);
            }
            console.log(`    (tools listed: ${ids.length}; answers ${JSON.stringify(statuses)})`);
            assert.ok(ids.length > 10, 'the tool registry was listed');
            // The net tools also throttle per target (the same host asked too often): only those may be 429.
            const netTool = new RegExp(`^/(api/net/)?(${NET_TOOLS.join('|')})[/?]`);
            assert.deepStrictEqual(limited.filter((p) => !netTool.test(p)), [], 'rate-limited outside the net tools');
            assert.deepStrictEqual(found, []);
        });
        await check('the process output carries no sentinel', () => {
            const out = gw.output();
            for (const [k, v] of Object.entries(SECRETS)) assert.ok(!out.includes(v), `a log line carries ${k}`);
        });
    } finally {
        gw.kill('SIGTERM');
        await gw.exited;
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
    console.log('\ngateway security-secrets: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
