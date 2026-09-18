'use strict';
// ═══════════════════════════════════════════════════════════════
// The tool registry (docs: OpenVibe.Network/docs/shared-contracts.md §1).
//
// One list of every tool and family on openvibe.tools, each with its hosts:
//   canonical  the host links, sitemaps and rel=canonical use (may be a custom domain)
//   short      the host a person types — serves 200, canonical points at the canonical host
//   aliases    301 → short (or canonical when there is no short)
// Code defaults below ← owner overrides from https://openvibe.network/api/domains (60 s refresh,
// last good copy kept). Anything else under *.openvibe.tools is not a tool: the gateway sends it
// to the index instead of rendering a made-up brand.
// ═══════════════════════════════════════════════════════════════
const { FAMILIES } = require('./families');
const { SATELLITE_COPY } = require('./copy-satellites');
const { CATALOG: SEO } = require('../seo/catalog');

const ZONE = 'openvibe.tools';
const APEX = ZONE;
const DOMAINS_URL = process.env.OV_DOMAINS_URL || 'https://openvibe.network/api/domains';
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// Human-first defaults: the descriptive host is canonical, the one people already type is short.
const HOST_DEFAULTS = {
    yt: { canonical: 'youtube-downloader', short: 'yt', aliases: ['youtube', 'ytdl', 'youtubedownloader', 'youtube-download'] },
};
const FAMILY_ICON = { net: 'dns', dev: 'code' };
const NET_ICONS = { ip: 'ip', myip: 'ip', dns: 'dns', whois: 'whois', ssl: 'ssl', ping: 'ping', traceroute: 'ping' };

/** 'yt' → 'yt.openvibe.tools'; a full hostname is kept as it is. */
const toHost = (h) => { const s = String(h || '').trim().toLowerCase(); return s.includes('.') && HOST_RE.test(s) ? s : `${s}.${ZONE}`; };
const firstSentence = (s, max = 60) => { const t = String(s || '').split(/(?<=[.!?])\s/)[0].replace(/\.$/, ''); return t.length <= max ? t : t.slice(0, max).replace(/\s+\S*$/, ''); };

function baseTools() {
    const out = [];
    for (const rec of SEO.values()) {
        if (rec.hub) continue;
        out.push({
            id: rec.sub, family: rec.family, name: rec.name, tagline: firstSentence(rec.desc), description: rec.about || rec.desc,
            keywords: String(rec.kw || '').split(',').map(k => k.trim()).filter(Boolean),
            icon: (rec.family === 'net' && NET_ICONS[rec.sub]) || (rec.sub.includes('json') ? 'json' : FAMILY_ICON[rec.family]) || 'tools',
        });
    }
    for (const t of SATELLITE_COPY) out.push({ ...t });
    return out;
}

const familyById = new Map(FAMILIES.map(f => [f.id, f]));
let overrides = [];            // [{ tool_id, host, role }]
let overridesAt = 0;
let built = null;              // { tools, families, byHost, updated }

function build() {
    const byHost = new Map();
    const claim = (host, entry) => { if (host && !byHost.has(host)) byHost.set(host, entry); };
    const ov = new Map();      // tool_id → { canonical, short, aliases[] }
    for (const o of overrides) {
        const e = ov.get(o.tool_id) || { aliases: [] }; ov.set(o.tool_id, e);
        if (o.role === 'canonical') e.canonical = o.host; else if (o.role === 'short') e.short = o.host; else e.aliases.push(o.host);
    }
    const hostsFor = (id, def) => {
        const d = def || {}; const o = ov.get(id) || { aliases: [] };
        const canonical = o.canonical || toHost(d.canonical || id);
        let short = o.short || (d.short ? toHost(d.short) : null);
        const aliases = new Set([...(d.aliases || []).map(toHost), ...o.aliases]);
        // A host that lost its role to an override still works: it becomes an alias.
        const defCanon = toHost(d.canonical || id);
        if (o.canonical && defCanon !== canonical) { if (!short) short = defCanon; else aliases.add(defCanon); }
        if (o.short && d.short && toHost(d.short) !== short) aliases.add(toHost(d.short));
        if (short === canonical) short = null;
        aliases.delete(canonical); if (short) aliases.delete(short);
        return { canonical, short, aliases: [...aliases] };
    };

    const tools = baseTools().map(t => {
        const fam = familyById.get(t.family);
        const hosts = hostsFor(t.id, HOST_DEFAULTS[t.id]);
        const external = t.id === 'pastes' ? 'https://openvibe.community/pastes' : null;
        return { ...t, hosts, url: external || `https://${hosts.canonical}/`, port: fam ? fam.port : null, external };
    });
    const families = FAMILIES.map(f => {
        const hosts = f.hub ? hostsFor(f.id, { canonical: f.hub, aliases: f.hubAliases }) : null;
        return { ...f, hosts, url: f.external || (hosts ? `https://${hosts.canonical}/` : `https://${APEX}${f.path}`), page: f.path ? `https://${APEX}${f.path}` : null };
    });
    for (const list of [tools, families]) for (const x of list) {
        if (!x.hosts || x.external) continue;
        const kind = list === tools ? 'tool' : 'family';
        claim(x.hosts.canonical, { kind, role: 'canonical', item: x });
        claim(x.hosts.short, { kind, role: 'short', item: x });
        x.hosts.aliases.forEach(a => claim(a, { kind, role: 'alias', item: x }));
    }
    built = { tools, families, byHost, updated: new Date().toISOString() };
    return built;
}

function get() { return built || build(); }

/** What is this host? → { kind: 'apex'|'tool'|'family'|'unknown', role, item, tool, canonicalHost, shortHost, port, inZone } */
function resolveHost(hostname) {
    const host = String(hostname || '').toLowerCase().replace(/:\d+$/, '').replace(/^www\./, '');
    if (host === APEX) return { kind: 'apex', host };
    const hit = get().byHost.get(host);
    const inZone = host.endsWith('.' + ZONE);
    if (!hit) return { kind: 'unknown', host, inZone };
    const h = hit.item.hosts;
    return { kind: hit.kind, role: hit.role, item: hit.item, tool: hit.item.id, host, inZone, canonicalHost: h.canonical, shortHost: h.short || h.canonical, port: hit.item.port || null };
}

/** The public catalog (GET /api/catalog.json). */
function catalog() {
    const r = get();
    return {
        updated: r.updated,
        families: r.families.map(f => ({ id: f.id, name: f.name, tagline: f.tagline, description: f.description, icon: f.icon, url: f.url, path: f.path, page: f.page, count: r.tools.filter(t => t.family === f.id).length })),
        tools: r.tools.map(t => ({ id: t.id, family: t.family, name: t.name, tagline: t.tagline, description: t.description, keywords: t.keywords, icon: t.icon, hosts: t.hosts, url: t.url, page: `https://${APEX}/tool/${t.id}` })),
    };
}

function setOverrides(rows) {
    const known = new Set([...baseTools().map(t => t.id), ...FAMILIES.map(f => f.id)]);
    const seen = new Set();
    overrides = (Array.isArray(rows) ? rows : []).filter(o => o && known.has(o.tool_id) && HOST_RE.test(String(o.host || '')) && ['canonical', 'short', 'alias'].includes(o.role) && o.host !== APEX && !seen.has(o.host) && seen.add(o.host))
        .map(o => ({ tool_id: o.tool_id, host: String(o.host).toLowerCase(), role: o.role }));
    build();
}

async function refresh(fetchImpl = fetch) {
    try {
        const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 4000);
        const r = await fetchImpl(DOMAINS_URL, { signal: ac.signal, headers: { accept: 'application/json' } }); clearTimeout(t);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        const next = JSON.stringify(j.domains || []);
        if (next !== JSON.stringify(overrides.map(o => ({ tool_id: o.tool_id, host: o.host, role: o.role }))) || !overridesAt) setOverrides(j.domains || []);
        overridesAt = Date.now();
        return true;
    } catch { return false; /* keep the last good copy */ }
}

function start() { refresh(); const t = setInterval(refresh, 60_000); t.unref(); return t; }

module.exports = { get, catalog, resolveHost, setOverrides, refresh, start, ZONE, APEX, FAMILIES };
