'use strict';
/**
 * Tools → OpenVibe.Search (platform S9): every tool in the registry is one Search document
 * (search.index-document@1, owner tools, type tool, id = the tool id), written through Search's owner
 * API with the tools service token (search.document.write on openvibe.search). A tool that leaves the
 * registry, or becomes unavailable on this host, is tombstoned.
 *
 * Runs a minute after boot and every 6 hours. Search's own inventory (GET /api/v1/owners/tools/documents)
 * gives the stored revisions; a document is re-sent, one revision up, only when its content hash
 * differs from the last one sent (data/search-index.json), so a quiet registry costs one listing.
 *
 * Off unless SEARCH_URL and OV_OAUTH_CLIENT_SECRET are set (TOOLS_SEARCH_INDEX=off disables it).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OWNER = 'tools';
const TYPE = 'tool';
const EVERY_MS = 6 * 60 * 60 * 1000;

/** A descriptor → the document body (identity and revision added by the caller). */
function documentFor(t, updatedAt) {
    const host = Array.isArray(t.hosts) && t.hosts[0];
    return {
        visibility: 'public',
        canonical_url: host ? `https://${host}` : t.docs || `https://openvibe.tools/tool/${t.id}`,
        title: String(t.name || t.id).slice(0, 500),
        summary: String(t.summary || '').slice(0, 4000),
        body: [t.name, t.summary, ...(Array.isArray(t.keywords) ? t.keywords : [])].filter(Boolean).join('\n').slice(0, 48000),
        facets: { family: String(t.family || 'other'), execution: String(t.execution || 'client'), api: Boolean(t.api) },
        language: 'en',
        authorship: 'human',
        publication_state: 'published',
        ...(updatedAt ? { updated_at: updatedAt } : {}),
        indexability: { decision: 'index', reasons: [] },
    };
}
const hashOf = (doc) => crypto.createHash('sha256').update(JSON.stringify(doc)).digest('hex');

function createSearchIndexer({ snapshot, searchUrl, tokens, stateFile, fetchImpl = globalThis.fetch, log = console, now = () => Date.now() }) {
    const base = String(searchUrl).replace(/\/+$/, '');
    const stats = { runs: 0, upserted: 0, deleted: 0, unchanged: 0, failed: 0, last_run_at: null, last_error: null };
    let state = {};
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')).docs || {}; } catch { state = {}; }
    const save = () => {
        try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify({ docs: state })); fs.renameSync(`${stateFile}.tmp`, stateFile); } catch (err) { log.warn('[SearchIndex] state not saved:', err.message); }
    };
    async function call(method, p, body) {
        const res = await fetchImpl(`${base}${p}`, { method, headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(await tokens.authHeaders()) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
        const json = await res.json().catch(() => ({}));
        if (res.status === 401 && tokens.invalidate) tokens.invalidate();
        return { status: res.status, ok: res.ok, body: json };
    }
    async function remoteDocs() {
        const out = new Map();
        let after = 0;
        for (let i = 0; i < 50; i++) {
            const r = await call('GET', `/api/v1/owners/${OWNER}/documents?type=${TYPE}&limit=1000&after=${after}`);
            if (!r.ok) throw new Error(`listing: ${r.status} ${r.body.code || ''}`);
            for (const d of r.body.documents || []) out.set(d.id, d);
            if (!r.body.next_after) break;
            after = r.body.next_after;
        }
        return out;
    }

    async function run() {
        stats.runs++; stats.last_run_at = new Date(now()).toISOString();
        const snap = snapshot();
        const tools = (snap.tools || []).filter((t) => t.status !== 'unavailable' && /^[a-z][a-z0-9-]{0,39}$/.test(t.id));
        const remote = await remoteDocs();
        const keep = new Set();
        for (const t of tools) {
            keep.add(t.id);
            const doc = documentFor(t, snap.updated_at || null);
            const h = hashOf(doc);
            const r = remote.get(t.id);
            if (r && !r.deleted && state[t.id] && state[t.id].hash === h) { stats.unchanged++; continue; }
            const revision = r ? r.revision + 1 : 1;
            const res = await call('PUT', `/api/v1/documents/${OWNER}/${TYPE}/${t.id}`, { ...doc, revision });
            if (res.ok) { state[t.id] = { hash: h, revision }; stats.upserted++; } else { stats.failed++; stats.last_error = `${t.id}: ${res.status} ${res.body.code || ''}`; }
        }
        for (const [id, r] of remote) {
            if (keep.has(id) || r.deleted) continue;
            const res = await call('DELETE', `/api/v1/documents/${OWNER}/${TYPE}/${encodeURIComponent(id)}?revision=${r.revision + 1}`);
            if (res.ok) { delete state[id]; stats.deleted++; } else { stats.failed++; stats.last_error = `${id}: ${res.status} ${res.body.code || ''}`; }
        }
        save();
        return { ...stats };
    }

    let timer = null;
    function start({ firstDelayMs = 60_000 } = {}) {
        const tick = () => run().catch((err) => { stats.failed++; stats.last_error = err.message; log.warn('[SearchIndex] run failed:', err.message); });
        const first = setTimeout(tick, firstDelayMs); if (first.unref) first.unref();
        timer = setInterval(tick, EVERY_MS); if (timer.unref) timer.unref();
    }
    function stop() { if (timer) clearInterval(timer); timer = null; }
    return { run, start, stop, stats: () => ({ ...stats }) };
}

/** The gateway's indexer from its environment, or null (with why) when it is off. */
function searchIndexerFromEnv({ snapshot, dataDir, env = process.env, contracts = require('openvibe-contracts'), log = console }) {
    const url = String(env.SEARCH_URL || '').trim();
    if (!url) return { indexer: null, reason: 'SEARCH_URL is not set' };
    if (String(env.TOOLS_SEARCH_INDEX || '').toLowerCase() === 'off') return { indexer: null, reason: 'TOOLS_SEARCH_INDEX=off' };
    if (!env.OV_OAUTH_CLIENT_SECRET) return { indexer: null, reason: 'OV_OAUTH_CLIENT_SECRET is not set' };
    const network = String(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
    const tokens = contracts.serviceAuth.createTokenClient({ tokenUrl: `${network}/oauth/token`, clientId: env.OV_OAUTH_CLIENT_ID || 'tools', clientSecret: env.OV_OAUTH_CLIENT_SECRET, audience: 'openvibe.search', scope: 'search.document.write' });
    return { indexer: createSearchIndexer({ snapshot, searchUrl: url, tokens, stateFile: path.join(dataDir, 'search-index.json'), log }) };
}

module.exports = { createSearchIndexer, searchIndexerFromEnv, documentFor };
