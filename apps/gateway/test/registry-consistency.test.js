'use strict';
// Every tool the catalogue lists (not planned placeholders, not mirrors) must resolve to something that
// exists, or be marked unavailable:
//   img / audio / docs  its host in that satellite's domain map, naming an operation its tools/index.js defines
//                       (and a default format that operation can write)
//   net                 an endpoint in net/config.js that the router serves and net.html calls, or status 'unavailable'
//   dev                 an entry and a processor in dev.html
//   text                its host in the text app's host map, pointing at a page that exists
//   media / places      the app knows the host; pastes live on OpenVibe.Community
// merge.openvibe.tools pointed at an audio operation that did not exist for months; this test is what
// catches that (see the self-check at the end).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The satellites' tool modules are loaded for real; the audio ones make a temp dir on load.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-registry-'));
const APPS = path.join(__dirname, '..', '..');
const registry = require('../server/registry');
const { NET_TOOL_MAP } = require('../server/net/config');
const { DEV_TOOL_MAP } = require('../server/dev/config');
const createNetRoutes = require('../server/net/routes');

const SATELLITES = {
    img: {
        domainMap: require(path.join(APPS, 'img/server/domain-map')).DOMAIN_MAP,
        tools: require(path.join(APPS, 'img/server/tools')).TOOLS,
        formats: (op) => (op === 'convert' ? require(path.join(APPS, 'img/server/tools/convert')).formats : null),
    },
    audio: {
        domainMap: require(path.join(APPS, 'audio/server/domain-map')).DOMAIN_MAP,
        tools: require(path.join(APPS, 'audio/server/tools')).TOOLS,
        formats: (op) => (op === 'convert' ? require(path.join(APPS, 'audio/server/tools/convert')).formats : null),
    },
    docs: {
        domainMap: require(path.join(APPS, 'docs/server/domain-map')).DOMAIN_MAP,
        tools: require(path.join(APPS, 'docs/server/tools')).TOOLS,
        formats: (op) => (op === 'pdf2img' ? ['png', 'jpg'] : null),
    },
};

/** What is wrong with a satellite tool's host → operation mapping ([] when nothing). */
function satelliteProblems(t, sat) {
    const host = `${t.id}.openvibe.tools`;
    const ctx = sat.domainMap[host];
    if (!ctx) return [`${t.family}/${t.id}: ${host} is not in the ${t.family} satellite's domain map`];
    if (!ctx.defaultOp) return [`${t.family}/${t.id}: ${host} names no operation`];
    if (!sat.tools[ctx.defaultOp]) return [`${t.family}/${t.id}: ${host} → operation "${ctx.defaultOp}", which apps/${t.family}/server/tools/index.js does not define`];
    const formats = ctx.defaultFormat && sat.formats(ctx.defaultOp);
    if (formats && !formats.includes(ctx.defaultFormat)) return [`${t.family}/${t.id}: ${host} → ${ctx.defaultOp} to "${ctx.defaultFormat}", a format it cannot write`];
    return [];
}

/** Routes the net router serves, as endpoint paths ('/robots', '/myip', …). */
function netEndpoints() {
    const router = createNetRoutes(null, null, { egress: { parseUrl: () => null } });
    return new Set(router.stack.filter(l => l.route).map(l => l.route.path.replace(/\/:target\?$/, '')));
}

/** net.html's TOOLS: id → { endpoint, unavailable }. */
function netPage() {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'net.html'), 'utf8');
    const block = html.slice(html.indexOf('const TOOLS = {'), html.indexOf('const CATS = {'));
    const out = new Map();
    for (const m of block.matchAll(/^\s{8}([a-z0-9]+):\s+\{ name: .*$/gm)) {
        const ep = /endpoint: (?:null|'([^']*)')/.exec(m[0]);
        out.set(m[1], { endpoint: ep ? ep[1] || null : undefined, unavailable: /unavailable: '/.test(m[0]) });
    }
    return out;
}

/** dev.html: the tool entries (T) and the processors (P). */
function devPage() {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'dev.html'), 'utf8');
    const t = html.slice(html.indexOf('const T={'), html.indexOf('const CATS='));
    return { entries: new Set([...t.matchAll(/^([a-z0-9]+):\{n:/gm)].map(m => m[1])), processors: new Set([...html.matchAll(/^P\.([a-z0-9]+)=/gm)].map(m => m[1])) };
}

const cat = registry.catalog();
const problems = [];
const endpoints = netEndpoints();
const page = netPage();
const dev = devPage();
const { HOSTNAME_MAP: TEXT_HOSTS } = require(path.join(APPS, 'text/server/hosts'));
const yt = require(path.join(APPS, 'yt/server/seo'));
const counted = {};

for (const t of cat.tools) {
    counted[t.family] = (counted[t.family] || 0) + 1;
    assert.ok(['available', 'unavailable'].includes(t.status), `${t.id} has a status`);
    if (SATELLITES[t.family]) { problems.push(...satelliteProblems(t, SATELLITES[t.family])); continue; }
    switch (t.family) {
        case 'net': {
            const def = NET_TOOL_MAP.get(t.id);
            const ui = page.get(t.id);
            if (!def) { problems.push(`net/${t.id}: not in net/config.js`); break; }
            if (!ui) { problems.push(`net/${t.id}: net.html has no entry (the page would show the hub)`); break; }
            if (def.status === 'unavailable') {
                if (t.status !== 'unavailable' || !t.unavailable) problems.push(`net/${t.id}: unavailable in net/config.js but not in the catalogue`);
                if (!ui.unavailable) problems.push(`net/${t.id}: unavailable, but net.html does not say so`);
                break;
            }
            if (!def.endpoint || !endpoints.has(def.endpoint)) problems.push(`net/${t.id}: endpoint ${def.endpoint} is not a route of /api/net`);
            if (ui.endpoint !== def.endpoint) problems.push(`net/${t.id}: net.html calls ${ui.endpoint}, net/config.js says ${def.endpoint}`);
            if (t.status !== 'available') problems.push(`net/${t.id}: implemented but marked ${t.status}`);
            break;
        }
        case 'dev': {
            if (!DEV_TOOL_MAP.has(t.id)) problems.push(`dev/${t.id}: not in dev/config.js`);
            if (!dev.entries.has(t.id)) problems.push(`dev/${t.id}: dev.html has no entry`);
            if (!dev.processors.has(t.id)) problems.push(`dev/${t.id}: dev.html has no processor P.${t.id}`);
            break;
        }
        case 'text': {
            const file = TEXT_HOSTS[`${t.id}.openvibe.tools`];
            if (!file) problems.push(`text/${t.id}: ${t.id}.openvibe.tools is not in apps/text/server/hosts.js`);
            else if (!fs.existsSync(path.join(APPS, 'text', 'public', file))) problems.push(`text/${t.id}: page ${file} does not exist`);
            break;
        }
        case 'media':
            if (!yt.knowsHost(t.hosts.canonical)) problems.push(`media/${t.id}: the yt app does not serve ${t.hosts.canonical}`);
            break;
        case 'places': {
            const src = path.join(APPS, t.id, 'server', 'index.js');
            if (!fs.existsSync(src) || !fs.readFileSync(src, 'utf8').includes(`'${t.id}.openvibe.tools'`)) problems.push(`places/${t.id}: no app serving ${t.id}.openvibe.tools`);
            break;
        }
        case 'pastes':
            if (!(registry.get().tools.find(x => x.id === t.id) || {}).external) problems.push(`pastes/${t.id}: pastes are served by OpenVibe.Community (external)`);
            break;
        default:
            problems.push(`${t.family}/${t.id}: unknown family, nothing checks it`);
    }
}
assert.deepStrictEqual(problems, [], `catalogue tools that resolve to nothing:\n  ${problems.join('\n  ')}`);
for (const f of ['img', 'audio', 'docs', 'net', 'dev', 'text', 'media', 'places', 'pastes']) assert.ok(counted[f] > 0, `the catalogue has ${f} tools (checked)`);

// Planned placeholders are never listed as tools; mirrors are not tools either.
assert.ok(cat.planned.every(p => !cat.tools.some(t => t.id === p.id)));

// ── Self-check: the audio merge gap would have been caught ──
const toolsWithoutMerge = { ...SATELLITES.audio.tools };
delete toolsWithoutMerge.merge;
const found = satelliteProblems({ family: 'audio', id: 'merge' }, { ...SATELLITES.audio, tools: toolsWithoutMerge });
assert.deepStrictEqual(found, ['audio/merge: merge.openvibe.tools → operation "merge", which apps/audio/server/tools/index.js does not define']);
assert.match(satelliteProblems({ family: 'img', id: 'bmp' }, { ...SATELLITES.img, formats: () => ['png'] })[0], /cannot write/);

fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
console.log(`registry consistency: ${cat.tools.length} catalogue tools resolve (${Object.entries(counted).map(([f, n]) => `${f} ${n}`).join(', ')}); ${cat.tools.filter(t => t.status === 'unavailable').length} marked unavailable`);
