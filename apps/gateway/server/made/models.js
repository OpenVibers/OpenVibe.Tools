'use strict';
// ═══════════════════════════════════════════════════════════════
// The models a prompt tool can name (the Make a tool page's picker): OpenVibe.Exchange's public directory
// (GET /api/v1/models, about 700 KB with every offer and source), cut to what the picker shows and kept 10 minutes.
//
//   GET /api/v1/made-tools/models → { models: [{ id, name, provider, in, out, here }], updated_at }
//
// `here` is true for a model OpenVibe runs for anyone (the router has it on); the others run with the person's own
// key for that provider. in/out are US dollars per million tokens, null when the directory has no price. A directory
// that does not answer leaves the last list (or an empty one): the picker still offers Auto.
// ═══════════════════════════════════════════════════════════════

const TTL_MS = 10 * 60 * 1000;
const MAX = 1000;

function slim(m) {
    const p = (m && m.price) || {};
    const num = (v) => (Number.isFinite(Number(v)) && v !== null ? Number(v) : null);
    return {
        id: String(m.id).slice(0, 256),
        name: String(m.name || m.model || m.id).slice(0, 120),
        provider: String(m.provider_name || m.provider || '').slice(0, 120),
        in: num(p.input_per_million),
        out: num(p.output_per_million),
        here: !!m.routing_enabled,
    };
}

function createModelList({ exchangeUrl = 'https://openvibe.exchange', fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
    const base = String(exchangeUrl || '').replace(/\/+$/, '');
    let kept = { at: 0, tried: false, loaded: false, body: { models: [], updated_at: null } };
    let pending = null;

    async function load() {
        const res = await fetchImpl(`${base}/api/v1/models`, { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`Exchange answered ${res.status}`);
        const d = await res.json();
        const all = Array.isArray(d && d.models) ? d.models : [];
        const models = all
            .filter((m) => m && m.id && m.type === 'chat' && m.status === 'available' && !m.retired_at)
            .map(slim)
            .sort((a, b) => (Number(b.here) - Number(a.here)) || ((a.in == null) - (b.in == null)) || ((a.in || 0) - (b.in || 0)) || a.name.localeCompare(b.name))
            .slice(0, MAX);
        kept = { at: now(), tried: true, loaded: true, body: { models, updated_at: new Date(now()).toISOString() } };
        return kept.body;
    }

    async function list() {
        // A list is kept 10 minutes; a directory that did not answer is asked again after a minute (the last list meanwhile).
        if (kept.tried && now() - kept.at < (kept.loaded ? TTL_MS : 60_000)) return kept.body;
        if (!pending) pending = load().catch(() => { kept = { ...kept, at: now(), tried: true }; return kept.body; }).finally(() => { pending = null; });
        return pending;
    }

    return { list };
}

module.exports = { createModelList, slim };
