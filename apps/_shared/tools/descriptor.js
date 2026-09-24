'use strict';
// ═══════════════════════════════════════════════════════════════
// Tool descriptors (openvibe-contracts tools.tool@1, ADR-027): one per catalogue tool.
//
// Each app keeps a SPEC per tool in server/descriptors.js, next to the code that runs it: how it
// runs (execution, api, the job it submits, the older routes), what it takes (input schema, files),
// what it gives (output), its limits, who may call it (auth), its quota class and cost, and whether
// it reaches out to a host the caller chose (egress). The catalogue owns the rest: family, name,
// summary, hosts (with the owner's domain overrides) and the docs page. compose() joins the two.
//
// A spec may also carry fields that are never published (INTERNAL below):
//   engine    the name of its server engine in the app's engines module (a client tool with api true)
//   route     the server route that runs a sync tool today ({ method, path, query })
//   requires  programs the tool needs on the host ('qpdf', 'heif-dec', …); the satellite marks it
//             unavailable while one is missing
//   example   { input } that runs: used by the tests, later by the docs
//   cacheTtlMs how long the run API may reuse an inline answer (0: never — random or time-dependent
//             output; unset: engines 10 minutes, routes never)
//
// Like the rest of apps/_shared this file has no dependencies.
// ═══════════════════════════════════════════════════════════════

const SITE = 'https://openvibe.tools';
const JSON_SCHEMA = 'https://json-schema.org/draft/2020-12/schema';
const INTERNAL = new Set(['id', 'engine', 'route', 'requires', 'example', 'job', 'legacy', 'status', 'statusReason', 'cacheTtlMs']);
const ANYONE = Object.freeze({ anonymous: true, capability: 'tools.tool.run' });

const runPath = (id) => `/api/v1/tools/${id}/run`;
const schemaUrl = (id) => `${SITE}/api/v1/tools/${id}/schema`;
const docsUrl = (id) => `${SITE}/tool/${id}`;
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

/** One plain sentence for the catalogue record: its description's first sentence when that fits, else the tagline. */
function summaryOf(rec) {
    const first = String((rec && rec.description) || '').split(/(?<=[.!?])\s/)[0].trim();
    if (first && first.length <= 200) return /[.!?]$/.test(first) ? first : `${first}.`;
    const t = String((rec && rec.tagline) || (rec && rec.name) || '').trim().slice(0, 199);
    return /[.!?]$/.test(t) ? t : `${t}.`;
}

/**
 * spec + catalogue facts → a tools.tool@1 descriptor with its schemas embedded.
 * @param {object} spec  the app's spec (see the header)
 * @param {object} meta  { family, name, summary, hosts: string[], docs?, status?, statusReason? } — a
 *                       status here (the host is missing a program, the catalogue marks it) wins
 */
function compose(spec, meta) {
    const api = spec.api === true;
    const status = meta.status || spec.status || 'stable';
    const reason = meta.status ? meta.statusReason : spec.statusReason;
    const d = { id: spec.id, family: meta.family, name: meta.name, summary: meta.summary, status };
    if (reason) d.statusReason = String(reason).slice(0, 300);
    d.execution = spec.execution;
    d.api = api;
    d.run = api ? { method: 'POST', path: runPath(spec.id), job: spec.job ? clone(spec.job) : null, ...(spec.legacy && spec.legacy.length && { legacy: [...spec.legacy] }) } : null;
    d.input = api ? clone(spec.input) : null;
    d.files = clone(spec.files || null);
    d.output = clone(spec.output);
    d.limits = clone(spec.limits);
    d.auth = clone(spec.auth || ANYONE);
    d.quotaClass = spec.quotaClass;
    d.cost = spec.cost || 1;
    d.egress = spec.egress === true;
    d.hosts = [...(meta.hosts || [])];
    d.docs = meta.docs || docsUrl(spec.id);
    return d;
}

/** The list form: input and output.schema as { $ref } into GET /api/v1/tools/:id/schema. */
function refForm(d) {
    const out = { ...d };
    if (d.input && typeof d.input === 'object') out.input = { $ref: `${schemaUrl(d.id)}#/$defs/input` };
    if (d.output && d.output.schema) out.output = { ...d.output, schema: { $ref: `${schemaUrl(d.id)}#/$defs/output` } };
    return out;
}

/** GET /api/v1/tools/:id/schema: { $schema, $id, $defs: { input, output } }. No API → input false (nothing is accepted). */
function schemaDoc(d) {
    const output = d.output.schema || (d.output.kind === 'text' ? { type: 'string', description: 'result.text' } : { description: d.output.kind === 'json' ? 'result.data' : 'result.files' });
    return { $schema: JSON_SCHEMA, $id: schemaUrl(d.id), $defs: { input: d.input || false, output } };
}

/** A spec without the fields that are never published (tests use it to compare specs to descriptors). */
function publicFields(spec) {
    const out = {};
    for (const [k, v] of Object.entries(spec)) if (!INTERNAL.has(k)) out[k] = v;
    return out;
}

module.exports = { SITE, JSON_SCHEMA, ANYONE, compose, refForm, schemaDoc, summaryOf, publicFields, runPath, schemaUrl, docsUrl };
