'use strict';
// ═══════════════════════════════════════════════════════════════
// The merged tool registry: one tools.tool@1 descriptor per catalogue tool (ADR-027), for
// GET /api/v1/tools[/:id[/schema]] on the gateway.
//
//   specs      each app's server/descriptors.js (net, dev and pastes here; img, audio, docs, text, yt
//              and maps/food from the satellites, required by path: pure data, no sharp or ffmpeg)
//   catalogue  ./index.js: family, name, keywords, and hosts with the owner's domain overrides
//   status     the catalogue's unavailable marks (net/config.js), and what each satellite says about
//              itself: GET /api/v1/tools on 127.0.0.1:<port> every minute, so a tool whose program is
//              missing on the host (qpdf, pdftoppm, heif-dec, ffmpeg, yt-dlp) is unavailable here too.
//
// Every build is checked with openvibe-contracts: contracts.validate('tools.tool@1') and
// contracts.tools.checkDescriptor per descriptor, contracts.tools.checkList for the list. A descriptor
// that fails is left out of the answers and the failure is a readiness problem (/api/ready degraded,
// check tool_registry), never a crash. Planned placeholders are not tools (tools.tool-list@1): asking
// for one is 404 with a detail saying it is planned.
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');
const path = require('path');
const contracts = require('openvibe-contracts');
const { compose, summaryOf, refForm } = require('../../../_shared/tools/descriptor');
const registry = require('./index');
const { MERGED } = require('./hosts');

const APPS = path.join(__dirname, '..', '..', '..');
const PASTE = {
    id: 'pastes', execution: 'sync', api: false, input: null, files: null,
    output: { kind: 'json', schema: { type: 'object', description: 'Pastes live on OpenVibe.Community, which has its own API' } },
    limits: { timeoutMs: 10000 }, auth: { anonymous: true, capability: 'tools.tool.run' }, quotaClass: 'tools-run', cost: 1, egress: false,
};

// Where each tool's spec lives, and the module its server engines are in (client tools with api true).
const SOURCES = [
    { app: 'net', specs: () => require('../net/descriptors').SPECS },
    { app: 'dev', specs: () => require('../dev/descriptors').SPECS, engines: path.join(__dirname, '..', 'dev', 'engines.js') },
    { app: 'img', specs: () => require(path.join(APPS, 'img/server/descriptors')).SPECS, satellite: 'img' },
    { app: 'audio', specs: () => require(path.join(APPS, 'audio/server/descriptors')).SPECS, satellite: 'audio' },
    { app: 'docs', specs: () => require(path.join(APPS, 'docs/server/descriptors')).SPECS, satellite: 'docs' },
    { app: 'text', specs: () => require(path.join(APPS, 'text/server/descriptors')).SPECS, engines: path.join(APPS, 'text/server/engines.js'), satellite: 'text' },
    { app: 'yt', specs: () => require(path.join(APPS, 'yt/server/descriptors')).SPECS, satellite: 'yt' },
    { app: 'maps', specs: () => require(path.join(APPS, 'maps/server/descriptors')).SPECS.filter(s => s.id === 'maps'), satellite: 'maps' },
    { app: 'food', specs: () => require(path.join(APPS, 'maps/server/descriptors')).SPECS.filter(s => s.id === 'food'), satellite: 'food' },
    { app: 'community', specs: () => [PASTE] },
];

let specs = null;            // id → { spec, app, engines, satellite }
let loadProblems = [];
function loadSpecs() {
    if (specs) return specs;
    specs = new Map();
    loadProblems = [];
    for (const src of SOURCES) {
        let list;
        try { list = src.specs(); } catch (err) { loadProblems.push(`${src.app}: descriptors could not be loaded (${err.message})`); continue; }
        for (const spec of list) {
            if (specs.has(spec.id)) loadProblems.push(`${spec.id}: described twice (${specs.get(spec.id).app} and ${src.app})`);
            else specs.set(spec.id, { spec, app: src.app, engines: src.engines || null, satellite: src.satellite || null });
        }
    }
    return specs;
}

const live = new Map();      // id → { status, statusReason } a satellite reports (only 'unavailable' is kept)
let liveAt = {};             // satellite → last good poll time
let built = null;

/** Rebuild when the catalogue (hosts, overrides) or a satellite's report changed. */
function key() {
    return `${registry.get().updated}|${JSON.stringify([...live])}`;
}

function build() {
    const all = loadSpecs();
    const cat = registry.get();
    const problems = [...loadProblems];
    const tools = [];
    const meta = new Map();
    for (const t of cat.tools) {
        const s = all.get(t.id);
        if (!s) { problems.push(`${t.id}: a catalogue tool without a descriptor`); continue; }
        const own = live.get(t.id) || (t.status === 'unavailable' ? { status: 'unavailable', statusReason: t.unavailable } : null);
        const d = compose(s.spec, {
            family: t.family, name: t.name, summary: summaryOf(t), keywords: t.keywords,
            hosts: t.external ? [] : [t.hosts.canonical, t.hosts.short].filter(Boolean),
            ...(own && { status: own.status, statusReason: own.statusReason }),
        });
        const v = contracts.validate('tools.tool@1', d);
        const c = v.valid ? contracts.tools.checkDescriptor(d) : v;
        if (!c.valid) { problems.push(`${t.id}: ${c.errors.slice(0, 3).map(e => `${e.path || '/'} ${e.message}`).join('; ')}`); continue; }
        tools.push(d);
        meta.set(t.id, { keywords: t.keywords || [], alsoIn: t.alsoIn || [] });
    }
    for (const id of all.keys()) if (!cat.tools.some(t => t.id === id)) problems.push(`${id}: described, but not a catalogue tool`);
    const version = crypto.createHash('sha1').update(JSON.stringify(tools)).digest('hex').slice(0, 16);
    const updatedAt = built && built.version === version ? built.updatedAt : new Date().toISOString();
    const list = { tools: tools.map(refForm), count: tools.length, updated_at: updatedAt };
    const lc = contracts.tools.checkList(list);
    if (!lc.valid) problems.push(...lc.errors.slice(0, 5).map(e => `list ${e.path}: ${e.message}`));
    const gone = new Map();
    for (const p of cat.planned) gone.set(p.id, `${p.name} is planned and not built yet, so it has no descriptor.`);
    for (const [mirror, m] of Object.entries(MERGED)) gone.set(mirror, `${mirror} is a second build of ${m.into}, served as a mirror; its descriptor is /api/v1/tools/${m.into}.`);
    built = {
        key: key(), version, updatedAt, tools, meta, gone, problems,
        families: new Map(cat.families.map(f => [f.id, f.name])),
        catalogueCount: cat.tools.length,
    };
    return built;
}

/** The registry now (rebuilt when its inputs changed), for the routes and the readiness check. */
function snapshot() {
    if (!built || built.key !== key()) build();
    return built;
}

/** The internal spec of a tool (engine, route, requires, example) and where its engines live. */
function internal(id) {
    return loadSpecs().get(id) || null;
}

/** Readiness row: every catalogue tool has a descriptor and every descriptor meets the contracts. */
function readyCheck() {
    return {
        name: 'tool_registry', required: false,
        description: 'GET /api/v1/tools: one tools.tool@1 descriptor per catalogue tool, checked with openvibe-contracts',
        check: () => {
            const s = snapshot();
            if (s.problems.length) return `${s.problems.length} problem${s.problems.length === 1 ? '' : 's'}: ${s.problems.slice(0, 5).join(' | ')}`;
            return { ok: true, detail: { tools: s.tools.length, api: s.tools.filter(d => d.api).length, unavailable: s.tools.filter(d => d.status === 'unavailable').length, satellites_polled: Object.keys(liveAt).length } };
        },
    };
}

/**
 * Ask each satellite what it says about its own tools (GET /api/v1/tools on loopback) now and every
 * minute; keep the unavailable marks. A satellite that does not answer keeps its last report.
 * @param {object} ports      { img: 4012, … } (the gateway's SATELLITES)
 * @param {Function} [fetchImpl]
 */
function startSatellitePolling(ports, { fetchImpl = fetch, everyMs = 60_000 } = {}) {
    const bySatellite = new Map();
    for (const [id, s] of loadSpecs()) if (s.satellite) (bySatellite.get(s.satellite) || bySatellite.set(s.satellite, []).get(s.satellite)).push(id);
    async function pollOne(name, port) {
        try {
            const r = await fetchImpl(`http://127.0.0.1:${port}/api/v1/tools`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(4000) });
            if (!r.ok) return false;
            const body = await r.json();
            const ids = new Set(bySatellite.get(name) || []);
            for (const d of body.tools || []) {
                if (!ids.has(d.id)) continue;
                if (d.status === 'unavailable') live.set(d.id, { status: 'unavailable', statusReason: d.statusReason || 'Not available on the server right now.' });
                else live.delete(d.id);
            }
            liveAt[name] = new Date().toISOString();
            return true;
        } catch { return false; }
    }
    const poll = () => Promise.all([...bySatellite.keys()].filter(n => ports[n]).map(n => pollOne(n, ports[n])));
    poll();
    const t = setInterval(poll, everyMs); t.unref();
    return { poll, stop: () => clearInterval(t) };
}

/** Tests: forget satellite reports. */
function resetLive() { live.clear(); liveAt = {}; built = null; }

module.exports = { snapshot, internal, readyCheck, startSatellitePolling, resetLive, SOURCES, live };
