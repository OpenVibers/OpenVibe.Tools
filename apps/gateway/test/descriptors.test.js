'use strict';
// The tool registry (ADR-027): one tools.tool@1 descriptor per catalogue tool, built from each app's
// server/descriptors.js and the catalogue, and held to what the code really does.
//   • every catalogue id has exactly one descriptor, every descriptor passes contracts.validate and
//     contracts.tools.checkDescriptor, and the list passes contracts.tools.checkList
//   • every input and output schema compiles (Ajv 2020-12, strict) and every example matches its input
//   • a job tool's operation is one its app defines (getTool), and { ...example, ...preset, tool }
//     passes that app's own job validation; files, sizes and timeouts match the app's upload and job limits
//   • a sync tool with an API runs through a route the gateway serves today (the net router, /api/dev)
//   • hosts come from the catalogue (owner overrides included), status from the unavailable marks and
//     from what a satellite reports; planned placeholders and mirrors are not tools
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-descriptors-'));
const APPS = path.join(__dirname, '..', '..');
const contracts = require('openvibe-contracts');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const registry = require('../server/registry');
const reg = require('../server/registry/descriptors');
const { publicFields } = require('../../_shared/tools/descriptor');
const createNetRoutes = require('../server/net/routes');
const createDevRoutes = require('../server/dev/routes');

const ajv = new Ajv2020({ strict: true, strictRequired: false, allowUnionTypes: true, allErrors: true });
addFormats(ajv);

const snap = reg.snapshot();
const cat = registry.catalog();
const byId = new Map(snap.tools.map(d => [d.id, d]));

// ── One descriptor per catalogue tool, all valid ──
assert.deepStrictEqual(snap.problems, [], `registry problems:\n  ${snap.problems.join('\n  ')}`);
assert.strictEqual(snap.tools.length, cat.tools.length, 'as many descriptors as catalogue tools');
assert.strictEqual(new Set(snap.tools.map(d => d.id)).size, snap.tools.length, 'ids are unique');
for (const t of cat.tools) assert.ok(byId.has(t.id), `${t.id} has a descriptor`);
for (const d of snap.tools) {
    const v = contracts.validate('tools.tool@1', d);
    assert.ok(v.valid, `${d.id}: ${JSON.stringify(v.errors)}`);
    const c = contracts.tools.checkDescriptor(d);
    assert.ok(c.valid, `${d.id}: ${JSON.stringify(c.errors)}`);
}
const { refForm } = require('../../_shared/tools/descriptor');
const list = { tools: snap.tools.map(refForm), count: snap.tools.length, updated_at: snap.updatedAt, families: [...new Set(snap.tools.map(d => d.family))].map(id => ({ id, name: snap.families.get(id), count: snap.tools.filter(d => d.family === id).length })) };
assert.ok(contracts.tools.checkList(list).valid, JSON.stringify(contracts.tools.checkList(list).errors));
assert.ok(reg.readyCheck().check().ok, 'the readiness row is ok');

// Every spec was published: nothing a spec says is lost on the way (internal fields aside).
for (const d of snap.tools) {
    const spec = publicFields(reg.internal(d.id).spec);
    for (const k of ['execution', 'files', 'output', 'limits', 'auth', 'quotaClass', 'egress']) if (k in spec) assert.deepStrictEqual(d[k], spec[k] === undefined ? null : spec[k], `${d.id}.${k}`);
}

// Published since openvibe-contracts v0.33.1: the catalogue's keywords, and each API tool's example (a job
// tool's with sample files that fit files.min and files.accept); no API, no examples. checkDescriptor
// (above) holds every example to the input schema, maxInputBytes and files.
for (const d of snap.tools) {
    const s = reg.internal(d.id).spec;
    assert.ok(Array.isArray(d.keywords) && d.keywords.length, `${d.id}: keywords`);
    if (!d.api) { assert.ok(!d.examples, `${d.id}: no API, no examples`); continue; }
    assert.strictEqual(d.examples.length, 1, d.id);
    assert.deepStrictEqual(d.examples[0].input, s.example.input, `${d.id}: the spec's example`);
    if (d.files && d.files.min) assert.strictEqual(d.examples[0].files.length, d.files.min, `${d.id}: sample files`);
}
assert.strictEqual(snap.tools.filter(d => d.examples).length, snap.tools.filter(d => d.api).length);

// ── Schemas compile; examples match their input ──
for (const d of snap.tools) {
    if (d.input) {
        const validate = ajv.compile(d.input);
        const ex = reg.internal(d.id).spec.example;
        assert.ok(ex && ex.input, `${d.id}: an API tool has an example input`);
        assert.ok(validate(ex.input), `${d.id}: example ${JSON.stringify(ex.input)} → ${JSON.stringify(validate.errors)}`);
        assert.ok(Buffer.byteLength(JSON.stringify(ex.input)) <= (d.limits.maxInputBytes || Infinity), `${d.id}: example within maxInputBytes`);
    }
    if (d.output.schema) ajv.compile(d.output.schema);
}

// ── Job tools: their app's operation, job type, validation, files and limits ──
const JOB_APPS = {
    img: { type: 'img.process', tools: () => require(path.join(APPS, 'img/server/tools')), process: () => require(path.join(APPS, 'img/server/process')), config: () => require(path.join(APPS, 'img/server/config')) },
    audio: { type: 'audio.process', tools: () => require(path.join(APPS, 'audio/server/tools')), process: () => require(path.join(APPS, 'audio/server/process')), config: () => require(path.join(APPS, 'audio/server/config')) },
    docs: { type: 'docs.process', tools: () => require(path.join(APPS, 'docs/server/tools')), process: () => require(path.join(APPS, 'docs/server/process')), config: () => require(path.join(APPS, 'docs/server/config')) },
};
class JobError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const defs = {};
for (const [app, a] of Object.entries(JOB_APPS)) a.process().defineJobs({ define: (def) => { defs[app] = def; }, JobError });

let jobs = 0;
for (const d of snap.tools.filter(x => x.run && x.run.job)) {
    const app = reg.internal(d.id).app;
    const a = JOB_APPS[app];
    assert.ok(a, `${d.id}: a job tool on ${app}, which has no jobs`);
    const def = defs[app];
    assert.strictEqual(d.run.job.type, def.type, `${d.id}: job type`);
    assert.ok(a.tools().getTool(d.run.job.operation), `${d.id}: operation ${d.run.job.operation} is defined by apps/${app}/server/tools/index.js`);
    assert.strictEqual(d.limits.timeoutMs, def.timeoutMs, `${d.id}: timeoutMs is the job's`);
    assert.ok(d.files.min >= def.minFiles && d.files.max <= def.maxFiles, `${d.id}: file count within the job's`);
    const cfg = a.config().upload;
    assert.strictEqual(d.files.maxBytes, cfg.maxFileSize, `${d.id}: maxBytes is the upload limit`);
    for (const m of d.files.accept) assert.ok(cfg.allowedMimes.includes(m), `${d.id}: ${m} is accepted by the upload`);
    // The run's job input passes the app's own validation (a tool whose program is missing: 503, not a 400).
    const input = contracts.tools.jobInput(d, reg.internal(d.id).spec.example.input);
    const files = Array.from({ length: d.files.min }, (_, i) => ({ name: `f${i}`, mime: d.files.accept[0] }));
    let res;
    try { res = def.validate(input, files); } catch (err) { res = err; }
    if (res instanceof JobError) assert.strictEqual(res.status, 503, `${d.id}: only a missing program may refuse the job (${res.message})`);
    else assert.strictEqual(res, null, `${d.id}: job validate(${JSON.stringify(input)}) → ${res}`);
    // Every option the schema offers is one the job takes.
    const keys = Object.keys((d.input && d.input.properties) || {}).concat(Object.keys(d.run.job.preset || {}));
    if (app === 'img') for (const k of keys) assert.ok(a.process().OPTION_KEYS.includes(k), `${d.id}: img option ${k}`);
    if (app === 'docs') for (const k of keys) assert.ok(a.process().SINGLE_KEYS.includes(k), `${d.id}: docs option ${k}`);
    jobs++;
}
// Formats named by the schemas and presets are ones the operation can write.
const imgFormats = require(path.join(APPS, 'img/server/tools/convert')).formats;
const audioFormats = require(path.join(APPS, 'audio/server/tools/convert')).formats;
for (const d of snap.tools.filter(x => x.family === 'img')) {
    for (const f of (d.input.properties.format || {}).enum || []) assert.ok(imgFormats.includes(f), `${d.id}: format ${f}`);
    const pre = d.run.job.preset && d.run.job.preset.defaultFormat;
    if (pre) assert.ok(imgFormats.includes(pre), `${d.id}: default format ${pre}`);
}
for (const d of snap.tools.filter(x => x.family === 'audio' && x.run.job.preset)) assert.ok(audioFormats.includes(d.run.job.preset.format), `${d.id}: preset format`);
assert.deepStrictEqual(require(path.join(APPS, 'img/server/descriptors')).ACCEPT, require(path.join(APPS, 'img/server/config')).upload.allowedMimes, 'img takes every upload type');
assert.strictEqual(require(path.join(APPS, 'docs/server/descriptors')).MAX_PAGES, require(path.join(APPS, 'docs/server/tools/pdf')).MAX_PAGES, 'docs page limit');

// The img job takes the preset's defaultFormat, and an explicit format still wins (as on the page).
{
    const { buildOptions } = JOB_APPS.img.process();
    assert.strictEqual(buildOptions({ defaultFormat: 'gif' }, null, 'image/png').format, 'gif');
    assert.strictEqual(buildOptions({ format: 'webp', defaultFormat: 'gif' }, null, 'image/png').format, 'webp');
    assert.strictEqual(buildOptions({}, { defaultFormat: 'bmp' }, 'image/png').format, 'bmp', 'the host default still applies to the page\'s own requests');
    assert.ok(!('defaultFormat' in buildOptions({ defaultFormat: 'gif' }, null, 'image/png')), 'the handlers never see defaultFormat');
}

// ── Sync tools with an API run through a route the gateway serves ──
const served = new Set();
for (const [base, router] of [['/api/net', createNetRoutes(null, null, { egress: { parseUrl: () => null } })], ['/api/dev', createDevRoutes(null, (q, s, n) => n())]]) {
    for (const l of router.stack.filter(x => x.route)) for (const m of Object.keys(l.route.methods)) served.add(`${m.toUpperCase()} ${base}${l.route.path}`);
}
const serves = (method, p) => served.has(`${method} ${p}`) || served.has(`${method} ${p}/:target?`);
let syncApi = 0;
for (const d of snap.tools.filter(x => x.execution === 'sync' && x.api)) {
    const { route } = reg.internal(d.id).spec;
    assert.ok(route && serves(route.method, route.path), `${d.id}: ${route && route.method} ${route && route.path} is a route of the gateway`);
    for (const l of d.run.legacy || []) { const [m, p] = l.split(' '); assert.ok(serves(m, p.replace(/\/:target$/, '')), `${d.id}: legacy ${l} is served`); }
    syncApi++;
}
// Egress and throttles: probes need tools.net.probe; anonymous egress tools have a per-target throttle.
for (const d of snap.tools) {
    if (d.auth.capability === 'tools.net.probe') assert.ok(d.egress && !d.auth.anonymous && d.quotaClass === 'tools-probe', `${d.id}: a probe`);
    if (d.egress && d.auth.anonymous) assert.ok(d.limits.perTargetPerMinute > 0, `${d.id}: per-target throttle`);
}
assert.deepStrictEqual(snap.tools.filter(d => d.auth.capability === 'tools.net.probe').map(d => d.id).sort(), ['latency', 'mtr', 'ping', 'port', 'traceroute']);
assert.strictEqual(byId.get('yt').api, false, 'yt is page-only');
assert.strictEqual(byId.get('yt').run, null);

// ── Status: the catalogue's marks, a satellite's report ──
for (const t of cat.tools.filter(x => x.status === 'unavailable')) {
    const d = byId.get(t.id);
    assert.strictEqual(d.status, 'unavailable', `${t.id} is unavailable`);
    assert.strictEqual(d.statusReason, t.unavailable);
}
reg.live.set('protectpdf', { status: 'unavailable', statusReason: 'This tool is being set up on the server (it needs qpdf) and is not available yet.' });
{
    const d = reg.snapshot().tools.find(x => x.id === 'protectpdf');
    assert.deepStrictEqual([d.status, d.api, !!d.run], ['unavailable', true, true], 'unavailable, still described with its run (runs answer 503)');
    assert.match(d.statusReason, /qpdf/);
}
reg.resetLive();
assert.strictEqual(reg.snapshot().tools.find(x => x.id === 'protectpdf').status, 'stable');

// ── Hosts: canonical first, the short host, the owner's overrides ──
for (const t of cat.tools) {
    const d = byId.get(t.id);
    if (t.id === 'pastes') { assert.deepStrictEqual(d.hosts, [], 'pastes live on another service'); continue; }
    assert.deepStrictEqual(d.hosts, [t.hosts.canonical, t.hosts.short].filter(Boolean), `${t.id} hosts`);
    assert.strictEqual(d.docs, `https://openvibe.tools/tool/${t.id}`);
}
registry.setOverrides([{ tool_id: 'png', host: 'png-converter.example.com', role: 'canonical' }]);
assert.deepStrictEqual(reg.snapshot().tools.find(d => d.id === 'png').hosts, ['png-converter.example.com', 'png.openvibe.tools'], 'an owner\'s canonical domain comes first');
registry.setOverrides([]);
assert.deepStrictEqual(reg.snapshot().tools.find(d => d.id === 'png').hosts, ['png.openvibe.tools']);

// ── Not tools: planned placeholders and mirrors ──
for (const p of cat.planned) { assert.ok(!byId.has(p.id), `${p.id} is planned`); assert.match(snap.gone.get(p.id), /planned/); }
for (const m of ['jsonfmt', 'md', 'codediff', 'slugify', 'entities']) { assert.ok(!byId.has(m)); assert.match(snap.gone.get(m), /mirror/); }

// ── Counts ──
const tally = (f) => snap.tools.reduce((o, d) => { const k = f(d); o[k] = (o[k] || 0) + 1; return o; }, {});
const fam = tally(d => d.family);
assert.deepStrictEqual(fam, { dev: 33, net: 38, img: 15, audio: 36, docs: 10, text: 33, media: 1, places: 2, pastes: 1 });

fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
console.log(`descriptors: ${snap.tools.length} tools valid (${Object.entries(tally(d => `${d.execution}${d.api ? '+api' : ''}`)).map(([k, n]) => `${k} ${n}`).join(', ')}); ${jobs} job tools pass their app's validation; ${syncApi} sync tools run through served routes`);
