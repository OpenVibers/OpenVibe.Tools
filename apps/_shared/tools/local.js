'use strict';
// ═══════════════════════════════════════════════════════════════
// A satellite's own tool registry: the descriptors of the tools it runs, for its GET /api/v1/tools.
//
// Specs come from the app's server/descriptors.js; name, summary, keywords and family from the
// gateway's catalogue copy (pure data files, read by path like the rest of apps/_shared); hosts are
// the code defaults (registry/hosts.js). The satellite's own live state decides status: a tool whose
// program is missing on this host (spec.requires, checked by statusOf) is 'unavailable' here first.
// The gateway's registry is the complete one: it adds the owner's domain overrides and every family.
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');
const path = require('path');
const { compose, summaryOf } = require('./descriptor');

const REGISTRY = path.join(__dirname, '..', '..', 'gateway', 'server', 'registry');
const { SATELLITE_COPY } = require(path.join(REGISTRY, 'copy-satellites'));
const { FAMILIES } = require(path.join(REGISTRY, 'families'));
const { defaultHosts } = require(path.join(REGISTRY, 'hosts'));

/** Catalogue copy of a satellite tool: { id, family, name, tagline, description, keywords } or null. */
function copyOf(id) {
    return SATELLITE_COPY.find(r => r.id === id) || null;
}

/**
 * @param {object} o
 * @param {object[]} o.specs                 the app's specs (server/descriptors.js)
 * @param {(spec) => object|null} [o.statusOf]  live status: { status, statusReason } or null (the spec's own)
 * @param {number} [o.liveTtlMs]             how long a statusOf answer is kept (default 30 s)
 */
function createLocalRegistry(o) {
    const families = new Map(FAMILIES.map(f => [f.id, f.name]));
    const rows = o.specs.map(spec => {
        const c = copyOf(spec.id);
        if (!c) throw new Error(`tool ${spec.id} has no catalogue copy (apps/gateway/server/registry/copy-satellites.js)`);
        return { spec, c };
    });
    let built = null;
    let live = null, liveAt = 0;
    const ttl = o.liveTtlMs == null ? 30_000 : o.liveTtlMs;

    function snapshot() {
        if (!live || Date.now() - liveAt >= ttl) { live = rows.map(({ spec }) => (o.statusOf && o.statusOf(spec)) || null); liveAt = Date.now(); }
        const sig = JSON.stringify(live);
        if (built && built.sig === sig) return built;
        const tools = rows.map(({ spec, c }, i) => {
            const h = defaultHosts(spec.id);
            return compose(spec, {
                family: c.family, name: c.name, summary: summaryOf(c),
                hosts: [h.canonical, h.short].filter(Boolean),
                ...(live[i] && { status: live[i].status, statusReason: live[i].statusReason }),
            });
        });
        const version = crypto.createHash('sha1').update(JSON.stringify(tools)).digest('hex').slice(0, 16);
        built = {
            sig, version, tools, families, gone: new Map(),
            updatedAt: built && built.version === version ? built.updatedAt : new Date().toISOString(),
            meta: new Map(rows.map(({ spec, c }) => [spec.id, { keywords: c.keywords || [] }])),
        };
        return built;
    }

    return { snapshot };
}

/**
 * statusOf for specs that name programs (spec.requires): unavailable while one of them is missing.
 * @param {(program: string) => boolean} available
 */
function requiresStatus(available) {
    return (spec) => {
        const missing = (spec.requires || []).filter(p => !available(p));
        return missing.length ? { status: 'unavailable', statusReason: `This tool is being set up on the server (it needs ${missing.join(' and ')}) and is not available yet.` } : null;
    };
}

module.exports = { createLocalRegistry, requiresStatus, copyOf };
