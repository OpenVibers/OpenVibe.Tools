'use strict';
// ═══════════════════════════════════════════════════════════════
// openvibe.tools, server-rendered from the registry.
//   /                 index: search, families, popular tools
//   /<family-path>    one family: every tool, intro, FAQ
//   /tool/<id>        one tool: what it does, where it lives (primary host + mirrors), related
//   /all-tools        A–Z
//   /search?q=        results (works as a plain form; JS only makes it instant)
//   /sitemap.xml /robots.txt /llms.txt /api/catalog.json
// Every page is complete HTML without JavaScript. Pages are rendered once per registry version
// and served from memory with an ETag.
// ═══════════════════════════════════════════════════════════════
const crypto = require('crypto');
const frame = require('openvibe-shared/frame');
const ovServe = require('openvibe-shared/serve');
const express = require('express');
const seo = require('openvibe-shared/seo');
const icons = require('openvibe-shared/icons');
const appIcon = require('openvibe-shared/app-icon');
const registry = require('../registry');

const SITE = 'https://openvibe.tools';
const NAME = 'OpenVibe.Tools';
const esc = seo.esc;
const POPULAR = ['yt', 'convert', 'compress', 'mergepdf', 'jsonfmt', 'mp3', 'dns', 'whois', 'fancy', 'logo', 'ssl', 'resize', 'trim', 'regex', 'maps', 'food'];

let _used = new Set();
const icon = (name, size) => { _used.add(name); return icons.use(name, size); };
const hostLabel = (h) => h.replace(/\.openvibe\.tools$/, '') === h ? h : h;

// Links name the search-friendly host (what crawlers follow and index). A person's click goes straight to
// the easy address instead of bouncing through a redirect: site.js reads data-go.
const go = (t) => (t.hosts && t.hosts.short && !t.external ? ` data-go="https://${esc(t.hosts.short)}/"` : '');

function toolCard(t) {
    return `<a class="tool" href="${esc(t.url)}"${go(t)} data-k="${esc([t.name, t.tagline, ...(t.keywords || [])].join(' ').toLowerCase())}">
        ${icon(t.icon, 36)}<span class="tool-t"><b>${esc(t.name)}</b><small>${esc(t.tagline)}</small><i>${esc(hostLabel(t.hosts.short || t.hosts.canonical))}</i></span></a>`;
}

const CSS = `
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg-primary,#0a0f18);color:var(--text-primary,#e6edf7);font:400 16px/1.55 Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
a{color:var(--accent-light,var(--accent,#60a5fa))}
.wrap{max-width:1180px;margin:0 auto;padding:0 20px}
pre{max-width:100%;overflow-x:auto}pre:focus-visible{outline:2px solid var(--accent,#3b82f6);outline-offset:2px}
.topbar{display:flex;align-items:center;gap:14px;padding:12px 20px;border-bottom:1px solid var(--border,rgba(255,255,255,.08))}
.topbar a{color:inherit;text-decoration:none;font-weight:700}.topbar nav{display:flex;gap:14px;margin-left:auto;font-size:14px;flex-wrap:wrap}.topbar nav a{font-weight:500;color:var(--text-secondary,#a8b3c4)}
.hero{padding:clamp(28px,6vw,64px) 0 8px;text-align:center}
.hero h1{font-size:clamp(30px,5.2vw,52px);line-height:1.08;letter-spacing:-.03em;margin:0 0 12px;font-weight:800}
.hero h1 span{color:var(--accent-light,var(--accent,#60a5fa))}
.hero p{max-width:680px;margin:0 auto 22px;color:var(--text-secondary,#a8b3c4);font-size:clamp(15px,1.6vw,18px)}
.search{display:flex;max-width:640px;margin:0 auto;background:var(--bg-secondary,#111826);border:1px solid var(--border,rgba(255,255,255,.12));border-radius:14px;padding:5px;gap:4px}
.search:focus-within{border-color:var(--accent,#3b82f6);box-shadow:0 0 0 4px var(--accent-glow,rgba(59,130,246,.18))}
.search input{flex:1;min-width:0;background:none;border:0;outline:0;color:inherit;font:inherit;padding:10px 12px}
.search button{border:0;border-radius:10px;background:var(--accent-strong,#1d4ed8);color:var(--on-accent-strong,#fff);font:700 14px/1 inherit;padding:0 18px;cursor:pointer}
.chips{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin:18px auto 0;max-width:820px;padding:0;list-style:none}
.chips a{display:inline-flex;align-items:center;gap:7px;padding:6px 12px 6px 7px;border-radius:999px;border:1px solid var(--border,rgba(255,255,255,.1));text-decoration:none;color:var(--text-primary,#e6edf7);font-size:13.5px;font-weight:600}
.chips a:hover{border-color:var(--accent,#3b82f6)}
h2{font-size:clamp(20px,2.4vw,26px);letter-spacing:-.02em;margin:0}
section{padding:clamp(24px,4vw,44px) 0 0}
.sec-h{display:flex;align-items:center;gap:12px;margin-bottom:6px}.sec-h a.more{margin-left:auto;font-size:14px;font-weight:600;text-decoration:none;white-space:nowrap}
.sec-p{color:var(--text-secondary,#a8b3c4);margin:0 0 16px;max-width:820px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px}
.tool{display:flex;gap:12px;align-items:flex-start;padding:12px;border-radius:14px;border:1px solid var(--border,rgba(255,255,255,.08));background:var(--bg-secondary,#111826);text-decoration:none;color:inherit;transition:border-color .15s,transform .15s}
.tool:hover,.tool:focus-visible{border-color:var(--accent,#3b82f6);transform:translateY(-1px);outline:0}
.tool-t{min-width:0;display:block}.tool b{display:block;font-size:15px}.tool small{display:block;color:var(--text-secondary,#a8b3c4);font-size:13px;line-height:1.35;margin-top:2px}
.tool i{display:block;font-style:normal;font-size:11.5px;color:var(--text-muted,#7d8aa0);margin-top:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tool[hidden]{display:none}
.tool-wrap{position:relative;display:grid}.tool-wrap .tool{padding-right:40px}.fav{position:absolute;top:8px;right:8px;width:32px;height:32px;border:0;border-radius:999px;background:none;color:var(--text-muted,#7d8aa0);font-size:18px;line-height:1;cursor:pointer}.fav[aria-pressed="true"]{color:var(--accent,#3b82f6)}.fav:hover,.fav:focus-visible{color:var(--accent,#3b82f6);outline:2px solid var(--accent,#3b82f6);outline-offset:-2px}
.crumbs{font-size:13.5px;color:var(--text-muted,#7d8aa0);padding-top:18px}.crumbs a{color:inherit}
.page-h{display:flex;gap:16px;align-items:center;padding:14px 0 4px}.page-h h1{font-size:clamp(26px,4vw,40px);letter-spacing:-.03em;margin:0;line-height:1.1}
.lead{font-size:clamp(15px,1.5vw,18px);color:var(--text-secondary,#a8b3c4);max-width:820px}
.cta{display:inline-flex;align-items:center;gap:8px;background:var(--accent-strong,#1d4ed8);color:var(--on-accent-strong,#fff);font-weight:700;text-decoration:none;padding:12px 20px;border-radius:12px;margin:6px 0}
.hosts{list-style:none;padding:0;margin:8px 0;display:flex;flex-direction:column;gap:6px;max-width:640px}
.hosts li{display:flex;gap:10px;align-items:center;padding:9px 12px;border:1px solid var(--border,rgba(255,255,255,.08));border-radius:10px;flex-wrap:wrap}
.hosts li.primary{border-color:var(--accent,#3b82f6);background:var(--accent-glow,rgba(59,130,246,.1))}
.hosts .tag{font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--text-muted,#7d8aa0);margin-left:auto}.hosts li.primary .tag{color:var(--text-primary,#e6e9ef)}
.kw{display:flex;flex-wrap:wrap;gap:6px;padding:0;list-style:none}.kw li{font-size:12.5px;padding:3px 9px;border-radius:999px;background:var(--bg-secondary,#111826);color:var(--text-secondary,#a8b3c4)}
details{border-bottom:1px solid var(--border,rgba(255,255,255,.08));padding:12px 0;max-width:820px}summary{cursor:pointer;font-weight:650}details p{color:var(--text-secondary,#a8b3c4);margin:8px 0 0}
.az{columns:4 220px;column-gap:24px;padding:0;list-style:none}.az li{break-inside:avoid;padding:3px 0}.az a{text-decoration:none}.az small{color:var(--text-muted,#7d8aa0)}
.empty{color:var(--text-secondary,#a8b3c4);padding:12px 0}
.net{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}
.kicker{font-size:12.5px!important;font-weight:700;letter-spacing:.7px;text-transform:uppercase;color:var(--accent-light,var(--accent,#60a5fa))!important;margin:0 auto 12px!important}
.stats{display:flex;flex-wrap:wrap;justify-content:center;gap:8px 26px;list-style:none;padding:0;margin:20px 0 0;color:var(--text-muted,#7d8aa0);font-size:14px}.stats b{color:var(--text-primary,#e6edf7);font-size:18px;margin-right:4px}
.jump{position:sticky;top:56px;z-index:20;display:flex;gap:8px;overflow-x:auto;padding:10px 2px;margin:26px 0 0;background:color-mix(in srgb,var(--bg-primary,#0a0f18) 88%,transparent);backdrop-filter:blur(10px);scrollbar-width:none;border-bottom:1px solid var(--border,rgba(255,255,255,.06))}.jump::-webkit-scrollbar{display:none}
.jump a{display:inline-flex;align-items:center;gap:7px;flex:none;padding:6px 12px 6px 7px;border-radius:999px;border:1px solid var(--border,rgba(255,255,255,.1));text-decoration:none;color:var(--text-primary,#e6edf7);font-size:13.5px;font-weight:600;background:var(--bg-secondary,#111826)}
.jump a:hover{border-color:var(--accent,#3b82f6)}.jump i{font-style:normal;font-size:11.5px;color:var(--text-muted,#7d8aa0);font-weight:700}
.fam{scroll-margin-top:120px}.fam h2 a{color:inherit;text-decoration:none}.fam h2 a:hover{color:var(--accent-light,var(--accent,#60a5fa))}.fam-tag{margin:2px 0 0;color:var(--text-secondary,#a8b3c4);font-size:14.5px}.fam .sec-h{margin-bottom:14px;align-items:center}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(215px,1fr));gap:8px}
.tile{position:relative;display:flex;gap:10px;align-items:center;padding:9px 11px;border-radius:12px;border:1px solid var(--border,rgba(255,255,255,.07));background:var(--bg-secondary,#111826);text-decoration:none;color:inherit;min-width:0;transition:border-color .15s,background .15s}
.tile:hover,.tile:focus-visible{border-color:var(--accent,#3b82f6);background:color-mix(in srgb,var(--accent,#3b82f6) 7%,var(--bg-secondary,#111826));outline:0}
.tile>span:not(.ov-icon){min-width:0}.tile b{display:block;font-size:14px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tile small{display:block;font-size:12px;color:var(--text-muted,#7d8aa0);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tile.is-soon{border-style:dashed;background:none;cursor:default}.tile.is-soon>svg,.tile.is-soon>img{opacity:.6}.tile.is-soon em{margin-left:auto;font-style:normal;font-size:10.5px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;color:var(--accent-light,var(--accent,#60a5fa));flex:none}
.perks{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}.perks div{padding:16px;border-radius:14px;border:1px solid var(--border,rgba(255,255,255,.08));background:var(--bg-secondary,#111826)}.perks p{margin:6px 0 0;color:var(--text-secondary,#a8b3c4);font-size:14px}
@media (max-width:560px){.tiles{grid-template-columns:1fr 1fr}.tile small{display:none}.jump{top:52px}}
#ov-footer{margin-top:56px}
@media (max-width:560px){.grid{grid-template-columns:1fr}.search button{padding:0 14px}}
@media (prefers-reduced-motion:reduce){.tool{transition:none}}
${icons.CSS}`;

// "Elsewhere on OpenVibe": which services, their names and origins come from Network's registry
// (registry.services); only the one-line descriptions are ours. A service the registry lists as a
// placeholder or retired is not linked.
const NETWORK_COPY = [
    ['live', 'Live streams, clips and chat'],
    ['community', 'Pastes, posts and people'],
    ['games', 'Browser games'],
    ['media', 'VODs, clips and files'],
    ['network', 'One account for every site'],
];
function networkLinks() {
    const up = new Map(registry.services.linkable().map(s => [s.id, s]));
    return NETWORK_COPY.filter(([id]) => up.has(id)).map(([id, d]) => [id, up.get(id).name, d, `${up.get(id).origin}/`]);
}

function shell({ head, body, families }) {
    // Every icon on the page once, as a sprite; the markup above only references them.
    const NETWORK = networkLinks();
    const spriteSvg = icons.sprite([..._used, ...NETWORK.map(n => n[0])]); _used = new Set();
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${head}
${appIcon.headTags({ site: 'tools', iconBase: '/assets' })}
<link rel="alternate" type="application/json" href="${SITE}/api/catalog.json" title="Tool catalog">
<link rel="preconnect" href="https://openvibe.network">
<script src="${ovServe.url('theme-loader.js')}" defer></script>
<style>${CSS}</style></head><body>${spriteSvg}
<noscript><header class="topbar"><a href="${SITE}/">${NAME}</a><nav>${families.filter(f => f.path).map(f => `<a href="${esc(f.path)}">${esc(f.name)}</a>`).join('')}<a href="/all-tools">All tools</a></nav></header></noscript>
<main class="wrap">${body}
<section aria-labelledby="net-h"><div class="sec-h"><h2 id="net-h">The rest of OpenVibe</h2></div><p class="sec-p">One account works on every site. Open source and community-run.</p>
<div class="net">${NETWORK.map(([ic, n, d, u]) => `<a class="tool" href="${u}">${icon(ic, 36)}<span class="tool-t"><b>${n}</b><small>${d}</small></span></a>`).join('')}</div></section>
</main>${frame.footer({ service: 'tools', variant: 'full', updates: '/updates' })}
<script src="${ovServe.url('navbar.js')}" defer></script><script src="${ovServe.url('footer.js')}" defer></script><script src="/js/site.js" defer></script>
</body></html>`;
}

function head(o) {
    return seo.headTags(Object.assign({ siteName: NAME, image: 'https://openvibe.network/assets/og-tools.png', type: 'website', locale: 'en_US' }, o));
}

const searchForm = (q) => `<form class="search" action="/search" method="get" role="search"><input type="search" name="q" id="q" value="${esc(q || '')}" placeholder="What do you need to do? Try “merge pdf” or “dns lookup”" aria-label="Search tools" autocomplete="off"><button type="submit">Search</button></form>`;

function score(t, terms) {
    let s = 0; const name = t.name.toLowerCase(); const hay = [t.tagline, t.description, ...(t.keywords || []), t.id].join(' ').toLowerCase();
    for (const w of terms) { if (name.includes(w)) s += 5; if (t.id === w) s += 4; if ((t.keywords || []).some(k => k.includes(w))) s += 3; else if (hay.includes(w)) s += 1; else if (!name.includes(w)) return 0; }
    return s;
}
function search(q) {
    const terms = String(q || '').toLowerCase().split(/[^a-z0-9.+#]+/).filter(Boolean).slice(0, 8);
    if (!terms.length) return [];
    return registry.get().tools.map(t => [score(t, terms), t]).filter(x => x[0] > 0).sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name)).slice(0, 60).map(x => x[1]);
}

// ── Pages ────────────────────────────────────────────────────
function pageIndex() {
    const { tools, families, planned } = registry.get();
    const byId = new Map(tools.map(t => [t.id, t]));
    const popular = POPULAR.map(id => byId.get(id)).filter(Boolean);
    const fams = families.filter(f => f.path);
    const tile = (t) => `<a class="tile" href="${esc(t.url)}"${go(t)} title="${esc(t.tagline)}">${icon(t.icon, 28)}<span><b>${esc(t.name)}</b><small>${esc(t.tagline)}</small></span></a>`;
    const soon = (t) => `<span class="tile is-soon" title="Planned">${icon(t.icon, 28)}<span><b>${esc(t.name)}</b><small>${esc(t.tagline)}</small></span><em>Soon</em></span>`;
    const body = `<div class="hero"><p class="kicker">Open source · community-run · no account needed to start</p><h1>The toolbox for <span>everything you do online</span></h1>
<p>Convert a video, squeeze an image, merge a PDF, debug DNS, format JSON. ${tools.length} tools that open instantly, each on an address you can remember, like <a href="https://yt.openvibe.tools/">yt.openvibe.tools</a>.</p>
${searchForm('')}
<ul class="stats"><li><b>${tools.length}</b> tools</li><li><b>${fams.length}</b> families</li><li><b>0</b> installs</li><li><b>1</b> account for all of OpenVibe</li></ul></div>
<nav class="jump" aria-label="Tool families">${fams.map(f => `<a href="#f-${f.id}">${icon(f.icon, 22)}${esc(f.name)}<i>${tools.filter(t => t.family === f.id).length}</i></a>`).join('')}</nav>
<section id="results" hidden aria-live="polite"><div class="sec-h"><h2>Results</h2></div><div class="grid" id="results-grid"></div><p class="empty" id="results-empty" hidden>No tool matches that yet. <a href="/all-tools">Browse every tool</a>.</p></section>
<section id="recent" hidden aria-labelledby="recent-h"><div class="sec-h"><h2 id="recent-h">Your tools</h2><span class="more" id="recent-note"></span></div><div class="grid" id="recent-grid"></div></section>
<section aria-labelledby="pop-h"><div class="sec-h"><h2 id="pop-h">What people reach for</h2><a class="more" href="/all-tools">A to Z list</a></div><div class="grid">${popular.slice(0, 8).map(toolCard).join('')}</div></section>
${fams.map(f => { const list = tools.filter(t => t.family === f.id); const next = planned.filter(t => t.family === f.id); return `<section class="fam" aria-labelledby="f-${f.id}"><div class="sec-h">${icon(f.icon, 40)}<div><h2 id="f-${f.id}"><a href="${esc(f.path)}">${esc(f.name)}</a></h2><p class="fam-tag">${esc(f.tagline)}</p></div><a class="more" href="${esc(f.path)}">About these ${list.length}</a></div><div class="tiles">${list.map(tile).join('')}${next.map(soon).join('')}</div></section>`; }).join('')}
${frame.shipped({ service: 'tools', title: 'Recently shipped on OpenVibe.Tools' })}
<section aria-labelledby="acct-h"><div class="sec-h"><h2 id="acct-h">Better with an account, fine without</h2></div><div class="perks">
<div><b>Without signing in</b><p>Every tool works. Results stay available for an hour, then they are deleted.</p></div>
<div><b>Signed in</b><p>Results keep for 24 hours, your recent tools follow you across devices, and your theme and notifications come along from the rest of OpenVibe.</p></div>
<div><b>For developers</b><p>Run any tool from code: see <a href="/developers">the Tools API</a> (<a href="/api/v1/openapi.json">OpenAPI</a>). The catalog is public JSON at <a href="/api/catalog.json">/api/catalog.json</a>, with a plain-text map at <a href="/llms.txt">/llms.txt</a>.</p></div></div></section>`;
    return shell({ families, body, head: head({
        title: 'Online Tools for Files, Text, Code & Networks', description: `${tools.length} online tools in one place: video and audio converters, image and PDF tools, developer utilities and network diagnostics. Open source and community-run.`,
        canonical: SITE + '/', keywords: 'online tools, converter, pdf tools, image converter, developer tools, network tools, youtube downloader',
        jsonLd: [seo.jsonLd.organization(), seo.jsonLd.website({ name: NAME, url: SITE + '/', description: 'Online tools for files, text, code and networks.', searchUrl: SITE + '/search?q={search_term_string}' }),
            seo.jsonLd.itemList('Tool families', fams.map(f => ({ name: f.name, url: SITE + f.path, description: f.tagline })))] }) });
}

function pageFamily(f) {
    const { tools, families } = registry.get();
    const list = tools.filter(t => t.family === f.id || (t.alsoIn || []).includes(f.id));
    const url = SITE + f.path;
    const body = `<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Tools</a> › ${esc(f.name)}</nav>
<div class="page-h">${icon(f.icon, 56)}<h1>${esc(f.name)}</h1></div><p class="lead">${esc(f.description)}</p>
${f.hosts ? `<a class="cta" href="${esc(f.url)}">Open ${esc(f.name)}</a>` : ''}
<section><div class="sec-h"><h2>${list.length} tools</h2></div><p class="sec-p">${esc(f.intro || '')}</p><div class="grid">${list.map(toolCard).join('')}</div></section>
${f.faq && f.faq.length ? `<section><div class="sec-h"><h2>Questions</h2></div>${f.faq.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}</section>` : ''}`;
    return shell({ families, body, head: head({ title: `${f.name}: ${f.tagline}`, description: f.description, canonical: url, keywords: list.slice(0, 12).map(t => t.name.toLowerCase()).join(', '),
        jsonLd: [seo.jsonLd.breadcrumbs([{ name: 'Tools', url: SITE + '/' }, { name: f.name, url }]), seo.jsonLd.itemList(f.name, list.map(t => ({ name: t.name, url: t.url, description: t.tagline }))),
            ...(f.faq && f.faq.length ? [seo.jsonLd.faq(f.faq.map(([q, a]) => ({ q, a })))] : [])] }) });
}

function pageTool(t) {
    const { tools, families } = registry.get();
    const f = families.find(x => x.id === t.family);
    const url = `${SITE}/tool/${t.id}`;
    const related = tools.filter(x => x.family === t.family && x.id !== t.id).slice(0, 8);
    const hosts = [...(t.hosts.short ? [[t.hosts.short, 'Easiest to remember']] : []), [t.hosts.canonical, t.hosts.short ? 'Search-friendly address' : 'Primary'], ...(t.hosts.mirrors || []).map(a => [a, 'Mirror']), ...t.hosts.aliases.map(a => [a, 'Redirects here'])];
    const body = `<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Tools</a> › ${f && f.path ? `<a href="${esc(f.path)}">${esc(f.name)}</a> › ` : ''}${esc(t.name)}</nav>
<div class="page-h">${icon(t.icon, 56)}<h1>${esc(t.name)}</h1></div><p class="lead">${esc(t.description)}</p>
${t.status === 'unavailable' ? `<p class="lead"><strong>Not available yet.</strong> ${esc(t.unavailable || '')}</p>` : `<a class="cta" href="${esc(t.url)}">Open ${esc(t.name)}</a>`}
<section><div class="sec-h"><h2>Where to find it</h2></div><p class="sec-p">Every address below opens the same tool. The first address is the one to bookmark and share.</p>
<ul class="hosts">${hosts.map(([h, tag], i) => `<li${i === 0 ? ' class="primary"' : ''}><a href="https://${esc(h)}/"${i === 0 ? '' : ' rel="nofollow"'}>${esc(h)}</a><span class="tag">${tag}</span></li>`).join('')}</ul></section>
${t.keywords && t.keywords.length ? `<section><div class="sec-h"><h2>People also call this</h2></div><ul class="kw">${t.keywords.map(k => `<li>${esc(k)}</li>`).join('')}</ul></section>` : ''}
${related.length ? `<section><div class="sec-h"><h2>Related tools</h2>${f && f.path ? `<a class="more" href="${esc(f.path)}">All ${esc(f.name)}</a>` : ''}</div><div class="grid">${related.map(toolCard).join('')}</div></section>` : ''}`;
    return shell({ families, body, head: head({ title: `${t.name}: ${t.tagline}`, description: t.description, canonical: url, keywords: (t.keywords || []).join(', '),
        jsonLd: [seo.jsonLd.breadcrumbs([{ name: 'Tools', url: SITE + '/' }, ...(f && f.path ? [{ name: f.name, url: SITE + f.path }] : []), { name: t.name, url }]),
            seo.jsonLd.softwareApp({ name: t.name, url: t.url, description: t.description, category: 'UtilitiesApplication', keywords: t.keywords })] }) });
}

function pageAll() {
    const { tools, families } = registry.get();
    const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
    const body = `<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Tools</a> › All tools</nav><div class="page-h">${icon('tools', 56)}<h1>All ${tools.length} tools, A to Z</h1></div>
${searchForm('')}<section><ul class="az">${sorted.map(t => `<li><a href="${esc(t.url)}">${esc(t.name)}</a> <small><a href="/tool/${esc(t.id)}" aria-label="About ${esc(t.name)}">about</a></small></li>`).join('')}</ul></section>`;
    return shell({ families, body, head: head({ title: `All ${tools.length} Online Tools, A to Z`, description: 'The complete list of tools on OpenVibe.Tools: converters, downloaders, PDF and image tools, text utilities, developer tools and network diagnostics.', canonical: SITE + '/all-tools',
        jsonLd: [seo.jsonLd.breadcrumbs([{ name: 'Tools', url: SITE + '/' }, { name: 'All tools', url: SITE + '/all-tools' }])] }) });
}

function pageSearch(q) {
    const { families } = registry.get();
    const hits = search(q);
    const body = `<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Tools</a> › Search</nav><div class="page-h"><h1>${q ? `Tools for “${esc(q)}”` : 'Search tools'}</h1></div>${searchForm(q)}
<section>${hits.length ? `<div class="grid">${hits.map(toolCard).join('')}</div>` : `<p class="empty">${q ? 'No tool matches that yet.' : 'Type what you need to do.'} <a href="/all-tools">Browse every tool</a>.</p>`}</section>`;
    return shell({ families, body, head: head({ title: q ? `Tools for “${seo.clip(q, 30)}”` : 'Search tools', description: 'Search every tool on OpenVibe.Tools.', canonical: SITE + '/search', robots: 'noindex,follow' }) });
}

// ── Cache + router ───────────────────────────────────────────
const cache = new Map();
function cached(key, render) {
    const ver = registry.get().updated;
    let e = cache.get(key);
    if (!e || e.ver !== ver) { const html = render(); e = { ver, html, etag: '"' + crypto.createHash('sha1').update(html).digest('base64url').slice(0, 20) + '"' }; cache.set(key, e); }
    return e;
}
/** /developers: how to call any tool from code (run API, jobs, SDK, auth tiers, limits). */
function pageUpdates() {
    const { families } = registry.get();
    const body = `<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Tools</a> › Updates</nav>${frame.updatesBody({ service: 'tools', siteName: NAME })}${`<script src="${ovServe.url('shipped.js')}" defer></script>`}`;
    return shell({ families, body, head: head({ title: 'What shipped on OpenVibe.Tools', description: 'Every change deployed to OpenVibe.Tools, newest first, with the Patch notes that gather them.', canonical: SITE + '/updates' }) });
}

function pageDevelopers() {
    const { families } = registry.get();
    const snap = require('../registry/descriptors').snapshot();
    const withApi = snap.tools.filter((t) => t.api && t.status !== 'unavailable');
    // A long command scrolls inside its block, not the page (it overflowed at 768 px); tabindex lets a keyboard scroll it.
    const code = (s) => `<pre tabindex="0"><code>${esc(s)}</code></pre>`;
    const body = `<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Tools</a> › Developers</nav><div class="page-h">${icon('code', 56)}<h1>Tools API</h1></div>
<p class="lead">${withApi.length} of ${snap.tools.length} tools can be called from code, with the same engines the pages use. One request shape for all of them; long work runs as a job you can follow.</p>
<section><div class="sec-h"><h2>Discover</h2></div><p class="sec-p">Every tool is described by a machine-readable descriptor (inputs as JSON Schema, file limits, how it runs, who may call it).</p>
<ul><li><a href="/api/v1/tools">/api/v1/tools</a>: the registry (filter with <code>?family=</code>, <code>?q=</code>, <code>?api=true</code>)</li>
<li><code>/api/v1/tools/{id}</code> and <code>/api/v1/tools/{id}/schema</code>: one tool</li>
<li><a href="/api/v1/openapi.json">/api/v1/openapi.json</a>: OpenAPI 3.1, generated from the descriptors</li></ul></section>
<section><div class="sec-h"><h2>Run a tool</h2></div>
${code(`curl -X POST ${SITE}/api/v1/tools/jsonminify/run \\
  -H 'Content-Type: application/json' \\
  -d '{"input":{"text":"{ \\"a\\": 1 }"}}'
# → {"state":"succeeded","tool":"jsonminify","result":{"text":"{\\"a\\":1}"},"took_ms":3}`)}
<p class="sec-p">File tools take <code>multipart/form-data</code> (<code>file</code> parts plus an <code>input</code> JSON part). Work that outlasts <code>wait_ms</code> answers <b>202</b> with a job: follow it at <code>/api/v1/jobs/{id}/events</code> (server-sent events) and download results from <code>/api/v1/jobs/{id}/files/{n}</code>. Send an <code>Idempotency-Key</code> header to make retries safe.</p></section>
<section><div class="sec-h"><h2>From JavaScript</h2></div>
${code(`const { createClient } = require('openvibe-sdk/core');
const { createToolsClient } = require('openvibe-sdk/tools');
const tools = createToolsClient(createClient({}));
const out = await tools.run('jsonminify', { text: '{ "a": 1 }' });
const job = await tools.run('png', { format: 'png' }, { files: [fileBlob] });
const done = await job.wait();   // any tool, sync or job`)}
<p class="sec-p">The SDK is <a href="https://github.com/OpenVibers/OpenVibe.SDK">openvibe-sdk</a> (tag v0.6.0+). It retries on 429 after <code>Retry-After</code> and generates idempotency keys for you.</p></section>
<section><div class="sec-h"><h2>Access and limits</h2></div>
<ul><li><b>Anonymous</b>: most tools, on the lowest quota tier, per address. Tools that handle files people should not share anonymously (audio, PDF) need a browser session or a token.</li>
<li><b>Apps and services</b>: a token from <a href="https://openvibe.network">OpenVibe.Network</a> for audience <code>openvibe.tools</code> with <code>tools.tool.run</code> (developer sandbox apps get it by default) raises the tier.</li>
<li><b>Network probes</b> (port checks, ping, latency) need <code>tools.net.probe</code>, granted to partners only. The YouTube downloader has no API.</li>
<li>Every answer carries <code>RateLimit-*</code> headers; over the limit is <b>429</b> with <code>Retry-After</code>. Errors are RFC 9457 problems with a stable <code>code</code>.</li></ul></section>`;
    return shell({ families, body, head: head({ title: 'Tools API for developers', description: `Call ${withApi.length} OpenVibe tools from code: one run API, jobs for long work, an OpenAPI document and the openvibe-sdk client.`, canonical: SITE + '/developers',
        jsonLd: [seo.jsonLd.breadcrumbs([{ name: 'Tools', url: SITE + '/' }, { name: 'Developers', url: SITE + '/developers' }])] }) });
}

function send(req, res, key, render, type) {
    const e = cached(key, render);
    res.set('Content-Type', type || 'text/html; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
    res.set('ETag', e.etag);
    if (req.headers['if-none-match'] === e.etag) return res.status(304).end();
    res.send(e.html);
}

function sitemapEntries() {
    const { tools, families } = registry.get();
    const today = new Date().toISOString().slice(0, 10);
    return [{ loc: SITE + '/', changefreq: 'daily', priority: 1 }, { loc: SITE + '/all-tools', changefreq: 'weekly', priority: 0.8 }, { loc: SITE + '/developers', changefreq: 'weekly', priority: 0.7 }, { loc: SITE + '/updates', changefreq: 'daily', priority: 0.4 },
        ...families.filter(f => f.path).map(f => ({ loc: SITE + f.path, changefreq: 'weekly', priority: 0.9 })),
        ...families.filter(f => f.hosts).map(f => ({ loc: f.url, changefreq: 'weekly', priority: 0.9 })),
        ...tools.filter(t => !t.external).flatMap(t => [{ loc: t.url, changefreq: 'weekly', priority: 0.8 }, { loc: `${SITE}/tool/${t.id}`, changefreq: 'monthly', priority: 0.5 }]),
    ].map(u => Object.assign({ lastmod: today }, u));
}

function createSiteRouter() {
    const router = express.Router();
    const apexOnly = (req, res, next) => (!req.ovHost || req.ovHost.kind === 'apex' || (req.ovHost.kind === 'unknown' && !req.ovHost.inZone) ? next() : next('router'));
    router.use(apexOnly);
    router.get('/api/v1/openapi.json', (req, res) => { res.set('Access-Control-Allow-Origin', '*'); send(req, res, 'openapi', () => JSON.stringify(require('../openapi').openapi(require('../registry/descriptors').snapshot(), SITE)), 'application/json; charset=utf-8'); });
    router.get('/developers', (req, res) => send(req, res, 'developers', pageDevelopers));
    // What shipped on OpenVibe.Tools: the shared update log every OpenVibe site has.
    router.get('/updates', (req, res) => send(req, res, 'updates', pageUpdates));
    router.get('/api/catalog.json', (req, res) => { res.set('Access-Control-Allow-Origin', '*'); send(req, res, 'catalog', () => JSON.stringify(registry.catalog()), 'application/json; charset=utf-8'); });
    router.get('/', (req, res) => send(req, res, '/', pageIndex));
    router.get('/all-tools', (req, res) => send(req, res, '/all-tools', pageAll));
    router.get('/search', (req, res) => { res.set('Cache-Control', 'no-store'); res.type('html').send(pageSearch(String(req.query.q || '').slice(0, 80))); });
    router.get('/tool/:id', (req, res, next) => { const t = registry.get().tools.find(x => x.id === req.params.id); return t ? send(req, res, '/tool/' + t.id, () => pageTool(t)) : next(); });
    router.get('/sitemap.xml', (req, res) => send(req, res, 'sitemap', () => seo.sitemapXml(sitemapEntries()), 'application/xml; charset=utf-8'));
    router.get('/robots.txt', (req, res) => send(req, res, 'robots', () => seo.robotsTxt({ sitemaps: [SITE + '/sitemap.xml'], disallow: ['/api/', '/auth/'], allow: ['/api/catalog.json'], allowAI: true }), 'text/plain; charset=utf-8'));
    router.get('/llms.txt', (req, res) => send(req, res, 'llms', () => { const { tools, families } = registry.get(); return seo.llmsTxt({ name: NAME, summary: `${tools.length} online tools for files, text, code and networks. Open source and community-run. A machine-readable catalog is at ${SITE}/api/catalog.json.`,
        sections: [{ title: 'API', links: [{ title: 'Developer guide', url: SITE + '/developers', note: 'run any tool from code' }, { title: 'OpenAPI 3.1', url: SITE + '/api/v1/openapi.json' }, { title: 'Tool registry (JSON)', url: SITE + '/api/v1/tools' }] }].concat(families.filter(f => f.path).map(f => ({ title: f.name, links: tools.filter(t => t.family === f.id).map(t => ({ title: t.name, url: t.url, note: t.tagline })) }))) }); }, 'text/plain; charset=utf-8'));
    router.get('/:slug', (req, res, next) => { const f = registry.get().families.find(x => x.path === '/' + req.params.slug); return f ? send(req, res, f.path, () => pageFamily(f)) : next(); });
    return router;
}

const renderNotFound = () => pageSearch('').replace('<h1>Search tools</h1>', '<h1>That page is not here</h1>').replace(/<title>[^<]*<\/title>/, '<title>Page not found | OpenVibe.Tools</title>');

module.exports = { createSiteRouter, search, sitemapEntries, renderNotFound };
