'use strict';
// ═══════════════════════════════════════════════════════════════
// Where the other OpenVibe services are — from OpenVibe.Network's registry
// (GET /api/v1/registry/services, roadmap Wave 2), not from knowledge written into this gateway.
//
// The registry answers with every service manifest (id, name, status, publicOrigin, domains) plus a
// health reading. It is fetched on boot and every 10 minutes; the last good answer is kept, and until
// one arrives (or when Network is unreachable) the small local list below is used and the catalog
// says so (`services.source: 'fallback'`). Placeholder and retired services are never linked.
// ═══════════════════════════════════════════════════════════════

const REFRESH_MS = 10 * 60 * 1000;
const LINKABLE = new Set(['alpha', 'beta', 'stable', 'degraded']);
const ORIGIN_RE = /^https:\/\/[a-z0-9.-]+$/;

// Used only until the registry answers, or when it cannot be reached.
const FALLBACK = [
    { id: 'network', name: 'OpenVibe.Network', status: 'stable', origin: 'https://openvibe.network' },
    { id: 'live', name: 'OpenVibe.Live', status: 'stable', origin: 'https://openvibe.live' },
    { id: 'community', name: 'OpenVibe.Community', status: 'alpha', origin: 'https://openvibe.community' },
    { id: 'games', name: 'OpenVibe.Games', status: 'stable', origin: 'https://openvibe.games' },
    { id: 'media', name: 'OpenVibe.Media', status: 'beta', origin: 'https://openvibe.media' },
    { id: 'tools', name: 'OpenVibe.Tools', status: 'stable', origin: 'https://openvibe.tools' },
];

/** The registry as the public knows it (named in the catalog; the fetch itself may go to the internal URL). */
function publicRegistryUrl(env = process.env) {
    return `${(env.OV_NETWORK_URL || 'https://openvibe.network').replace(/\/+$/, '')}/api/v1/registry/services`;
}

function registryUrl(env = process.env) {
    if (env.OV_REGISTRY_URL) return env.OV_REGISTRY_URL;
    const base = (env.OV_NETWORK_INTERNAL_URL || env.OV_NETWORK_URL || 'https://openvibe.network').replace(/\/+$/, '');
    return `${base}/api/v1/registry/services`;
}

/**
 * @param {object} [o]
 * @param {string} [o.url]
 * @param {Function} [o.fetchImpl]
 * @param {Function} [o.onChange]   called after the list changes (the catalog rebuilds)
 */
function createServiceDirectory(o = {}) {
    const url = o.url || registryUrl();
    const fetchImpl = o.fetchImpl || ((...a) => globalThis.fetch(...a));
    let state = { source: 'fallback', as_of: null, error: null, services: FALLBACK.map(s => ({ ...s })) };
    let timer = null;

    function normalise(list) {
        const out = [];
        for (const m of Array.isArray(list) ? list : []) {
            if (!m || typeof m.id !== 'string' || !/^[a-z][a-z0-9-]{1,39}$/.test(m.id)) continue;
            const origin = String(m.publicOrigin || '').replace(/\/+$/, '');
            out.push({
                id: m.id,
                name: typeof m.name === 'string' ? m.name.slice(0, 80) : m.id,
                status: typeof m.status === 'string' ? m.status : 'unknown',
                origin: ORIGIN_RE.test(origin) ? origin : null,
            });
        }
        return out;
    }

    /** One fetch; keeps the last good list on any failure. → true when the registry answered. */
    async function refresh() {
        try {
            const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(4000) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const body = await res.json();
            const services = normalise(body && body.services);
            if (!services.length) throw new Error('empty service list');
            const changed = JSON.stringify(services.map(s => [s.id, s.name, s.status, s.origin])) !== JSON.stringify(state.services.map(s => [s.id, s.name, s.status, s.origin])) || state.source !== 'registry';
            // as_of moves only when the list does, so cached pages and catalog.json stay stable between changes.
            state = { source: 'registry', as_of: changed ? new Date().toISOString() : state.as_of, error: null, checked_at: Date.now(), services };
            if (changed && o.onChange) o.onChange();
            return true;
        } catch (err) {
            state = { ...state, error: err.message };
            return false;
        }
    }

    const get = (id) => state.services.find(s => s.id === id) || null;
    /** The public origin of a service, or `fallback` when the registry has none for it. */
    function origin(id, fallback = null) {
        const s = get(id);
        if (s && s.origin) return s.origin;
        const f = FALLBACK.find(x => x.id === id);
        return (f && f.origin) || fallback;
    }
    /** Services that may be linked as working products (not placeholders, not retired). */
    const linkable = () => state.services.filter(s => s.origin && LINKABLE.has(s.status));

    /** For catalog.json: where the list came from, and the linkable-or-not facts about each service. */
    function snapshot() {
        return {
            source: state.source,
            registry: o.publicUrl || publicRegistryUrl(),
            as_of: state.as_of,
            services: state.services.filter(s => s.origin).map(s => ({ id: s.id, name: s.name, status: s.status, origin: s.origin })),
        };
    }
    /** For health checks: the last fetch's outcome. */
    const status = () => ({ source: state.source, as_of: state.as_of, last_ok: state.checked_at ? new Date(state.checked_at).toISOString() : null, last_error: state.error });

    function start() {
        if (timer) return;
        refresh();
        timer = setInterval(refresh, o.refreshMs || REFRESH_MS);
        if (timer.unref) timer.unref();
    }
    function stop() { if (timer) clearInterval(timer); timer = null; }

    return { refresh, origin, get, linkable, snapshot, status, start, stop, url };
}

module.exports = { createServiceDirectory, registryUrl, publicRegistryUrl, FALLBACK };
