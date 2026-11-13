'use strict';
// ═══════════════════════════════════════════════════════════════
// openvibe.tools, server-rendered from the registry.
//   /                 index: search, families, popular tools
//   /<family-path>    one family: every tool, intro, FAQ
//   /tool/<id>        301 to the tool's primary host (one canonical address per tool)
//   /all-tools        A–Z
//   /search?q=        results (works as a plain form; JS only makes it instant)
//   /sitemap.xml /robots.txt /llms.txt /llms-full.txt /api/catalog.json
// Every page is complete HTML without JavaScript. Pages are rendered once per registry version
// and served from memory with an ETag.
// ═══════════════════════════════════════════════════════════════
const crypto = require('crypto');
const frame = require('openvibe-shared/frame');
const ovServe = require('openvibe-shared/serve');
const social = require('openvibe-shared/social');
const express = require('express');
const seo = require('openvibe-shared/seo');
const icons = require('openvibe-shared/icons');
const kit = require('openvibe-shared/kit');
const appIcon = require('openvibe-shared/app-icon');
const glyphs = require('openvibe-shared/glyphs');
const arrowRight = glyphs.svg('arrow-right', { size: 16 });
const arrowUp = glyphs.svg('arrow-up', { size: 16 });
const arrowDown = glyphs.svg('arrow-down', { size: 16 });
const chevronRight = glyphs.svg('chevron-right', { size: 16 });
const registry = require('../registry');
const { seoFor } = require('../seo/catalog');

// The doing words a tool's tagline may start with to finish "Small tools that …" (see clause() in the home).
const HEADLINE_VERBS = new Set(('add build calculate change check clean compare compress convert count create crop decode design detect draw edit '
    + 'encode estimate explore extract find fix flip format generate get look make map measure merge minify mix pick plan play '
    + 'preview read record remove rename resize roll rotate save scan search see send share shorten sign split strip test time '
    + 'track translate trim turn validate verify watch write').split(' '));
/** A tool's own words for the end of "Small tools that …": the first clause of its tagline, only when it starts with a
 *  doing word ("Look up DNS records for any domain: A, AAAA…" → "look up DNS records for any domain"); else null. */
function headlineClause(t) {
    let s = String((t && t.tagline) || '').split(/[:;.(?!]|, | — | - /)[0].trim();
    if (s.split(/\s+/).length < 2 || s.length > 46) return null;
    if (/^[A-Z][a-z]/.test(s)) s = s[0].toLowerCase() + s.slice(1);
    return HEADLINE_VERBS.has(s.split(/\s+/)[0]) ? s : null;
}

const guardLimits = require('../../../_shared/guard/limits');
const { foldBlock } = require('../short');

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
.quick-strip{display:flex;gap:8px;overflow-x:auto;position:relative;padding:12px 0;max-width:100%}
.quick-strip .ovk-btn{flex:none;min-height:44px;text-decoration:none}
.hero-copy{min-width:0}.search .ovk-btn{min-height:44px}
.jobs .ovk-list{margin:0}.jobs .more{display:inline-flex;align-items:center;min-height:44px}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg-primary,#0a0f18);color:var(--text-primary,#e6edf7);font:400 16px/1.55 Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
a{color:var(--accent-light,var(--accent,#60a5fa))}
.wrap{max-width:1180px;margin:0 auto;padding:0 20px}
pre{max-width:100%;overflow-x:auto}pre:focus-visible{outline:2px solid var(--accent,#3b82f6);outline-offset:2px}
/* The shared navbar lands in #navbar-mount after its deferred script: the mount holds its 52px from the first paint, so the page below does not drop when it arrives. */
#navbar-mount{min-height:52px}
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
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(250px,100%),1fr));gap:10px}
.tool{display:flex;min-width:0;gap:12px;align-items:flex-start;padding:12px;border-radius:14px;border:1px solid var(--border,rgba(255,255,255,.08));background:var(--bg-secondary,#111826);text-decoration:none;color:inherit;transition:border-color .15s,transform .15s}
.tool:hover,.tool:focus-visible{border-color:var(--accent,#3b82f6);transform:translateY(-1px);outline:0}
.tool-t{min-width:0;display:block}.tool b{display:block;font-size:15px}.tool small{display:block;color:var(--text-secondary,#a8b3c4);font-size:13px;line-height:1.35;margin-top:2px}
.tool i{display:block;font-style:normal;font-size:11.5px;color:var(--text-muted,#7d8aa0);margin-top:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tool[hidden]{display:none}
.tool-wrap{position:relative;display:grid;grid-template-columns:minmax(0,1fr)}.tool-wrap .tool{padding-right:40px}.fav{position:absolute;top:8px;right:8px;width:32px;height:32px;border:0;border-radius:999px;background:none;color:var(--text-muted,#7d8aa0);font-size:18px;line-height:1;cursor:pointer}.fav[aria-pressed="true"]{color:var(--accent,#3b82f6)}.fav:hover,.fav:focus-visible{color:var(--accent,#3b82f6);outline:2px solid var(--accent,#3b82f6);outline-offset:-2px}
.crumbs{font-size:13.5px;color:var(--text-muted,#7d8aa0);padding-top:18px}.crumbs a{color:inherit}
.page-h{display:flex;gap:16px;align-items:center;padding:14px 0 4px}.page-h h1{font-size:clamp(26px,4vw,40px);letter-spacing:-.03em;margin:0;line-height:1.1}
.lead{font-size:clamp(15px,1.5vw,18px);color:var(--text-secondary,#a8b3c4);max-width:820px}
.cta{display:inline-flex;align-items:center;gap:8px;background:var(--accent-strong,#1d4ed8);color:var(--on-accent-strong,#fff);font-weight:700;text-decoration:none;padding:12px 20px;border-radius:12px;margin:6px 0}
.hosts{list-style:none;padding:0;margin:8px 0;display:flex;flex-direction:column;gap:6px;max-width:640px}
.hosts li{display:flex;gap:10px;align-items:center;padding:9px 12px;border:1px solid var(--border,rgba(255,255,255,.08));border-radius:10px;flex-wrap:wrap}
.hosts li.primary{border-color:var(--accent,#3b82f6);background:var(--accent-glow,rgba(59,130,246,.1))}
.hosts .tag{font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--text-muted,#7d8aa0);margin-left:auto}.hosts li.primary .tag{color:var(--text-primary,#e6e9ef)}
.facts{list-style:none;padding:0;margin:14px 0 18px;max-width:820px;border:1px solid var(--border,rgba(255,255,255,.08));border-radius:14px;background:var(--bg-secondary,#111826);overflow:hidden}
.facts li{display:flex;gap:10px;flex-wrap:wrap;padding:10px 14px;border-top:1px solid var(--border,rgba(255,255,255,.08));font-size:14px;line-height:1.5;color:var(--text-secondary,#a8b3c4);overflow-wrap:anywhere}
.facts li:first-child{border-top:0}.facts b{flex:none;min-width:104px;color:var(--text-primary,#e6edf7);font-weight:650}
@media (max-width:420px){.facts b{min-width:0;display:block;width:100%}}
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
.fold details{border:0;padding:0;max-width:none}.fold summary{list-style:none;display:flex;align-items:center;gap:10px}.fold summary::-webkit-details-marker{display:none}.fold summary::after{content:'+';margin-left:auto;font-size:22px;font-weight:400;color:var(--text-muted,#7d8aa0)}.fold details[open] summary::after{content:'\\2212'}.fold summary h2{display:inline}.fold details>:not(summary){margin-top:12px}
/* The fold (the owner's short-pages rule, 2026-10-30): a part a reader rarely needs. On a phone it is closed — the
   title row is a 44 px target that opens it — and where there is room it is open and looks like the section it
   replaces. A checkbox and a label, no script: the part stays in the page for the crawlers. */
.fold-block{margin-top:26px}
.fold-toggle{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}
.fold-h{display:flex;align-items:center;gap:10px;min-height:44px;cursor:pointer}
.fold-h>h2{margin:0;flex:1 1 auto}
.fold-h:focus-within{outline:2px solid var(--accent,#3b82f6);outline-offset:2px}
.fold-mark{flex:none}
.fold-n{flex:none;font-size:.82rem;font-weight:600;color:var(--text-muted,#7386a3);font-variant-numeric:tabular-nums}
.fold-count{margin-left:4px;font-size:13px;font-weight:650;color:var(--text-muted,#7d8aa0);font-variant-numeric:tabular-nums;vertical-align:middle}
.fold-mark::after{content:'+';font-size:22px;font-weight:400;color:var(--text-muted,#7d8aa0)}
.fold-toggle:checked~.fold-h .fold-mark::after{content:'\\2212'}
.fold-body{display:none}
.fold-toggle:checked~.fold-body{display:block}
.fold-block:not(.fold-bare) .fold-body .ov-shipped-home h3{display:none}
/* Categories as folds (11-09): the icon and the name are the fold's title; its count sits beside them. */
.job .fold-block{margin-top:10px}.job .fold-h .sec-h{display:flex;align-items:center;gap:10px;flex:1 1 auto;min-width:0;margin:0}.job .fold-h h2{margin:0}
.job{border-top:1px solid var(--border,rgba(255,255,255,.08));padding-top:4px}
/* The headline's last words change: each phrase is a link to its tool, all stacked in one cell (as tall as the
   tallest, so nothing below moves). The one showing rises in; the one leaving lifts away. Once through, then it rests. */
.hm-rot{display:grid}.hm-ph{grid-area:1/1;color:var(--accent-light,var(--accent,#60a5fa));text-decoration:none;opacity:0;visibility:hidden;transform:translateY(.35em);
transition:opacity var(--ov-dur-3,.32s) var(--ov-ease-out,ease-out),transform var(--ov-dur-3,.32s) var(--ov-ease-out,ease-out),visibility 0s linear var(--ov-dur-3,.32s)}
.hm-ph.is-on{opacity:1;visibility:visible;transform:none;transition-delay:0s}.hm-ph.is-out{transform:translateY(-.35em)}
.hm-ph:hover,.hm-ph:focus-visible{text-decoration:underline;text-decoration-thickness:.06em;text-underline-offset:.12em}
html[data-ov-motion=off] .hm-ph{transform:none}
/* The strip of tools drifts, so its ends fade: a chip cut by a hard edge looked broken. */
.quick-strip{-webkit-mask-image:linear-gradient(90deg,transparent,#000 22px,#000 calc(100% - 22px),transparent);mask-image:linear-gradient(90deg,transparent,#000 22px,#000 calc(100% - 22px),transparent);padding-inline:14px;margin-inline:-14px;max-width:calc(100% + 28px)}
/* The headline's pause: a small round icon beside the words, not a line of its own. */
.hm-title{display:flex;align-items:flex-start;gap:10px}.hm-title h1{flex:1 1 auto;min-width:0}.hm-title .hm-motion{margin-top:8px;flex:none}
.hm-motion{display:inline-grid;place-items:center;width:36px;height:36px;margin:-4px 0 0;padding:0;border:0;border-radius:50%;vertical-align:middle;cursor:pointer;
background:color-mix(in srgb,var(--text-primary,#e8ecf3) 8%,transparent);color:var(--text-secondary,#a8b3c4)}
.hm-motion::after{content:"";position:absolute;inset:-4px}.hm-motion{position:relative}
.hm-motion svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
.hm-motion .hm-play{display:none;fill:currentColor;stroke:none}.hm-motion.is-paused .hm-pause{display:none}.hm-motion.is-paused .hm-play{display:block}
.hm-motion:focus-visible{outline:2px solid var(--accent,#3b82f6);outline-offset:2px}
@media (min-width:641px){
.fold-block{margin-top:40px}
.fold-toggle{display:none}
.fold-h{min-height:0;margin-bottom:6px;cursor:default}
.fold-mark,.fold-n{display:none}
.fold-body{display:block}
}
.fam-all{margin:10px 0 0;font-size:14px}.fam-all a{font-weight:650;text-decoration:none}
.perks{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}.perks div{padding:16px;border-radius:14px;border:1px solid var(--border,rgba(255,255,255,.08));background:var(--bg-secondary,#111826)}.perks p{margin:6px 0 0;color:var(--text-secondary,#a8b3c4);font-size:14px}
@media (max-width:560px){.jump{top:52px}}
.tool .opens{color:var(--text-secondary,#a8b3c4);font-weight:600}
.api-box{max-width:820px}.api-box pre{background:var(--bg-secondary,#111826);border:1px solid var(--border,rgba(255,255,255,.08));border-radius:12px;padding:12px 14px;font-size:13px;line-height:1.5}
.api-facts{list-style:none;padding:0;margin:0 0 12px;display:flex;flex-direction:column;gap:6px;color:var(--text-secondary,#a8b3c4)}.api-facts code{overflow-wrap:anywhere}
.dev{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(320px,100%),1fr));gap:14px;align-items:start}.dev pre{margin:0;background:var(--bg-secondary,#111826);border:1px solid var(--border,rgba(255,255,255,.08));border-radius:12px;padding:12px 14px;font-size:13px;line-height:1.5}
.dev ul{margin:0;padding-left:18px;color:var(--text-secondary,#a8b3c4)}.dev li{margin:4px 0}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.api-table{width:100%;table-layout:fixed;border-collapse:collapse;font-size:13.5px;line-height:1.45}
.api-table th,.api-table td{padding:10px;text-align:left;vertical-align:top;border-bottom:1px solid var(--border,rgba(255,255,255,.08))}
.api-table th{font-size:11.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--text-muted,#7d8aa0)}
.api-table td code{font-size:12.5px;overflow-wrap:anywhere;word-break:break-word}
.api-table th:nth-child(1),.api-table td:nth-child(1){width:22%}
.api-table th:nth-child(2),.api-table td:nth-child(2){width:27%}
.api-table th:nth-child(3),.api-table td:nth-child(3){width:15%}
.api-table th:nth-child(4),.api-table td:nth-child(4){width:13%}
.api-table th:nth-child(5),.api-table td:nth-child(5){width:23%}
.api-table-empty{color:var(--text-secondary,#a8b3c4)}
@media (max-width:700px){
.api-table,.api-table thead,.api-table tbody,.api-table tr,.api-table td{display:block;width:auto}
.api-table thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
.api-table tr{margin:0 0 10px;padding:8px 12px;border:1px solid var(--border,rgba(255,255,255,.08));border-radius:12px;background:var(--bg-secondary,#111826)}
.api-table td,.api-table td:nth-child(1),.api-table td:nth-child(2),.api-table td:nth-child(3),.api-table td:nth-child(4),.api-table td:nth-child(5){width:auto;padding:5px 0;border:0}
.api-table td::before{content:attr(data-label);display:block;margin-bottom:2px;font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--text-muted,#7d8aa0)}
}
/* Home: one line, one live example, then the tools grouped by the job they do. */
.hero.hero-split{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(300px,.85fr);gap:clamp(24px,4vw,52px);align-items:center;text-align:left;padding:clamp(24px,4vw,52px) 0 12px}
.hero-copy{min-width:0}
.hero-copy h1{font-size:clamp(30px,4.4vw,48px);line-height:1.06;letter-spacing:-.035em;margin:0 0 12px;font-weight:800;max-width:16ch}
.hero-copy .hero-sub{max-width:56ch;margin:0 0 20px;color:var(--text-secondary,#a8b3c4);font-size:clamp(15px,1.5vw,17px)}
.hero-split .search{max-width:560px;margin:0}
.hero-split+.stats{justify-content:flex-start;margin:10px 0 0}
.promo{min-width:0;border:1px solid var(--border,rgba(255,255,255,.1));background:var(--bg-secondary,#111826);border-radius:18px;padding:clamp(16px,2vw,22px);box-shadow:0 12px 40px rgba(0,0,0,.16)}
.promo-head h2{font-size:19px;letter-spacing:-.01em;margin:0}
.promo-head p{margin:4px 0 14px;color:var(--text-secondary,#a8b3c4);font-size:13.5px;line-height:1.45}
.promo label{display:block;margin:0 0 6px;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--text-muted,#7d8aa0)}
.promo input{width:100%;min-height:46px;padding:10px 12px;background:var(--bg-primary,#0a0f18);border:1px solid var(--border,rgba(255,255,255,.12));border-radius:10px;color:inherit;font:inherit}
.promo input:focus{outline:2px solid var(--accent,#3b82f6);outline-offset:1px;border-color:transparent}
.promo-out{margin:12px 0 0;border-top:1px solid var(--border,rgba(255,255,255,.08))}
.promo-out>div{min-width:0;padding:9px 0;border-bottom:1px solid var(--border,rgba(255,255,255,.08))}
.promo-out dt{margin:0;font-size:11.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--text-muted,#7d8aa0)}
.promo-out dt a{color:inherit;text-decoration:none}
.promo-out dt a:hover{color:var(--accent-light,var(--accent,#60a5fa))}
.promo-out dd{margin:3px 0 0;min-height:21px;font-size:15px;line-height:1.4;overflow-wrap:anywhere}
.promo-out output{display:block}
.promo-foot{margin:12px 0 0;font-size:13.5px;font-weight:600}
/* Real examples: a card carries a real input/output, not a feature chip. */
.start-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.start{display:flex;flex-direction:column;gap:8px;min-width:0;padding:16px;border:1px solid var(--border,rgba(255,255,255,.08));border-radius:16px;background:var(--bg-secondary,#111826);text-decoration:none;color:inherit;transition:border-color .15s,transform .15s}
.start:hover,.start:focus-visible{border-color:var(--accent,#3b82f6);transform:translateY(-1px);outline:0}
.start-name{font-size:15px;font-weight:700;line-height:1.3}
.start-name small{display:block;margin-top:2px;font-size:12px;font-weight:500;color:var(--text-muted,#7d8aa0);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.start pre{margin:0;max-height:150px;padding:8px 10px;background:var(--bg-primary,#0a0f18);border:1px solid var(--border,rgba(255,255,255,.08));border-radius:9px;font-size:12px;line-height:1.45;overflow-x:auto}
.start-arrow{font-size:13px;line-height:1;text-align:center;color:var(--text-muted,#7d8aa0)}
.start-note{margin:0;color:var(--text-secondary,#a8b3c4);font-size:13px;line-height:1.45}
.start-go{margin-top:auto;padding-top:2px;font-size:13.5px;font-weight:650;color:var(--accent-light,var(--accent,#60a5fa))}
.flow{display:flex;align-items:center;flex-wrap:wrap;gap:6px;font-size:12.5px;color:var(--text-secondary,#a8b3c4)}
.flow span{padding:4px 8px;border:1px solid var(--border,rgba(255,255,255,.1));border-radius:6px;background:var(--bg-primary,#0a0f18)}
.flow .flow-out{border-color:var(--accent,#3b82f6);color:var(--text-primary,#e6edf7);font-weight:600}
.flow .flow-arrow{border:0;background:none;padding:0;color:var(--text-muted,#7d8aa0)}
.job{padding:clamp(24px,4vw,36px) 0 0}
.jobs-h{display:flex;margin-top:30px}
.sec-count{font-size:13px;font-weight:650;color:var(--text-muted,#7d8aa0);white-space:nowrap;font-variant-numeric:tabular-nums}
/* Phones (the owner's rule, 2026-10-31: never hide content to shorten): every category stays on the page with all of
   its tools, so the list is a plain column of rows that a thumb can scroll through. */
@media (max-width:640px){
.jobs .job{padding-top:22px}
.jobs .job .sec-p{margin:2px 0 0;font-size:13.5px}
}
.job .sec-h{margin-bottom:4px}
@media (max-width:820px){.hero.hero-split{grid-template-columns:minmax(0,1fr);gap:20px}.hero-copy h1{max-width:none}.start-grid{grid-template-columns:1fr}}
@media (max-width:560px){.grid{grid-template-columns:minmax(0,1fr);gap:6px}.search button{padding:0 14px}.tool{padding:9px 11px;align-items:center}.tool small{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tool i{display:none}.hero{padding-top:20px}.hero h1{font-size:28px}.kicker{display:none}}
/* The home on phones (2026-10-29): the examples are one row that scrolls sideways (all four still there), and four of the most
   opened tools show (the families below and the A to Z list hold the rest). */
@media (max-width:599px){.start-grid{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;scroll-padding-inline:16px;scrollbar-width:none;gap:10px;margin:0 -16px;padding:0 16px 4px}.start-grid::-webkit-scrollbar{display:none}.start-grid>*{flex:0 0 84%;min-width:0;scroll-snap-align:start}section[aria-labelledby="top-h"] .grid>:nth-child(n+5){display:none}}
${icons.CSS}
/* Touch targets on phones (fleet audit, 2026-10-29): touch pointers only. */
@media (pointer: coarse) {
  main.wrap summary, .fold summary { min-height: 44px; }
  .sec-h a.more { position: relative; display: inline-block; }
  .sec-h a.more::after { content: ''; position: absolute; left: 0; right: 0; top: -11px; bottom: -11px; }
  .promo-out dt a { display: inline-block; min-height: 44px; }
  .promo-foot a { position: relative; display: inline-block; }
  .promo-foot a::after { content: ''; position: absolute; left: 0; right: 0; top: -12px; bottom: -12px; }
}
`;

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

function shell({ head, body, families, agent = false }) {
    // A page with a Markdown twin names it and llms.txt in the head (openvibe-shared/agent-layer).
    if (agent) {
        const canonical = (head.match(/<link rel="canonical" href="([^"]+)"/) || [])[1];
        if (canonical) head += '\n' + seo.linkHeaderTags(canonical, `${SITE}/llms.txt`).head;
    }
    // Every icon on the page once, as a sprite; the markup above only references them.
    const NETWORK = networkLinks();
    const spriteSvg = icons.sprite([..._used, ...NETWORK.map(n => n[0])]); _used = new Set();
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${head}
${appIcon.headTags({ site: 'tools', iconBase: '/assets' })}
<link rel="alternate" type="application/json" href="${SITE}/api/catalog.json" title="Tool catalog">
<script src="${ovServe.url('theme-loader.js')}" defer></script>
<link rel="stylesheet" href="${ovServe.url('kit.css')}">
<style>${CSS}</style></head><body>${spriteSvg}
${frame.serverNav({ name: NAME, service: 'tools', home: `${SITE}/` })}
<main class="wrap">${body}
${foldBlock({
        id: 'net',
        head: '<h2 id="net-h">The rest of OpenVibe</h2>',
        html: `<section aria-labelledby="net-h"><p class="sec-p">One account works on every site. Open source and community-run.</p>
<div class="net">${NETWORK.map(([ic, n, d, u]) => `<a class="tool" href="${u}">${icon(ic, 36)}<span class="tool-t"><b>${n}</b><small>${d}</small></span></a>`).join('')}</div></section>`,
    })}
</main>${frame.footer({ service: 'tools', variant: 'full', updates: '/updates' })}
<script src="${ovServe.url('navbar.js')}" defer></script><script src="${ovServe.url('footer.js')}" defer></script><script src="${ovServe.url('kit-web.js')}" defer></script><script src="/js/site.js" defer></script>
</body></html>`;
}

function head(o) {
    // The site's own social card from its pinned Frame files (openvibe-shared social/tools.jpg), like every other site;
    // the old openvibe.network/assets/og-tools.png no longer exists (404).
    return seo.headTags(Object.assign({ siteName: NAME, image: `${SITE}${social.url('tools')}`, type: 'website', locale: 'en_US' }, o));
}

const searchForm = (q) => `<form class="search" action="/search" method="get" role="search"><input type="search" name="q" id="q" value="${esc(q || '')}" placeholder="What do you need to do? Try “merge pdf” or “dns lookup”" aria-label="Search tools" autocomplete="off">${kit.button({ label: 'Search', icon: 'search' })}</form>`;

function score(t, terms) {
    let s = 0; const name = t.name.toLowerCase(); const hay = [t.tagline, t.description, ...(t.keywords || []), t.id].join(' ').toLowerCase();
    for (const w of terms) { if (name.includes(w)) s += 5; if (t.id === w) s += 4; if ((t.keywords || []).some(k => k.includes(w))) s += 3; else if (hay.includes(w)) s += 1; else if (!name.includes(w)) return 0; }
    return s;
}
// The words a person does not need in a tool request ("I want to merge some PDFs"): they only blur the scoring.
const ASK_STOP = ['i','a','an','the','my','your','to','want','need','please','help','me','can','you','with','which','tool','do','how','make','some','for','of','find','near','nearby','around'];
function search(q) {
    const terms = String(q || '').toLowerCase().split(/[^a-z0-9.+#]+/).filter(Boolean).slice(0, 8);
    if (!terms.length) return [];
    return registry.get().tools.map(t => [score(t, terms), t]).filter(x => x[0] > 0).sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name)).slice(0, 60).map(x => x[1]);
}

// ── The API, per tool (descriptors: run path, inputs, files, auth, an example) ──
const descriptorOf = (id) => require('../registry/descriptors').snapshot().tools.find((d) => d.id === id) || null;
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const mb = (bytes) => `${Math.round(bytes / 1048576)} MB`;
const hours = (sec) => { const h = Math.round((sec / 3600) * 10) / 10; return `${h} hour${h === 1 ? '' : 's'}`; };
const period = (s) => (/[.!?]$/.test(String(s)) ? String(s) : `${s}.`);
// The catalogue's FAQ, when a question names a common mistake rather than product information. A tool
// without one leaves the "what trips people up" line out (no invented caveat).
const PITFALL_RE = /(fail|error|wrong|missing|nothing|no effect|no reply|blocked|reject|refus|closed|breaks?|broke|bounc|exceed|\bold\b|\bdiffer\b|different answer|stop working|\bnot\b)/i;
const pitfallOf = (rec) => ((rec && rec.faq) || []).find(([q]) => !/^should\b/i.test(String(q)) && PITFALL_RE.test(String(q))) || null;

/**
 * The three facts every tool page states before the button: what the limits are (authored in the tool's
 * descriptor and the guard's quota table), where the file goes, and the price. A browser-side tool never
 * reaches the guard, so it has no daily cap; a server run is charged to the session tier on a satellite
 * page (its page mints ov_tools_jobs) or the address tier on an inline gateway route.
 */
function factsSection(t) {
    const d = descriptorOf(t.id);
    if (!d) return '';
    const limits = [];
    if (d.files) {
        if (d.files.maxBytes) limits.push(`${mb(d.files.maxBytes)} per file`);
        if (d.files.max) limits.push(d.files.min && d.files.min !== d.files.max ? `${d.files.min} to ${d.files.max} files` : `${d.files.max} file${d.files.max === 1 ? '' : 's'} at a time`);
    } else if (t.external || d.execution !== 'client') {
        limits.push('No file upload');
    }
    if (d.limits && d.limits.maxDurationSec) limits.push(`Up to ${hours(d.limits.maxDurationSec)}`);
    if (d.limits && d.limits.maxPages) limits.push(`Up to ${d.limits.maxPages} pages`);
    if (d.execution === 'client') {
        limits.push('No daily limit on the page');
    } else if (!t.external && d.quotaClass) {
        const tier = d.execution === 'job' ? 'session' : 'anonymous';
        const quotas = guardLimits.quotas();
        const q = quotas[d.quotaClass] && quotas[d.quotaClass][tier];
        const perDay = q && q.perDay ? Math.floor(q.perDay / (d.cost || 1)) : 0;
        if (perDay > 0) limits.push(`Up to ${perDay.toLocaleString('en-US')} runs a day`);
    }
    // The file/result retention is the job TTLs in apps/_shared/jobs/http.js; an inline lookup stores
    // nothing, and a browser tool has already kept everything on the device.
    let where;
    if (t.external) {
        let host = ''; try { host = new URL(t.external).hostname; } catch { /* not a URL: say only where it is */ }
        where = host ? `Runs on ${host}, our sister site.` : 'Runs on another OpenVibe site.';
    } else if (d.execution === 'client') {
        where = 'Runs in your browser; nothing is uploaded.';
    } else if (d.execution === 'job') {
        const kept = 'after 1 hour, or after 24 hours when signed in';
        where = d.files ? `Your file goes to our server and is deleted with the result ${kept}.` : `Runs on our server; the result is deleted ${kept}.`;
    } else {
        where = `Runs on our server; no file is uploaded.${t.id === 'webhook' ? ' Request bins are kept in memory for 1 hour.' : ''}`;
    }
    const cost = t.external || !limits.length ? 'Free.' : 'Free, with the limits above. No account needed.';
    return `<ul class="facts" aria-label="Limits, where it runs and cost">
${limits.length ? `<li><b>Limits</b> ${esc(limits.join(' · '))}</li>` : ''}
<li><b>Where it runs</b> ${esc(where)}</li><li><b>Cost</b> ${esc(cost)}</li></ul>`;
}

/** "Use it from code" on a tool's page: the one request that runs it, who may call it, what it takes. */
function apiSection(t, d = descriptorOf(t.id)) {
    if (!d) return '';
    if (!d.api) return `<section aria-labelledby="api-h"><div class="sec-h"><h2 id="api-h">Use it from code</h2></div><p class="sec-p">${esc(t.name)} runs on its page only and has no API. <a href="/developers">The Tools API</a> covers the tools you can call from code.</p></section>`;
    const ex = (d.examples || [])[0] || {};
    const token = !(d.auth && d.auth.anonymous);
    const lines = [`curl -X POST ${SITE}${d.run.path}`];
    if (token) lines.push(`-H 'Authorization: Bearer $OPENVIBE_TOKEN'`);
    if (d.files) {
        for (const f of ex.files || [{ name: 'file' }]) lines.push(`-F ${shq(`file=@${f.name}`)}`);
        if (ex.input && Object.keys(ex.input).length) lines.push(`-F ${shq(`input=${JSON.stringify(ex.input)}`)}`);
    } else {
        lines.push(`-H 'Content-Type: application/json'`, `-d ${shq(JSON.stringify({ input: ex.input || {} }))}`);
    }
    const who = d.auth && d.auth.capability === 'tools.net.probe'
        ? 'Needs a token with <code>tools.net.probe</code>, granted to partners only; people use the page.'
        : token ? 'Needs a signed-in browser session or a token with <code>tools.tool.run</code>.'
            : 'No account needed: anonymous calls run on the lowest quota tier; a token with <code>tools.tool.run</code> raises it.';
    const files = d.files ? `Takes ${d.files.min === d.files.max ? d.files.min : `${d.files.min} to ${d.files.max}`} file${d.files.max === 1 ? '' : 's'}${d.files.maxBytes ? `, up to ${mb(d.files.maxBytes)} each` : ''}.` : '';
    const how = d.execution === 'job' ? 'Long work answers 202 with a job to follow; short work answers with the result.' : 'It answers with the result.';
    return `<section class="api-box" aria-labelledby="api-h"><div class="sec-h"><h2 id="api-h">Use it from code</h2></div>
<ul class="api-facts"><li><code>${esc(d.run.method)} ${esc(SITE + d.run.path)}</code></li><li>${who}</li><li>${esc([how, files].filter(Boolean).join(' '))}</li></ul>
<pre tabindex="0"><code>${esc(lines.join(' \\\n  '))}</code></pre>
<p class="sec-p">Inputs: <a href="/api/v1/tools/${esc(d.id)}/schema">JSON Schema</a> · <a href="/api/v1/openapi.json">OpenAPI</a> · from JavaScript: <code>tools.run(${esc(JSON.stringify(d.id))}, …)</code> in <a href="https://github.com/OpenVibers/OpenVibe.SDK">openvibe-sdk</a> · <a href="/developers">How the API works</a></p></section>`;
}

/** The home's questions: shown on the page and published as its FAQPage, from this one list. */
const HOME_FAQ = [
    ['Are the tools free?', 'Yes. Every tool on OpenVibe.Tools is free to use, with fair-use limits per address so the shared servers stay fast for everyone.'],
    ['Do I need an account?', 'No. Every tool works without signing in, and anonymous results stay available for an hour. Signed in, results keep for 24 hours and your recent tools follow you across devices.'],
    ['What happens to the files I upload?', 'Many tools run in your browser, so the file never leaves your device. The rest process files on OpenVibe\'s own servers and delete them with their results when they expire: after an hour without an account, after 24 hours with one.'],
    ['Can I use the tools from my own code?', 'Yes. Most tools have an API: one POST request per tool, jobs for long work, an OpenAPI document and the openvibe-sdk client for JavaScript.'],
    ['Is OpenVibe.Tools open source?', 'Yes. The code is on GitHub under OpenVibers and the site is community-run.'],
];

// ── Pages ────────────────────────────────────────────────────
function pageIndex(top = [], activity = { available: false }) {
    // Only built tools: a home never shows what is planned (plan §1 "no placeholders").
    const { tools, families } = registry.get();
    const byId = new Map(tools.map(t => [t.id, t]));
    const fams = families.filter(f => f.path);
    const withApi = require('../registry/descriptors').snapshot().tools.filter((d) => d.api && d.status !== 'unavailable').length;
    // Most opened this week (registry/opens.js): real counts, shown once at least four tools have some.
    const opened = top.map((r) => [byId.get(r.tool), r.opens]).filter(([t, n]) => t && n > 0).slice(0, 6);
    const openedCard = ([t, n]) => toolCard(t).replace('</small><i>', `</small><i><span class="opens">${n.toLocaleString('en-US')} ${n === 1 ? 'person' : 'people'} this week</span> · `);
    const startLink = (t) => `href="${esc(t.url)}"${go(t)}`;
    const startCard = (id, inner) => { const t = byId.get(id); return t ? `<a class="start" ${startLink(t)}>${inner(t)}</a>` : ''; };
    const host = (t) => esc(hostLabel(t.hosts.short || t.hosts.canonical));

    // The live demo and the JSON card show real transforms of real input. The bold-script
    // transform matches the text engine's contiguous Unicode block; the JS in /js/site.js uses
    // the same arithmetic.
    const sample = 'OpenVibe is handy';
    const boldText = (s) => [...s].map((ch) => {
        const u = ch.codePointAt(0);
        if (u >= 65 && u <= 90) return String.fromCodePoint(0x1D4D0 + u - 65);
        if (u >= 97 && u <= 122) return String.fromCodePoint(0x1D4EA + u - 97);
        return ch;
    }).join('');
    const titleText = (s) => s.replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
    const countText = (s) => { const w = (s.trim().match(/\S+/g) || []).length; const n = [...s].length; return `${w} word${w === 1 ? '' : 's'} · ${n} character${n === 1 ? '' : 's'}`; };
    const fancy = byId.get('fancy'), caseTool = byId.get('case'), countTool = byId.get('count');
    const demo = fancy && caseTool && countTool ? `<aside class="promo" aria-labelledby="demo-h">
<div class="promo-head"><h2 id="demo-h">Try it now</h2><p>One line in. Three text tools answer as you type.</p></div>
<label for="demo-text">Your text</label>
<input id="demo-text" name="demo-text" type="text" value="${esc(sample)}" maxlength="60" autocomplete="off" spellcheck="false">
<dl class="promo-out">
<div><dt><a href="/tool/fancy">Fancy text</a></dt><dd><output id="demo-fancy" for="demo-text">${esc(boldText(sample))}</output></dd></div>
<div><dt><a href="/tool/case">Title case</a></dt><dd><output id="demo-case" for="demo-text">${esc(titleText(sample))}</output></dd></div>
<div><dt><a href="/tool/count">Words and characters</a></dt><dd><output id="demo-count" for="demo-text">${esc(countText(sample))}</output></dd></div>
</dl>
<p class="promo-foot"><a ${startLink(fancy)}>Open Fancy Text ${arrowRight}</a></p>
</aside>` : '';
    const jsonIn = '{"b":1,"a":2}';
    const jsonOut = JSON.stringify(JSON.parse(jsonIn), null, 2);
    const available = tools.filter(t => t.status !== 'unavailable');
    const rankedIds = (activity.popular || []).map(t => t.id);
    const quickTools = [...new Set([...rankedIds, ...POPULAR, ...available.map(t => t.id)])].map(id => byId.get(id)).filter(t => t && t.status !== 'unavailable').slice(0, 12);
    const quick = quickTools.map(t => kit.button({ href: t.url, label: t.name, kind: 'quiet' }).replace('<span>', icon(t.icon, 20) + '<span>'));
    const phrases = { reputation: 'check a domain or IP address', yt: 'save a video', logo: 'make a logo', ssl: 'check a TLS certificate', trim: 'trim your audio', regex: 'test a regular expression', maps: 'find places nearby', food: 'find a meal nearby', mergepdf: 'merge your PDFs', dns: "check a domain’s DNS", compress: 'shrink an image', json: 'format your JSON', jsonminify: 'minify your JSON', fancy: 'restyle your text', whois: 'look up a domain', convert: 'convert your images', resize: 'resize your images', mp3: 'convert your audio' };
    // A tool with no hand-written phrase speaks in its own tagline: its first clause, as the end of "Small tools
    // that …" ("Look up DNS records for any domain: A, AAAA…" → "look up DNS records for any domain"). An acronym
    // keeps its capitals. "help with <name>" was the old fallback, and read like a form letter.
    // Only a clause that starts with a doing word finishes the sentence (the owner, 2026-11-10, on "Small tools that one
    // reputation report for a domain or IP": "the wording is kind of awkward"); a tagline that names a thing instead is
    // skipped, never bent into the sentence. A question or an exclamation ends the clause too.
    const clause = headlineClause;
    const spoken = quickTools.map(t => [t, phrases[t.id] || clause(t)]).filter(([, p]) => p).slice(0, 6);
    // Every phrase is in the page as a link to its tool, stacked in one grid cell: the cell is as tall as the tallest,
    // so the swap never moves the page, and each tool is a plain link a crawler reads. One shows at a time.
    const headlineHtml = spoken.length
        ? `<span class="hm-rot" id="tool-headline">${spoken.map(([t, p], i) => `<a class="hm-ph${i ? '' : ' is-on'}" href="${esc(t.url)}"${go(t)}${i ? ' aria-hidden="true" tabindex="-1"' : ''}>${esc(p)}.</a>`).join('')}</span>`
        : '<span class="hm-rot">finish the job.</span>';
    const rows = (items, trend = false) => `<ul class="ovk-list">${items.slice(0,6).map(t => { const n = Number(t.uses || 0); return kit.row({ href: t.url, mark: icon(t.icon, 28), title: t.name, sub: t.description, meta: t.added_at ? `Added ${t.added_at}` : `${n.toLocaleString('en-US')} ${n === 1 ? 'use' : 'uses'}`, trail: trend ? `<span aria-label="Up ${t.increase} uses">${arrowUp} +${t.increase}</span>` : '' }); }).join('')}</ul>`;
    // One ranking as a section of its own: the heading, the line that says what the numbers mean, then the rows.
    const rankedSection = (title, items, { trend = false, note = '' } = {}) => `<section><h2>${title}</h2>${note ? `<p class="sec-p">${note}</p>` : ''}${items && items.length ? rows(items, trend) : `<p class="sec-p">${activity.available ? 'No recorded activity in this window yet.' : 'Usage is temporarily unavailable.'}</p>`}</section>`;
    const discoveryHtml = `<section aria-labelledby="live-h"><h2 id="live-h">Live usage</h2><p class="sec-p">${activity.available ? `<b>${Number(activity.uses_today || 0).toLocaleString('en-US')}</b> successful uses today (UTC).` : 'Live usage is temporarily unavailable.'} Counts cover successful API runs, including completed file jobs. Browser-only edits and page opens are not counted. Updated every minute.</p></section>
${rankedSection('Trending this hour', activity.hour, { trend: true, note: 'Tools whose use rose over the last hour compared with the hour before it.' })}
${rankedSection('Most popular', activity.popular, { note: 'Successful uses over the last seven days.' })}
${rankedSection('Trending this week', activity.week, { trend: true, note: 'Rising use compared with the preceding seven days.' })}
${activity.newest && activity.newest.length ? `<section><h2>Newest tools</h2>${rows(activity.newest)}</section>` : ''}`;
    const body = `<div class="hero hero-split">
<div class="hero-copy"><p class="kicker">Open source · community-run · no account needed to start</p>
<div class="hm-title"><h1>Small tools that ${headlineHtml}</h1><button id="headline-motion" class="hm-motion" type="button" aria-label="Pause the headline" title="Pause the headline" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path class="hm-pause" d="M9 6v12M15 6v12"/><path class="hm-play" d="M8 5.5v13l11-6.5z"/></svg></button></div>
<p class="hero-sub">Convert a file, merge a PDF, format JSON, check DNS: ${tools.length} tools that open in the browser and get out of your way. Free, and no sign-up to look.</p>
${searchForm('')}
<nav class="quick-strip" data-ovk-scroll="drift" aria-label="${rankedIds.length ? 'Popular tools' : 'Explore tools'}">${quick.join('')}</nav></div>
${demo}</div>
<section aria-labelledby="ask-tool-h"><h2 id="ask-tool-h">Ask Vibe which tool</h2><p class="sec-p">Describe your task to find a matching tool in this catalog.</p><form class="search" action="/ask-tool" method="get"><input name="q" aria-label="What would you like to do?" placeholder="I want to merge PDFs" maxlength="160" required>${kit.button({ label: 'Find a tool', icon: 'search' })}</form></section>
${discoveryHtml}
<ul class="stats"><li><b>${tools.length}</b> tools</li><li><b>${fams.length}</b> families</li><li><b>${withApi}</b> with an API</li><li>nothing to install</li></ul>
<section id="results" hidden aria-live="polite"><div class="sec-h"><h2>Results</h2></div><div class="grid" id="results-grid"></div><p class="empty" id="results-empty" hidden>No tool matches that yet. <a href="/all-tools">Browse every tool</a>.</p></section>
<section id="recent" hidden aria-labelledby="recent-h"><div class="sec-h"><h2 id="recent-h">Your tools</h2><span class="more" id="recent-note"></span></div><div class="grid" id="recent-grid"></div></section>
<section aria-labelledby="start-h"><div class="sec-h"><h2 id="start-h">Good places to start</h2><a class="more" href="/all-tools">A to Z list</a></div>
<p class="sec-p">Real examples, not a feature list. Each card opens the tool itself.</p>
<div class="start-grid">
${startCard('json', (t) => `<span class="start-name">${esc(t.name)}<small>${host(t)}</small></span><pre tabindex="0"><code>${esc(jsonIn)}</code></pre><span class="start-arrow" aria-hidden="true">${arrowDown}</span><pre tabindex="0"><code>${esc(jsonOut)}</code></pre><span class="start-go">Format JSON ${arrowRight}</span>`)}
${startCard('mergepdf', (t) => `<span class="start-name">${esc(t.name)}<small>${host(t)}</small></span><div class="flow" aria-hidden="true"><span>PDF</span><span>PDF</span><span>PDF</span><span class="flow-arrow">${arrowRight}</span><span class="flow-out">one PDF</span></div><p class="start-note">Drop the files, drag them into order, download one document.</p><span class="start-go">Merge PDFs ${arrowRight}</span>`)}
${startCard('compress', (t) => `<span class="start-name">${esc(t.name)}<small>${host(t)}</small></span><div class="flow" aria-hidden="true"><span>PNG</span><span>JPG</span><span>WebP</span><span class="flow-arrow">${arrowRight}</span><span class="flow-out">smaller file</span></div><p class="start-note">Keep the pixels, lose the weight. iPhone HEIC works too.</p><span class="start-go">Compress an image ${arrowRight}</span>`)}
${startCard('dns', (t) => `<span class="start-name">${esc(t.name)}<small>${host(t)}</small></span><div class="flow" aria-hidden="true"><span>domain</span><span class="flow-arrow">${arrowRight}</span><span class="flow-out">A · AAAA · MX · TXT</span></div><p class="start-note">See what a domain actually points at, from outside your network.</p><span class="start-go">Look up DNS ${arrowRight}</span>`)}
</div></section>
${opened.length >= 4 ? foldBlock({
        id: 'top',
        head: `<h2 id="top-h">Most opened this week <span class="fold-count">${opened.length}</span></h2>`,
        html: `<section aria-labelledby="top-h"><p class="sec-p">How many people opened each tool in the last seven days, counted once per person a day.</p><div class="grid">${opened.map(openedCard).join('')}</div></section>`,
    }) : ''}
<div class="jobs"><div class="sec-h jobs-h"><h2>Tools by category</h2><a class="more" href="/all-tools">All tools</a></div>${families.map(f => {
        const list = tools.filter(t => t.family === f.id);
        if (!list.length) return '';
        // Each category is a counted fold (the owner's short-pages rule): every tool stays in the page as a static link for
        // readers and crawlers, open where there is room and closed on a phone (184 tools made the phone home 18 000 px).
        return `<section class="job" id="job-${esc(f.id)}" aria-labelledby="job-${esc(f.id)}-h">${foldBlock({
            id: `job-${f.id}`, count: `${list.length} ${list.length === 1 ? 'tool' : 'tools'}`,
            head: `<span class="sec-h">${icon(f.icon, 28)}<h2 id="job-${esc(f.id)}-h">${esc(f.name)}</h2></span>`,
            html: `<p class="sec-p">${esc(f.tagline)}</p><ul class="ovk-list">${list.map(t => kit.row({ href: t.url, mark: icon(t.icon, 28), title: t.name, sub: t.tagline })).join('')}</ul>${f.path ? `<a class="more" href="${esc(f.path)}">More about ${esc(f.name)}</a>` : ''}`,
        })}</section>`;
    }).join('')}</div>
<section class="fold" aria-labelledby="dev-h"><details><summary><h2 id="dev-h">Use any tool from code</h2></summary><div class="sec-h"><a class="more" href="/developers">Developer guide</a></div><p class="sec-p">${withApi} of the ${tools.length} tools take one request each, the same engines the pages use. Each tool's page shows its own request.</p>
<div class="dev"><pre tabindex="0"><code>curl -X POST ${SITE}/api/v1/tools/jsonminify/run \\
  -H 'Content-Type: application/json' \\
  -d '{"input":{"text":"{ \\"a\\": 1 }"}}'</code></pre>
<ul><li><a href="/api/v1/openapi.json">OpenAPI 3.1</a>, generated from the tool descriptors</li><li><a href="/api/v1/tools">/api/v1/tools</a>: every tool's inputs, limits and access</li><li>Long work runs as a job you can follow over server-sent events</li><li><a href="https://openvibe.design/kit">OpenVibe.Design components</a> power the buttons and lists</li><li><a href="/api/v1/tools/popular">Popular tools API</a> · <a href="/api/v1/tools/trending">Trending tools API</a></li><li><a href="https://github.com/OpenVibers/OpenVibe.SDK">openvibe-sdk</a>: <code>tools.run(id, input)</code> from JavaScript</li></ul></div></details></section>
${foldBlock({
        id: 'shipped',
        head: '<h2 id="shipped-h">Recently shipped on OpenVibe.Tools</h2>',
        html: frame.shipped({ service: 'tools', title: 'Recently shipped on OpenVibe.Tools' }),
    })}
<section class="fold" aria-labelledby="acct-h"><details><summary><h2 id="acct-h">Better with an account, fine without</h2></summary><div class="perks">
<div><b>Without signing in</b><p>Every tool works. Results stay available for an hour, then they are deleted.</p></div>
<div><b>Signed in</b><p>Results keep for 24 hours, your recent tools follow you across devices, and your theme and notifications come along from the rest of OpenVibe.</p></div>
<div><b>For developers</b><p>Run any tool from code: see <a href="/developers">the Tools API</a> (<a href="/api/v1/openapi.json">OpenAPI</a>). The catalog is public JSON at <a href="/api/catalog.json">/api/catalog.json</a>, with a plain-text map at <a href="/llms.txt">/llms.txt</a>.</p></div></div></details></section>
${foldBlock({
        id: 'faq',
        head: `<h2 id="faq-h">Questions <span class="fold-count">${HOME_FAQ.length}</span></h2>`,
        html: `<section aria-labelledby="faq-h">${HOME_FAQ.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}</section>`,
    })}`;
    return shell({ families, agent: true, body, head: head({
        title: 'Online Tools for Files, Text, Code & Networks', description: `${tools.length} online tools in one place: video and audio converters, image and PDF tools, developer utilities and network diagnostics. Open source and community-run.`,
        canonical: SITE + '/', keywords: 'online tools, converter, pdf tools, image converter, developer tools, network tools, youtube downloader',
        jsonLd: [seo.jsonLd.organization(), seo.jsonLd.website({ name: NAME, url: SITE + '/', description: 'Online tools for files, text, code and networks.', searchUrl: SITE + '/search?q={search_term_string}' }),
            ...families.filter(f => tools.some(t => t.family === f.id)).map(f => seo.jsonLd.itemList(f.name, tools.filter(t => t.family === f.id).map(t => ({ name: t.name, url: t.url, description: t.tagline })), { url: f.path ? SITE + f.path : undefined })),
            seo.jsonLd.faq(HOME_FAQ.map(([q, a]) => ({ q, a })))] }) });
}

function pageFamily(f) {
    const { tools, families } = registry.get();
    const list = tools.filter(t => t.family === f.id || (t.alsoIn || []).includes(f.id));
    const url = SITE + f.path;
    const body = `<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Tools</a> ${chevronRight} ${esc(f.name)}</nav>
<div class="page-h">${icon(f.icon, 56)}<h1>${esc(f.name)}</h1></div><p class="lead">${esc(f.description)}</p>
${f.hosts ? `<a class="cta" href="${esc(f.url)}">Open ${esc(f.name)}</a>` : ''}
<section><div class="sec-h"><h2>${list.length} ${list.length === 1 ? 'tool' : 'tools'}</h2></div><p class="sec-p">${esc(f.intro || '')}</p><div class="grid">${list.map(toolCard).join('')}</div></section>
${f.faq && f.faq.length ? `<section><div class="sec-h"><h2>Questions</h2></div>${f.faq.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}</section>` : ''}`;
    return shell({ families, agent: true, body, head: head({ title: `${f.name}: ${f.tagline}`, description: f.description, canonical: url, keywords: list.slice(0, 12).map(t => t.name.toLowerCase()).join(', '),
        jsonLd: [seo.jsonLd.breadcrumbs([{ name: 'Tools', url: SITE + '/' }, { name: f.name, url }]), seo.jsonLd.itemList(f.name, list.map(t => ({ name: t.name, url: t.url, description: t.tagline }))),
            ...(f.faq && f.faq.length ? [seo.jsonLd.faq(f.faq.map(([q, a]) => ({ q, a })))] : [])] }) });
}

function pageTool(t) {
    const { tools, families } = registry.get();
    const f = families.find(x => x.id === t.family);
    const d = descriptorOf(t.id);
    const url = `${SITE}/tool/${t.id}`;
    const related = tools.filter(x => x.family === t.family && x.id !== t.id).slice(0, 6);
    const hosts = [...(t.hosts.short ? [[t.hosts.short, 'Easiest to remember']] : []), [t.hosts.canonical, t.hosts.short ? 'Search-friendly address' : 'Primary'], ...(t.hosts.mirrors || []).map(a => [a, 'Mirror']), ...t.hosts.aliases.map(a => [a, 'Redirects here'])];
    // The catalogue's own words: its meta description says what the tool is for, and its first FAQ about
    // a failure or confusion says what trips people up. Satellite-only tools have no FAQ, so that line is left out.
    const rec = seoFor(t.id);
    const purpose = rec && rec.desc ? rec.desc : t.tagline;
    const pitfall = pitfallOf(rec);
    const people = t.keywords && t.keywords.length ? `<section><div class="sec-h"><h2>People also call this</h2></div>
<p class="sec-p"><b>What it's for:</b> ${esc(period(purpose))}</p>
${pitfall ? `<p class="sec-p"><b>What trips people up:</b> <strong>${esc(pitfall[0])}</strong> ${esc(pitfall[1])}</p>` : ''}
<ul class="kw">${t.keywords.map(k => `<li>${esc(k)}</li>`).join('')}</ul></section>` : '';
    const body = `<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Tools</a> ${chevronRight} ${f && f.path ? `<a href="${esc(f.path)}">${esc(f.name)}</a> ${chevronRight} ` : ''}${esc(t.name)}</nav>
<div class="page-h">${icon(t.icon, 56)}<h1>${esc(t.name)}</h1></div><p class="lead">${esc(t.description)}</p>
${factsSection(t)}
${t.status === 'unavailable' ? `<p class="lead"><strong>Not available yet.</strong> ${esc(t.unavailable || '')}</p>` : `<a class="cta" href="${esc(t.url)}">Open ${esc(t.name)}</a>`}
<section><div class="sec-h"><h2>Where to find it</h2></div><p class="sec-p">Every address below opens the same tool. The first address is the one to bookmark and share.</p>
<ul class="hosts">${hosts.map(([h, tag], i) => `<li${i === 0 ? ' class="primary"' : ''}><a href="https://${esc(h)}/"${i === 0 ? '' : ' rel="nofollow"'}>${esc(h)}</a><span class="tag">${tag}</span></li>`).join('')}</ul></section>
${people}
${apiSection(t, d)}
${related.length ? `<section><div class="sec-h"><h2>Similar tools</h2>${f && f.path ? `<a class="more" href="${esc(f.path)}">All ${esc(f.name)}</a>` : ''}</div><div class="grid">${related.map(toolCard).join('')}</div></section>` : ''}`;
    return shell({ families, agent: true, body, head: head({ title: `${t.name}: ${t.tagline}`, description: t.description, canonical: url, keywords: (t.keywords || []).join(', '),
        jsonLd: [seo.jsonLd.breadcrumbs([{ name: 'Tools', url: SITE + '/' }, ...(f && f.path ? [{ name: f.name, url: SITE + f.path }] : []), { name: t.name, url }]),
            seo.jsonLd.softwareApp({ name: t.name, url: t.url, description: t.description, category: 'UtilitiesApplication', keywords: t.keywords })] }) });
}

function pageAll() {
    const { tools, families } = registry.get();
    const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
    const body = `<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Tools</a> ${chevronRight} All tools</nav><div class="page-h">${icon('tools', 56)}<h1>All ${tools.length} tools, A to Z</h1></div>
${searchForm('')}<section><ul class="az">${sorted.map(t => `<li><a href="${esc(t.url)}">${esc(t.name)}</a> <small><a href="${esc(t.url)}" aria-label="About ${esc(t.name)}">about</a></small></li>`).join('')}</ul></section>`;
    return shell({ families, agent: true, body, head: head({ title: `All ${tools.length} Online Tools, A to Z`, description: 'The complete list of tools on OpenVibe.Tools: converters, downloaders, PDF and image tools, text utilities, developer tools and network diagnostics.', canonical: SITE + '/all-tools',
        jsonLd: [seo.jsonLd.breadcrumbs([{ name: 'Tools', url: SITE + '/' }, { name: 'All tools', url: SITE + '/all-tools' }])] }) });
}

function pageSearch(q) {
    const { families } = registry.get();
    const hits = search(q);
    const body = `<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Tools</a> ${chevronRight} Search</nav><div class="page-h"><h1>${q ? `Tools for “${esc(q)}”` : 'Search tools'}</h1></div>${searchForm(q)}
<section>${hits.length ? `<div class="grid">${hits.map(toolCard).join('')}</div>` : `<p class="empty">${q ? 'No tool matches that yet.' : 'Type what you need to do.'} <a href="/all-tools">Browse every tool</a>.</p>`}</section>`;
    return shell({ families, body, head: head({ title: q ? `Tools for “${seo.clip(q, 30)}”` : 'Search tools', description: 'Search every tool on OpenVibe.Tools.', canonical: SITE + '/search', robots: 'noindex,follow' }) });
}

// ── Cache + router ───────────────────────────────────────────
const cache = new Map();
function cached(key, render, extra = '') {
    const ver = `${registry.get().updated}|${extra}`;
    let e = cache.get(key);
    if (!e || e.ver !== ver) { const html = render(); e = { ver, html, etag: '"' + crypto.createHash('sha1').update(html).digest('base64url').slice(0, 20) + '"' }; cache.set(key, e); }
    return e;
}
/** /developers: how to call any tool from code (run API, jobs, SDK, auth tiers, limits). */
function pageUpdates() {
    const { families } = registry.get();
    const body = `<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Tools</a> ${chevronRight} Updates</nav>${frame.updatesBody({ service: 'tools', siteName: NAME })}${`<script src="${ovServe.url('shipped.js')}" defer></script>`}`;
    return shell({ families, body, head: head({ title: 'What shipped on OpenVibe.Tools', description: 'Every change deployed to OpenVibe.Tools, newest first, with the Patch notes that gather them.', canonical: SITE + '/updates' }) });
}

function pageDevelopers() {
    const { families } = registry.get();
    const snap = require('../registry/descriptors').snapshot();
    const withApi = snap.tools.filter((t) => t.api && t.status !== 'unavailable');
    // A long command scrolls inside its block, not the page (it overflowed at 768 px); tabindex lets a keyboard scroll it.
    const code = (s) => `<pre tabindex="0"><code>${esc(s)}</code></pre>`;
    // The table's numbers come from the guard's real quota table, not from a copy that can drift.
    const quotas = require('../../../_shared/guard/limits').quotas();
    const rate = (cls, tier = 'anonymous') => { const q = quotas[cls] && quotas[cls][tier]; return q ? `${q.perMinute.toLocaleString('en-US')}/min${q.perDay ? ` · ${q.perDay.toLocaleString('en-US')}/day` : ''}` : '—'; };
    const apiRows = [
        ['POST /api/v1/tools/{id}/run', 'Run a tool inline; long work answers with a job', 'Anonymous; session or token for file jobs', rate('tools-run'), `curl -X POST ${SITE}/api/v1/tools/fancy/run`],
        ['GET /api/v1/tools', 'List every tool with its inputs, limits and access', 'Public', rate('tools-api'), `curl ${SITE}/api/v1/tools?api=true`],
        ['GET /api/v1/tools/{id}/schema', "JSON Schema for a tool's input and output", 'Public', rate('tools-api'), `curl ${SITE}/api/v1/tools/fancy/schema`],
        ['POST /api/v1/jobs', 'Start a long job with files and follow it', 'Session or token for file jobs', rate('tools-job'), `curl -X POST ${SITE}/api/v1/jobs`],
        ['GET /api/v1/jobs/{id}/events', 'Follow one job as server-sent events', "The job's owner", rate('tools-api'), `curl -N ${SITE}/api/v1/jobs/{id}/events`],
        ['GET /api/v1/jobs/{id}/files/{n}', "Download a finished job's result file", "The job's owner", rate('tools-api'), `curl -O ${SITE}/api/v1/jobs/{id}/files/0`],
    ];
    const body = `<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Tools</a> ${chevronRight} Developers</nav><div class="page-h">${icon('code', 56)}<h1>Tools API</h1></div>
<p class="lead">${withApi.length} of ${snap.tools.length} tools can be called from code, with the same engines the pages use. One request shape for all of them; long work runs as a job you can follow.</p>
<section><div class="sec-h"><h2>At a glance</h2></div><p class="sec-p">The six calls behind every tool. Rate limits are the anonymous allowance; signing in or using a token raises it, and a tool's cost counts against the limit.</p>
<table class="api-table" role="table"><caption class="sr-only">Tools API endpoints, what they do, who may call them, their anonymous rate limit and an example request</caption>
<thead><tr role="row"><th scope="col" role="columnheader">Endpoint</th><th scope="col" role="columnheader">Purpose</th><th scope="col" role="columnheader">Auth</th><th scope="col" role="columnheader">Rate limit</th><th scope="col" role="columnheader">Example</th></tr></thead>
<tbody>${apiRows.map((r) => `<tr role="row"><td role="cell" data-label="Endpoint"><code>${esc(r[0])}</code></td><td role="cell" data-label="Purpose">${esc(r[1])}</td><td role="cell" data-label="Auth">${esc(r[2])}</td><td role="cell" data-label="Rate limit">${esc(r[3])}</td><td role="cell" data-label="Example"><code>${esc(r[4])}</code></td></tr>`).join('')}</tbody></table>
<p class="sec-p">Over a limit is <b>429</b> with <code>Retry-After</code>; every answer also carries <code>RateLimit-*</code> headers. Errors are RFC 9457 problems with a stable <code>code</code>.</p></section>
<section><div class="sec-h"><h2>Discover</h2></div><p class="sec-p">Every tool is described by a machine-readable descriptor (inputs as JSON Schema, file limits, how it runs, who may call it).</p>
<ul><li><a href="/api/v1/tools">/api/v1/tools</a>: the registry (filter with <code>?family=</code>, <code>?q=</code>, <code>?api=true</code>)</li>
<li><code>/api/v1/tools/{id}</code> and <code>/api/v1/tools/{id}/schema</code>: one tool</li>
<li><a href="/api/v1/openapi.json">/api/v1/openapi.json</a>: OpenAPI 3.1, generated from the descriptors</li>
<li><a href="/api/v1/tools/popular">/api/v1/tools/popular</a>: the tools people use most over the last seven days, and <a href="/api/v1/tools/trending">/api/v1/tools/trending</a>: the ones whose use is rising (<code>?window=hour</code> or <code>week</code>)</li></ul></section>
<section><div class="sec-h"><h2>Run a tool</h2></div>
${code(`curl -X POST ${SITE}/api/v1/tools/jsonminify/run \\
  -H 'Content-Type: application/json' \\
  -d '{"input":{"text":"{ \\"a\\": 1 }"}}'
# returns {"state":"succeeded","tool":"jsonminify","result":{"text":"{\\"a\\":1}"},"took_ms":3}`)}
<p class="sec-p">File tools take <code>multipart/form-data</code> (<code>file</code> parts plus an <code>input</code> JSON part). Work that outlasts <code>wait_ms</code> answers <b>202</b> with a job: follow it at <code>/api/v1/jobs/{id}/events</code> (server-sent events) and download results from <code>/api/v1/jobs/{id}/files/{n}</code>. Send an <code>Idempotency-Key</code> header to make retries safe.</p></section>
<section><div class="sec-h"><h2>From JavaScript</h2></div>
${code(`const { createClient } = require('openvibe-sdk/core');
const { createToolsClient } = require('openvibe-sdk/tools');
const tools = createToolsClient(createClient({}));
const out = await tools.run('jsonminify', { text: '{ "a": 1 }' });
const job = await tools.run('png', { format: 'png' }, { files: [fileBlob] });
const done = await job.wait();   // any tool, sync or job`)}
<p class="sec-p">The SDK is <a href="https://github.com/OpenVibers/OpenVibe.SDK">openvibe-sdk</a> (this site pins v0.67.0). It retries on 429 after <code>Retry-After</code> and generates idempotency keys for you.</p></section>
<section id="worker-routing"><h2>Where jobs run</h2>
<p>Send <code>X-Tools-Prefer: auto</code>, <code>home</code> or <code>host</code> on a run request. <code>host</code> keeps work on the host. <code>home</code> is advisory and respects the owner's routing order. Worker routing is off until the owner enables it. URL-fetching jobs always stay on the host.</p>
<p>File jobs can use an eligible worker, ranked by the owner's order, free slots and recent latency. A disconnected job gets one retry elsewhere; without a worker, the host runs it.</p>
<p>Read <code>result.data.execution</code> on a completed job, or <code>error.execution</code> on failure/cancellation: worker id, location, total execution milliseconds and each attempt. Poll the same job with <code>tools.jobs.get(id)</code>.</p>
${code(`const run = await tools.run('png', {}, { files: [fileBlob], prefer: 'host' });
const done = await run.wait();
const job = await tools.jobs.get(done.job.id);
job.result.data.execution;`)}
<p>The <code>prefer</code> SDK option is staged for the next SDK release. Until that release, send the HTTP header directly. The <a href="/api/v1/openapi.json">OpenAPI document</a> includes the header and receipt schema.</p></section>
<section><div class="sec-h"><h2>Access and limits</h2></div>
<ul><li><b>Anonymous</b>: most tools, on the lowest quota tier, per address. Tools that handle files people should not share anonymously (audio, PDF) need a browser session or a token.</li>
<li><b>Apps and services</b>: a token from <a href="https://openvibe.network">OpenVibe.Network</a> for audience <code>openvibe.tools</code> with <code>tools.tool.run</code> (developer sandbox apps get it by default) raises the tier.</li>
<li><b>Network probes</b> (port checks, ping, latency) need <code>tools.net.probe</code>, granted to partners only. The YouTube downloader has no API.</li>
<li>Every answer carries <code>RateLimit-*</code> headers; over the limit is <b>429</b> with <code>Retry-After</code>. Errors are RFC 9457 problems with a stable <code>code</code>.</li></ul></section>`;
    return shell({ families, body, head: head({ title: 'Tools API for developers', description: `Call ${withApi.length} OpenVibe tools from code: one run API, jobs for long work, an OpenAPI document and the openvibe-sdk client.`, canonical: SITE + '/developers',
        jsonLd: [seo.jsonLd.breadcrumbs([{ name: 'Tools', url: SITE + '/' }, { name: 'Developers', url: SITE + '/developers' }])] }) });
}

function send(req, res, key, render, type, extra) {
    const e = cached(key, render, extra);
    if (!type || /^text\/html/.test(type)) {
        const isAgentPage = key === '/' || key === '/all-tools' || key.startsWith('/tool/')
            || registry.get().families.some((f) => f.path === key);
        if (isAgentPage) res.set('Link', seo.linkHeaderTags(`${SITE}${key === '/' ? '/' : key}`, `${SITE}/llms.txt`).header);
    }
    res.set('Content-Type', type || 'text/html; charset=utf-8');
    res.set('Cache-Control', key === '/' ? 'public, max-age=60' : 'public, max-age=300, stale-while-revalidate=86400');
    res.set('ETag', e.etag);
    if (req.headers['if-none-match'] === e.etag) return res.status(304).end();
    res.send(e.html);
}

// /workers (tools-anywhere, part 4; its look 2026-11-11): lend a computer to Tools. Three steps in the order a person
// takes them (check, install, turn on), the facts as chips, the one command with Copy. Page-scoped styles (wk-*).
const WORKERS_CSS = `.wk{max-width:880px;margin:0 auto;padding:8px 0 24px}
.wk-kicker{margin:0 0 8px;font-size:13px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--accent-light,#60a5fa)}
.wk h1{margin:0 0 12px;font-size:clamp(30px,5vw,46px);line-height:1.06;letter-spacing:-.03em;font-weight:800}
.wk-sub{margin:0 0 18px;max-width:60ch;font-size:clamp(15.5px,1.6vw,17.5px);line-height:1.55;color:var(--text-secondary,#a8b3c4)}
.wk-facts{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 28px;padding:0;list-style:none}
.wk-facts li{display:inline-flex;align-items:center;gap:7px;min-height:34px;padding:0 12px;border-radius:999px;border:1px solid var(--border,rgba(148,163,184,.18));background:color-mix(in srgb,var(--text-primary,#e6edf7) 4%,transparent);font-size:13.5px;font-weight:600;color:var(--text-primary,#e6edf7)}
.wk-facts svg{width:16px;height:16px;color:var(--accent-light,#60a5fa)}
.wk-steps{counter-reset:wk;display:grid;gap:12px;margin:0 0 24px;padding:0;list-style:none}
.wk-step{counter-increment:wk;position:relative;min-width:0;padding:16px 18px 16px 72px;border-radius:18px;border:1px solid var(--border,rgba(148,163,184,.16));background:var(--bg-card,#111a2b)}
.wk-step::before{content:counter(wk);position:absolute;left:18px;top:16px;display:grid;place-items:center;width:36px;height:36px;border-radius:12px;background:color-mix(in srgb,var(--accent,#3b82f6) 16%,transparent);color:var(--accent-light,#60a5fa);font-weight:800;font-size:16px}
.wk-step h2{margin:5px 0 4px;font-size:18px;letter-spacing:-.01em}
.wk-step p{margin:0;color:var(--text-secondary,#a8b3c4);line-height:1.55}
.wk-step small{display:block;margin-top:8px;color:var(--text-muted,#7d8aa0);font-size:13px}
.wk-step.is-owner{border-style:dashed}
.wk-code{display:flex;align-items:center;gap:8px;min-width:0;margin:10px 0 0;padding:6px 6px 6px 14px;border-radius:12px;background:#070b14;border:1px solid var(--border,rgba(148,163,184,.16))}
.wk-code code{flex:1;min-width:0;overflow-x:auto;white-space:nowrap;padding:6px 0;font:13.5px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#d6e2f5;scrollbar-width:thin}
.wk-copy{flex:none;height:34px;padding:0 12px;border:0;border-radius:9px;background:color-mix(in srgb,var(--text-primary,#e6edf7) 9%,transparent);color:var(--text-primary,#e6edf7);font:inherit;font-size:13px;font-weight:650;cursor:pointer}
.wk-copy:hover,.wk-copy:focus-visible{background:color-mix(in srgb,var(--accent,#3b82f6) 22%,transparent)}
.wk-cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:0 0 20px}
.wk-card{padding:16px 18px;border-radius:18px;background:color-mix(in srgb,var(--text-primary,#e6edf7) 3%,transparent);border:1px solid var(--border,rgba(148,163,184,.12))}
.wk-card h2{margin:0 0 6px;font-size:16px}
.wk-card p{margin:0;color:var(--text-secondary,#a8b3c4);line-height:1.55;font-size:14.5px}
.wk-api{display:inline-flex;align-items:center;gap:8px;min-height:44px;font-weight:650;color:var(--accent-light,#60a5fa);text-decoration:none}
.wk-api:hover{text-decoration:underline}
@media (max-width:640px){.wk-cards{grid-template-columns:1fr}.wk-step{padding:14px 14px 14px 60px}.wk-step::before{left:14px;top:14px;width:32px;height:32px;border-radius:10px}}`;

const WK_IC = {
    out: '<path d="M7 17L17 7M9 7h8v8"/>',
    size: '<path d="M4 7h16M4 12h10M4 17h6"/>',
    slots: '<rect x="4" y="5" width="16" height="6" rx="2"/><rect x="4" y="13" width="16" height="6" rx="2"/>',
    cpu: '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"/>',
    update: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/>',
};
const wkIc = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${WK_IC[k]}</svg>`;

function pageWorkers() {
    const check = 'bash install.sh --dry-run --prefix /tmp/tools-worker-check-new';
    const steps = [
        ['Check', 'See that your computer can reach Tools. Nothing is installed and no job runs.'],
        ['Install', 'Run the worker as a service, with the installer and the setup instructions.'],
        ['Turn on', "Tools' owner creates the worker's credential once and turns its routing on. Until then it takes no jobs."],
    ];
    const howTo = { '@context': 'https://schema.org', '@type': 'HowTo', name: 'Run OpenVibe Tools on your own machine', description: 'Lend a computer to OpenVibe Tools: check it, install the worker, turn its routing on.',
        step: steps.map(([name, text], i) => ({ '@type': 'HowToStep', position: i + 1, name, text })) };
    return shell({ families: registry.get().families, head: head({ title: 'Run Tools on your own machine', description: 'Lend a computer to OpenVibe Tools: it converts pictures, PDFs and audio over one outbound connection. Check, install, turn on.', canonical: SITE + '/workers',
        jsonLd: [seo.jsonLd.breadcrumbs([{ name: 'Tools', url: SITE + '/' }, { name: 'Run on your machine', url: SITE + '/workers' }]), howTo] }), body: `<style>${WORKERS_CSS}</style><main class="wk">
<p class="wk-kicker">For your own computers</p>
<h1>Run Tools on your own machine</h1>
<p class="wk-sub">Lend a computer to OpenVibe Tools. It converts uploaded pictures, PDFs and audio for people, over one encrypted connection it opens itself: no open port, no public address.</p>
<ul class="wk-facts" aria-label="What a worker is">
<li>${wkIc('out')}Outbound only</li><li>${wkIc('size')}16 MiB in, 16 MiB out</li><li>${wkIc('slots')}Two jobs at once</li><li>${wkIc('cpu')}2 CPU cores, 2 GiB</li><li>${wkIc('update')}Updates itself daily</li>
</ul>
<ol class="wk-steps">
<li class="wk-step"><h2>${steps[0][0]}</h2><p>${steps[0][1]}</p>
<div class="wk-code"><code id="wk-check">${check}</code><button type="button" class="wk-copy" data-wk-copy="wk-check" aria-label="Copy the command">Copy</button></div>
<small>Ubuntu, with Node 22 or newer. It checks HTTPS and the outbound WebSocket, and makes no service.</small></li>
<li class="wk-step"><h2>${steps[1][0]}</h2><p>Run the worker as a service, with the <a href="/worker/install.sh">installer</a> and the <a href="https://github.com/OpenVibers/OpenVibe.Tools/blob/main/apps/worker/README.md">setup instructions</a>.</p>
<small>Keep its credential in a private file, never on a command line.</small></li>
<li class="wk-step is-owner"><h2>${steps[2][0]}</h2><p>${steps[2][1]}</p></li>
</ol>
<div class="wk-cards">
<section class="wk-card"><h2>What it runs</h2><p>Picture, PDF and audio conversions. A job that fetches a web address stays on OpenVibe's own server.</p></section>
<section class="wk-card"><h2>Stopping it</h2><p>Drain a worker and it takes no new jobs; the ones running finish first.</p></section>
</div>
<a class="wk-api" href="/developers#worker-routing">API routing and receipts <span aria-hidden="true">${arrowRight}</span></a>
</main>
<script>document.querySelectorAll('[data-wk-copy]').forEach(function (b) { b.addEventListener('click', function () { var t = document.getElementById(b.getAttribute('data-wk-copy')); if (!t || !navigator.clipboard) return; navigator.clipboard.writeText(t.textContent).then(function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy'; }, 1600); }); }); });</script>` });
}

function sitemapEntries() {
    const { tools, families } = registry.get();
    const today = new Date().toISOString().slice(0, 10);
    return [{ loc: SITE + '/', changefreq: 'daily', priority: 1 }, { loc: SITE + '/all-tools', changefreq: 'weekly', priority: 0.8 }, { loc: SITE + '/developers', changefreq: 'weekly', priority: 0.7 }, { loc: SITE + '/updates', changefreq: 'daily', priority: 0.4 },
        ...families.filter(f => f.path).map(f => ({ loc: SITE + f.path, changefreq: 'weekly', priority: 0.9 })),
        ...families.filter(f => f.hosts).map(f => ({ loc: f.url, changefreq: 'weekly', priority: 0.9 })),
        ...tools.filter(t => !t.external).map(t => ({ loc: t.url, changefreq: 'weekly', priority: 0.8 })),
    ].map(u => Object.assign({ lastmod: today }, u));
}

// ── llms.txt + llms-full.txt ─────────────────────────────────
// The public pages, once, as the data both artifacts read: /llms.txt lists each with its tagline,
// /llms-full.txt carries the same pages with their full description. One source, so the two can
// never disagree about what is public. The noindex search page and the site's own /tool/*,
// /developers and /updates pages were never in llms.txt and stay out of both.
// AGT-5: the site's own pages go in first, at their Markdown twins; every tool is on another subdomain.
function llmsSections() {
    const { tools, families } = registry.get();
    return [
        { title: 'This site', links: [
            { title: NAME, url: SITE + '/', note: 'the home page, and the week\'s most opened tools', text: 'The home page of OpenVibe.Tools: the tool families and the week\'s most opened tools.' },
            { title: 'Every tool', url: SITE + '/all-tools', note: 'the whole catalogue on one page, by family', text: 'Every online tool OpenVibe.Tools serves, grouped by family, on one page.' },
        ] },
        ...families.filter(f => f.path).map(f => ({
            title: f.name,
            links: tools.filter(t => t.family === f.id).map(t => ({ title: t.name, url: t.url, note: t.tagline, text: t.description || t.tagline })),
        })),
    ];
}
function llmsSummary() {
    const { tools } = registry.get();
    return `${tools.length} online tools for files, text, code and networks. Open source and community-run. A machine-readable catalog is at ${SITE}/api/catalog.json.`;
}
function llmsTxtBody() {
    // AGT-5: each of this site's own pages is linked at its Markdown twin (markdown: true, base: SITE). Every tool
    // is on another subdomain, so its link keeps its URL; /developers has no twin yet (llms-twins-probe, 11-03), so
    // it keeps its URL and says (HTML). The API stays in a main section: it is what an agent came for.
    return seo.llmsTxt({ name: NAME, markdown: true, base: SITE, summary: llmsSummary(),
        sections: [{ title: 'API', links: [{ title: 'Developer guide', url: SITE + '/developers', note: 'run any tool from code' }, { title: 'OpenAPI 3.1', url: SITE + '/api/v1/openapi.json' }, { title: 'Tool registry (JSON)', url: SITE + '/api/v1/tools' }] }].concat(llmsSections()),
        // llmstxt.org's "## Optional": what an agent may skip when it needs a shorter context.
        optional: [
            { title: 'Full text (llms-full.txt)', url: SITE + '/llms-full.txt', note: 'the public pages above as one plain-text document' },
            { title: 'Sitemap', url: SITE + '/sitemap.xml' },
            { title: 'robots.txt', url: SITE + '/robots.txt' },
        ] });
}
// /llms-full.txt: the same header and summary as /llms.txt, then every public page llms.txt lists
// with its text, under the same sections. The 512 KB ceiling keeps the answer a document, not a
// payload — llmsFull stops before the page that would pass it.
const LLMS_FULL_MAX_BYTES = 512 * 1024;
function llmsFullBody() {
    return seo.llmsFull({ site: { name: NAME, url: SITE }, summary: llmsSummary(), maxBytes: LLMS_FULL_MAX_BYTES,
        sections: llmsSections().map(s => ({ title: s.title, pages: s.links.map(l => ({ title: l.title, url: l.url, text: l.text })) })) });
}

function createSiteRouter({ opens = null, discovery = null } = {}) {
    const router = express.Router();
    // One canonical address per tool: its primary host. The directory's /tool/<id> page is only a pointer, so it
    // 301s there (query kept) instead of competing with the tool's own self-canonical page. Its Markdown twin keeps
    // the same canonical, so HTML, twin, sitemap and llms.txt all name one URL.
    router.get('/tool/:id.md', (req, res, next) => {
        const t = registry.get().tools.find((x) => x.id === req.params.id);
        if (!t) return next();
        const { markdownTwin } = require('openvibe-shared/agent-layer');
        const body = markdownTwin({ html: pageTool(t), canonical: t.url });
        return res.set('Content-Type', 'text/markdown; charset=utf-8').set('Cache-Control', 'public, max-age=300').send(body);
    });
    router.get('/tool/:id', (req, res, next) => {
        const t = registry.get().tools.find((x) => x.id === req.params.id);
        if (!t) return next();
        const q = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
        return res.redirect(301, `${t.url}${q}`);
    });
    // Markdown twin and agent manifest requests go to openvibe-shared/agent-layer, mounted after this router.
    router.use((req, res, next) => {
        const p = String(req.path || '');
        if (p.endsWith('.md') || p.startsWith('/.well-known/') || (req.query && req.query.format === 'markdown')
            || req.accepts(['html', 'text/markdown']) === 'text/markdown') return next('router');
        return next();
    });
    const apexOnly = (req, res, next) => (!req.ovHost || req.ovHost.kind === 'apex' || (req.ovHost.kind === 'unknown' && !req.ovHost.inZone) ? next() : next('router'));
    router.use(apexOnly);
    router.get('/api/v1/openapi.json', (req, res) => { res.set('Access-Control-Allow-Origin', '*'); send(req, res, 'openapi', () => JSON.stringify(require('../openapi').openapi(require('../registry/descriptors').snapshot(), SITE)), 'application/json; charset=utf-8'); });
    router.get('/workers', (req, res) => send(req, res, 'workers', pageWorkers));
    router.get('/developers', (req, res) => send(req, res, 'developers', pageDevelopers));
    // What shipped on OpenVibe.Tools: the shared update log every OpenVibe site has.
    router.get('/updates', (req, res) => send(req, res, 'updates', pageUpdates));
    router.get('/api/catalog.json', (req, res) => { res.set('Access-Control-Allow-Origin', '*'); send(req, res, 'catalog', () => JSON.stringify(registry.catalog()), 'application/json; charset=utf-8'); });
    // The home carries the week's most opened tools (registry/opens.js, read at most every 5 minutes); a read that
    // fails leaves that section out, never the page.
    router.get('/', async (req, res) => {
        const top = opens ? await opens.top(7, 12).catch(() => []) : [];
        const activity = discovery ? await discovery.snapshot().catch(() => ({ available: false })) : { available: false };
        send(req, res, '/', () => pageIndex(top, activity), undefined, (opens ? opens.version() : '') + JSON.stringify(activity));
    });
    // "Ask Vibe which tool": a description in, the right tool out. The words are normalised, then the catalogue's
    // own scoring picks the candidates. One clear winner (at least half again the runner-up) opens the tool; anything
    // close, or nothing at all, goes to the server-rendered search with the same words — never a wrong tool.
    router.get('/ask-tool', (req, res) => {
        const raw = String(req.query.q || '').slice(0, 160).toLowerCase();
        const q = raw
            .replace(/'s\b/g, '')
            .replace(/\b(shrink|smaller|reduce|lighten)\b/g, 'compress')
            .replace(/\b(pdfs|documents|doc)\b/g, 'pdf')
            .replace(/\b(pictures|picture|photo|photos|pic)\b/g, 'image')
            .replace(/\b(vids|clips)\b/g, 'video')
            .split(/[^a-z0-9]+/).filter(w => w && !ASK_STOP.includes(w)).join(' ');
        res.set('Cache-Control', 'no-store');
        const terms = q.split(/[^a-z0-9.+#]+/).filter(Boolean).slice(0, 8);
        const ranked = terms.length
            ? registry.get().tools.map(t => [score(t, terms), t]).filter(x => x[0] > 0 && x[1].status !== 'unavailable')
                .sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name))
            : [];
        if (ranked.length && (ranked.length === 1 || ranked[0][0] >= ranked[1][0] * 1.5)) return res.redirect(302, ranked[0][1].url);
        return res.redirect(302, '/search?q=' + encodeURIComponent(q));
    });
    router.get('/all-tools', (req, res) => send(req, res, '/all-tools', pageAll));
    router.get('/search', (req, res) => { res.set('Cache-Control', 'no-store'); res.type('html').send(pageSearch(String(req.query.q || '').slice(0, 80))); });
    router.get('/sitemap.xml', (req, res) => send(req, res, 'sitemap', () => seo.sitemapXml(sitemapEntries()), 'application/xml; charset=utf-8'));
    router.get('/robots.txt', (req, res) => send(req, res, 'robots', () => seo.robotsTxt({ sitemaps: [SITE + '/sitemap.xml'], disallow: ['/api/', '/auth/'], allow: ['/api/catalog.json'], allowAI: true }) + `# Agent manifest: ${SITE}/.well-known/agent.json\n`, 'text/plain; charset=utf-8'));
    router.get('/llms.txt', (req, res) => send(req, res, 'llms', llmsTxtBody, 'text/plain; charset=utf-8'));
    // The same document with every public page's text: what /llms.txt lists, readable whole.
    router.get('/llms-full.txt', (req, res) => send(req, res, 'llms-full', llmsFullBody, 'text/plain; charset=utf-8'));
    router.get('/:slug', (req, res, next) => { const f = registry.get().families.find(x => x.path === '/' + req.params.slug); return f ? send(req, res, f.path, () => pageFamily(f)) : next(); });
    return router;
}

const renderNotFound = () => pageSearch('').replace('<h1>Search tools</h1>', '<h1>That page is not here</h1>').replace(/<title>[^<]*<\/title>/, '<title>Page not found | OpenVibe.Tools</title>');

module.exports = { headlineClause, createSiteRouter, pageIndex, pageFamily, pageTool, pageAll, pageDevelopers, pageWorkers, search, sitemapEntries, renderNotFound, SITE, NAME };
