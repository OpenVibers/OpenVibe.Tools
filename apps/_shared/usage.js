'use strict';
// ═══════════════════════════════════════════════════════════════
// tools.usage (platform S9): a signed-in person's recently used tools, kept in their Network user
// module `tools.usage` ({ recent: [{ tool, at }] }, newest first, 30 at most; openvibe-contracts
// manifests/namespaces/tools.usage.json) for the launchers across the network.
//
//   app.use(usagePages({ snapshot: toolRegistry.snapshot }))   after guard.identify: a page view of
//                                                                a tool by a signed-in person counts
//   recorder().record(subjectId, toolId)                        e.g. a run API call by a person
//
// Cheap by design: a person counts once per tool per 10 minutes, and a process flushes what it
// gathered every minute: per person one read and one conditional write (If-Match), merged with what
// the module already holds (other satellites write it too; a 412 keeps the entry for the next flush).
// Tools' service token (network.modules.read/write for tools.usage) is fetched here without
// dependencies, so every satellite can use it. Off unless OV_OAUTH_CLIENT_SECRET is set
// (TOOLS_USAGE=off disables it). No dependencies: required by relative path.
// ═══════════════════════════════════════════════════════════════

const NS = 'tools.usage';
const MAX = 30;
const SAME_TOOL_MS = 10 * 60 * 1000;
const FLUSH_MS = 60 * 1000;
const MAX_PENDING = 2000;
const USR_RE = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const TOOL_RE = /^[a-z][a-z0-9-]{0,39}$/;

function createRecorder({ env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console, flushMs = FLUSH_MS } = {}) {
    const network = String(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
    const secret = env.OV_OAUTH_CLIENT_SECRET || '';
    const enabled = !!secret && String(env.TOOLS_USAGE || '').toLowerCase() !== 'off';
    const pending = new Map();      // subject -> Map(tool -> at ISO)
    const seen = new Map();         // `${subject}|${tool}` -> ms
    const stats = { recorded: 0, written: 0, conflicts: 0, failed: 0, last_error: null };
    let token = null, tokenExp = 0, timer = null;

    async function bearer() {
        if (token && now() < tokenExp) return token;
        const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: env.OV_OAUTH_CLIENT_ID || 'tools', client_secret: secret, audience: 'openvibe.network' });
        const r = await fetchImpl(`${network}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body, signal: AbortSignal.timeout(10000) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.access_token) throw new Error(`token: ${r.status} ${j.error || ''}`);
        token = j.access_token; tokenExp = now() + Math.max(30, (Number(j.expires_in) || 300) - 60) * 1000;
        return token;
    }
    async function call(method, subject, { body, revision } = {}) {
        const headers = { Accept: 'application/json', Authorization: `Bearer ${await bearer()}` };
        if (body) headers['Content-Type'] = 'application/json';
        if (revision != null) headers['If-Match'] = `"${revision}"`;
        const r = await fetchImpl(`${network}/internal/modules/${NS}/${subject}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
        if (r.status === 401) token = null;
        return { status: r.status, body: await r.json().catch(() => ({})) };
    }

    function record(subject, tool) {
        if (!enabled || !USR_RE.test(String(subject || '')) || !TOOL_RE.test(String(tool || ''))) return false;
        const k = `${subject}|${tool}`, t = now();
        if (seen.has(k) && t - seen.get(k) < SAME_TOOL_MS) return false;
        if (seen.size > 20000) seen.clear();
        seen.set(k, t);
        if (!pending.has(subject) && pending.size >= MAX_PENDING) return false;
        if (!pending.has(subject)) pending.set(subject, new Map());
        const p = pending.get(subject);
        p.delete(tool); p.set(tool, new Date(t).toISOString());
        stats.recorded++;
        start();
        return true;
    }

    async function flushOne(subject, fresh) {
        const cur = await call('GET', subject);
        if (cur.status !== 200 && cur.status !== 404) throw new Error(`read: ${cur.status}`);
        const had = cur.status === 200 && cur.body && cur.body.data && Array.isArray(cur.body.data.recent) ? cur.body.data.recent : [];
        const add = [...fresh].reverse().map(([tool, at]) => ({ tool, at }));
        const recent = [...add, ...had.filter((e) => e && !fresh.has(e.tool))].slice(0, MAX);
        const w = await call('PUT', subject, { body: { data: { recent } }, revision: cur.status === 200 ? cur.body.revision : undefined });
        if (w.status === 412 || w.status === 409) { stats.conflicts++; return false; }
        if (w.status >= 300) throw new Error(`write: ${w.status} ${(w.body && w.body.code) || ''}`);
        stats.written++;
        return true;
    }

    async function flush() {
        const batch = [...pending];
        pending.clear();
        for (const [subject, fresh] of batch) {
            let ok = false;
            try { ok = await flushOne(subject, fresh); } catch (err) { stats.failed++; stats.last_error = err.message; }
            if (!ok && pending.size < MAX_PENDING) {
                const back = pending.get(subject) || new Map();
                for (const [tool, at] of fresh) if (!back.has(tool)) back.set(tool, at);
                pending.set(subject, back);
            }
        }
        if (!pending.size) stop();
    }
    function start() { if (timer || !enabled) return; timer = setInterval(() => { flush().catch(() => {}); }, flushMs); if (timer.unref) timer.unref(); }
    function stop() { if (timer) clearInterval(timer); timer = null; }

    return { enabled, record, flush, stop, stats: () => ({ enabled, pending: pending.size, ...stats }) };
}

let _recorder = null;
function recorder() { if (!_recorder) _recorder = createRecorder(); return _recorder; }

/**
 * Middleware: a GET of a tool's page by a signed-in person (req.user.subject_id from guard.identify)
 * records that tool. The host names the tool (the registry's hosts, or the X-OV-Tool the gateway sends).
 */
function usagePages({ snapshot, rec = null }) {
    let map = null, mapFor = null;
    const hostMap = () => {
        const s = snapshot();
        if (map && mapFor === s) return map;
        map = new Map();
        for (const t of s.tools || []) for (const h of t.hosts || []) map.set(String(h).toLowerCase(), t.id);
        map.ids = new Set((s.tools || []).map((t) => t.id));
        mapFor = s;
        return map;
    };
    return function toolUsage(req, _res, next) {
        try {
            const sid = req.user && req.user.subject_id;
            const r = rec || recorder();
            if (sid && r.enabled && req.method === 'GET' && !req.path.startsWith('/api/') && !/\.[a-z0-9]{1,8}$/i.test(req.path)) {
                const dest = req.get('sec-fetch-dest');
                if (dest ? dest === 'document' : /text\/html/.test(req.get('accept') || '')) {
                    const host = String(req.hostname || '').toLowerCase();
                    const m = hostMap();
                    const named = String(req.get('x-ov-tool') || '');
                    const tool = m.get(host) || (m.ids.has(named) ? named : null);
                    if (tool) r.record(sid, tool);
                }
            }
        } catch { /* usage is best-effort */ }
        next();
    };
}

module.exports = { createRecorder, recorder, usagePages, NS };
