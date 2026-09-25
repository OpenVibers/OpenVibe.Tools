'use strict';
// ═══════════════════════════════════════════════════════════════
// tools.usage (platform S9): a signed-in person's recently used tools, kept in their Network user
// module `tools.usage` ({ recent: [{ tool, at }] }, newest first, 30 at most; openvibe-contracts
// manifests/namespaces/tools.usage.json) for the launchers across the network. Since v2 (contracts
// 0.41.0) it also holds `favorites` (tool ids, 24 at most), which the person stars here or on
// my.openvibe.network; every write keeps the fields it did not change.
//
//   app.use(usagePages({ snapshot: toolRegistry.snapshot }))   after guard.identify: a page view of
//                                                                a tool by a signed-in person counts
//   recorder().record(subjectId, toolId)                        e.g. a run API call by a person
//   recorder().recent(subjectId), recentFromCookie(req)          what the launcher shows
//
// Everyone's page views (signed in or not) also go into the ov_recent_tools cookie on .openvibe.tools:
// the launcher's anonymous history.
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
const FAV_MAX = 24;
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
        // Keep the record's other fields (favorites, which the person writes too: tools.usage v2).
        const rest = cur.status === 200 && cur.body && cur.body.data && typeof cur.body.data === 'object' ? cur.body.data : {};
        const w = await call('PUT', subject, { body: { data: { ...rest, recent } }, revision: cur.status === 200 ? cur.body.revision : 0 });
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

    /** The person's recent tools (the module, with anything not yet flushed on top): [{ tool, at }]. */
    async function recent(subject) {
        if (!enabled || !USR_RE.test(String(subject || ''))) return [];
        const cur = await call('GET', subject);
        const had = cur.status === 200 && cur.body && cur.body.data && Array.isArray(cur.body.data.recent) ? cur.body.data.recent : [];
        const fresh = pending.get(subject);
        const top = fresh ? [...fresh].reverse().map(([tool, at]) => ({ tool, at })) : [];
        return [...top, ...had.filter((e) => e && (!fresh || !fresh.has(e.tool)))].slice(0, MAX);
    }

    /** The person's favourite tools (tools.usage v2 `favorites`, newest first): [toolId]. */
    async function favorites(subject) {
        if (!enabled || !USR_RE.test(String(subject || ''))) return [];
        const cur = await call('GET', subject);
        const fav = cur.status === 200 && cur.body && cur.body.data && Array.isArray(cur.body.data.favorites) ? cur.body.data.favorites : [];
        return fav.filter((id) => TOOL_RE.test(String(id)));
    }

    /** Star (on) or unstar a tool: a read-modify-write naming the revision read; a 412 reads again. → favorites */
    async function setFavorite(subject, tool, on) {
        if (!TOOL_RE.test(String(tool || ''))) throw Object.assign(new Error('bad subject or tool'), { status: 400 });
        return changeFavorites(subject, (had) => (on ? [tool, ...had.filter((id) => id !== tool)] : had.filter((id) => id !== tool)));
    }

    /** Add tools a browser starred as a guest after the account's own favourites (sign-in). → favorites */
    async function addFavorites(subject, tools) {
        const add = (tools || []).filter((id) => TOOL_RE.test(String(id)));
        return changeFavorites(subject, (had) => [...had, ...add.filter((id) => !had.includes(id))]);
    }

    async function changeFavorites(subject, change) {
        if (!enabled) throw Object.assign(new Error('favourites are off on this server'), { status: 503 });
        if (!USR_RE.test(String(subject || ''))) throw Object.assign(new Error('bad subject or tool'), { status: 400 });
        for (let attempt = 0; attempt < 3; attempt++) {
            const cur = await call('GET', subject);
            if (cur.status !== 200 && cur.status !== 404) throw Object.assign(new Error(`read: ${cur.status}`), { status: 503 });
            const data = cur.status === 200 && cur.body && cur.body.data && typeof cur.body.data === 'object' ? cur.body.data : {};
            const had = Array.isArray(data.favorites) ? data.favorites : [];
            const next = change(had).slice(0, FAV_MAX);
            if (JSON.stringify(next) === JSON.stringify(had)) return had;
            const w = await call('PUT', subject, { body: { data: { ...data, favorites: next } }, revision: cur.status === 200 ? cur.body.revision : 0 });
            if (w.status === 412) { stats.conflicts++; continue; }
            if (w.status >= 300) throw Object.assign(new Error(`write: ${w.status} ${(w.body && w.body.code) || ''}`), { status: 503 });
            return next;
        }
        throw Object.assign(new Error('your favourites kept changing; try again'), { status: 409 });
    }

    return { enabled, record, recent, favorites, setFavorite, addFavorites, flush, stop, stats: () => ({ enabled, pending: pending.size, ...stats }) };
}

// Anonymous history: the same list, per browser, in a first-party cookie on the tools zone, so every
// tool host (each its own origin) adds to one list without any page script.
const COOKIE = 'ov_recent_tools';
const COOKIE_MAX = 12;
function recentFromCookie(req) {
    const m = String((req.headers && req.headers.cookie) || '').match(/(?:^|;\s*)ov_recent_tools=([^;]*)/);
    if (!m) return [];
    let v = ''; try { v = decodeURIComponent(m[1]); } catch { return []; }
    return [...new Set(v.split('.').filter((id) => TOOL_RE.test(id)))].slice(0, COOKIE_MAX);
}
function rememberInCookie(req, res, tool, host) {
    if (!res || typeof res.append !== 'function' || !/(^|\.)openvibe\.tools$/.test(host)) return;
    const list = [tool, ...recentFromCookie(req).filter((id) => id !== tool)].slice(0, COOKIE_MAX);
    res.append('Set-Cookie', `${COOKIE}=${list.join('.')}; Domain=.openvibe.tools; Path=/; Max-Age=${180 * 24 * 3600}; SameSite=Lax; Secure`);
}

// Anonymous favourites (roadmap WS-L task 1): the tools a browser starred without an account, in a
// first-party cookie on the tools zone like its history (24 at most, newest first). When the person
// signs in they join the account's favourites once, and the cookie is cleared.
const FAV_COOKIE = 'ov_tool_favs';
function favoritesFromCookie(req) {
    const m = new RegExp(`(?:^|;\\s*)${FAV_COOKIE}=([^;]*)`).exec(String((req.headers && req.headers.cookie) || ''));
    if (!m) return [];
    let v = ''; try { v = decodeURIComponent(m[1]); } catch { return []; }
    return [...new Set(v.split('.').filter((id) => TOOL_RE.test(id)))].slice(0, FAV_MAX);
}
function writeFavoritesCookie(res, list, host) {
    const domain = /(^|\.)openvibe\.tools$/.test(String(host || '')) ? '; Domain=.openvibe.tools' : '';
    res.append('Set-Cookie', list.length
        ? `${FAV_COOKIE}=${list.slice(0, FAV_MAX).join('.')}${domain}; Path=/; Max-Age=${365 * 24 * 3600}; SameSite=Lax; Secure`
        : `${FAV_COOKIE}=${domain}; Path=/; Max-Age=0; SameSite=Lax; Secure`);
}
/** Star or unstar a tool for this browser. → favorites (newest first) */
function setCookieFavorite(req, res, tool, on, host) {
    const had = favoritesFromCookie(req);
    const next = on ? [tool, ...had.filter((id) => id !== tool)].slice(0, FAV_MAX) : had.filter((id) => id !== tool);
    writeFavoritesCookie(res, next, host);
    return next;
}
/** Signed in with guest favourites in the cookie: add them to the account's, then clear the cookie. → favorites | null */
async function mergeGuestFavorites(req, res, subject, host, rec = recorder()) {
    const guest = favoritesFromCookie(req);
    if (!guest.length || !subject || !rec.enabled) return null;
    const merged = await rec.addFavorites(subject, guest);
    writeFavoritesCookie(res, [], host);
    return merged;
}

let _recorder = null;
function recorder() { if (!_recorder) _recorder = createRecorder(); return _recorder; }

const MERGED_COOKIE = 'ov_recent_merged';
/**
 * Guest conversion (roadmap WS-B task 8): tools this browser used before the person signed in join
 * their account's list, once per account and browser (a marker cookie names the subject merged).
 * Returns the tools added (newest first); records them through the recorder.
 */
function mergeGuestTools(req, res, subject, accountRecent, fromCookie, rec = recorder()) {
    if (!subject || !rec.enabled || !fromCookie.length) return [];
    const raw = String(req.headers.cookie || '');
    const m = new RegExp(`(?:^|;\\s*)${MERGED_COOKIE}=([^;]*)`).exec(raw);
    if (m && decodeURIComponent(m[1]) === subject) return [];
    const have = new Set((accountRecent || []).map((e) => e && e.tool));
    const add = fromCookie.filter((t) => !have.has(t));
    for (const tool of [...add].reverse()) rec.record(subject, tool);
    res.append('Set-Cookie', `${MERGED_COOKIE}=${encodeURIComponent(subject)}; Domain=.openvibe.tools; Path=/; Max-Age=${365 * 24 * 3600}; SameSite=Lax; Secure; HttpOnly`);
    return add;
}

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
    return function toolUsage(req, res, next) {
        try {
            if (req.method === 'GET' && !req.path.startsWith('/api/') && !/\.[a-z0-9]{1,8}$/i.test(req.path)) {
                const dest = req.get('sec-fetch-dest');
                if (dest ? dest === 'document' : /text\/html/.test(req.get('accept') || '')) {
                    const host = String(req.hostname || '').toLowerCase();
                    const m = hostMap();
                    const named = String(req.get('x-ov-tool') || '');
                    const tool = m.get(host) || (m.ids.has(named) ? named : null);
                    if (tool) {
                        rememberInCookie(req, res, tool, host);
                        const sid = req.user && req.user.subject_id;
                        const r = rec || recorder();
                        if (sid && r.enabled) r.record(sid, tool);
                    }
                }
            }
        } catch { /* usage is best-effort */ }
        next();
    };
}

module.exports = { createRecorder, recorder, usagePages, recentFromCookie, mergeGuestTools, favoritesFromCookie, setCookieFavorite, mergeGuestFavorites, NS, COOKIE, MERGED_COOKIE, FAV_COOKIE };
