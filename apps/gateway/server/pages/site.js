'use strict';
// ═══════════════════════════════════════════════════════════════
// openvibe.tools, server-rendered from the registry.
//   /                 index: search, families, popular tools
//   /<family-path>    one family: every tool, intro, FAQ
//   /tool/<id>        one tool: what it does, where it lives (primary host + mirrors), related
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
const appIcon = require('openvibe-shared/app-icon');
const registry = require('../registry');
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
.fold-mark::after{content:'+';font-size:22px;font-weight:400;color:var(--text-muted,#7d8aa0)}
.fold-toggle:checked~.fold-h .fold-mark::after{content:'\\2212'}
.fold-body{display:none}
.fold-toggle:checked~.fold-body{display:block}
.fold:not(.fold-bare) .fold-body .ov-shipped-home h3{display:none}
@media (min-width:641px){
.fold-block{margin-top:40px}
.fold-toggle{display:none}
.fold-h{min-height:0;margin-bottom:6px;cursor:default}
.fold-mark{display:none}
.fold-body{display:block}
}
.fam-all{margin:10px 0 0;font-size:14px}.fam-all a{font-weight:650;text-decoration:none}
.perks{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}.perks div{padding:16px;border-radius:14px;border:1px solid var(--border,rgba(255,255,255,.08));background:var(--bg-secondary,#111826)}.perks p{margin:6px 0 0;color:var(--text-secondary,#a8b3c4);font-size:14px}
@media (max-width:560px){.tiles{grid-template-columns:1fr 1fr}.tile small{display:none}.tile b{white-space:normal;line-height:1.25;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}.jump{top:52px}}
#ov-footer{margin-top:56px}
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
.hero-links{margin:12px 0 0;font-size:13.5px;line-height:1.7;color:var(--text-muted,#7d8aa0)}
.hero-links a{font-weight:600;white-space:nowrap}
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
.job-pick,.job-pick-h{display:none}
@supports selector(:has(*)){@media (max-width:640px){
.job-pick-h{display:flex;margin-top:30px}
.job-pick{display:flex;gap:8px;overflow-x:auto;margin:10px -16px 0;padding:2px 16px 4px;scrollbar-width:none;overscroll-behavior-x:contain}.job-pick::-webkit-scrollbar{display:none}
.job-pick input{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}
.job-pick label{display:inline-flex;align-items:center;flex:none;min-height:44px;padding:0 15px;border-radius:999px;border:1px solid var(--border,rgba(255,255,255,.1));color:var(--text-secondary,#a8b3c4);font-size:13.5px;font-weight:650;white-space:nowrap;cursor:pointer}
.job-pick input:checked+label{color:var(--text-primary,#e6edf7);border-color:var(--accent,#3b82f6);background:color-mix(in srgb,var(--accent,#3b82f6) 12%,transparent)}
.job-pick input:focus-visible+label{outline:2px solid var(--accent,#3b82f6);outline-offset:2px}
.jobs .job{display:none;padding-top:14px}.jobs .job .sec-h{display:none}
.jobs:has(#jp-files:checked) #job-files,.jobs:has(#jp-text:checked) #job-text,.jobs:has(#jp-audio:checked) #job-audio,.jobs:has(#jp-media:checked) #job-media,.jobs:has(#jp-data:checked) #job-data,.jobs:has(#jp-web:checked) #job-web,.jobs:has(#jp-places:checked) #job-places{display:block}
.jobs .job:target{display:block}
}}
.job .sec-h{margin-bottom:4px}
.job .tiles{margin-top:14px}
.group-links{display:flex;flex-wrap:wrap;gap:6px 18px;margin:12px 0 0;font-size:13.5px;font-weight:600}
.group-links a{text-decoration:none;white-space:nowrap}
@media (max-width:820px){.hero.hero-split{grid-template-columns:minmax(0,1fr);gap:20px}.hero-copy h1{max-width:none}.start-grid{grid-template-columns:1fr}}
@media (max-width:560px){.grid{grid-template-columns:minmax(0,1fr);gap:6px}.search button{padding:0 14px}.tool{padding:9px 11px;align-items:center}.tool small{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tool i{display:none}.hero{padding-top:20px}.hero h1{font-size:28px}.kicker{display:none}}
/* The home on phones (2026-10-29): the examples are one row that scrolls sideways (all four still there), and four of the most
   opened tools show (the families below and the A to Z list hold the rest). */
@media (max-width:599px){.start-grid{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;scroll-padding-inline:16px;scrollbar-width:none;gap:10px;margin:0 -16px;padding:0 16px 4px}.start-grid::-webkit-scrollbar{display:none}.start-grid>*{flex:0 0 84%;min-width:0;scroll-snap-align:start}section[aria-labelledby="top-h"] .grid>:nth-child(n+5){display:none}}
@media (prefers-reduced-motion:reduce){.tool{transition:none}}
${icons.CSS}
/* Touch targets on phones (fleet audit, 2026-10-29): touch pointers only. */
@media (pointer: coarse) {
  main.wrap summary, .fold summary { min-height: 44px; }
  .sec-h a.more { position: relative; display: inline-block; }
  .sec-h a.more::after { content: ''; position: absolute; left: 0; right: 0; top: -11px; bottom: -11px; }
  .group-links a { min-height: 44px; display: inline-flex; align-items: center; }
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
<link rel="preconnect" href="https://openvibe.network">
<script src="${ovServe.url('theme-loader.js')}" defer></script>
<style>${CSS}</style></head><body>${spriteSvg}
<div id="navbar-mount"></div><noscript><style>#navbar-mount{display:none}</style><header class="topbar"><a href="${SITE}/">${NAME}</a><nav>${families.filter(f => f.path).map(f => `<a href="${esc(f.path)}">${esc(f.name)}</a>`).join('')}<a href="/all-tools">All tools</a></nav></header></noscript>
<main class="wrap">${body}
${foldBlock({
        id: 'net',
        head: '<h2 id="net-h">The rest of OpenVibe</h2>',
        html: `<section aria-labelledby="net-h"><p class="sec-p">One account works on every site. Open source and community-run.</p>
<div class="net">${NETWORK.map(([ic, n, d, u]) => `<a class="tool" href="${u}">${icon(ic, 36)}<span class="tool-t"><b>${n}</b><small>${d}</small></span></a>`).join('')}</div></section>`,
    })}
</main>${frame.footer({ service: 'tools', variant: 'full', updates: '/updates' })}
<script src="${ovServe.url('navbar.js')}" defer></script><script src="${ovServe.url('footer.js')}" defer></script><script src="/js/site.js" defer></script>
</body></html>`;
}

function head(o) {
    // The site's own social card from its pinned Frame files (openvibe-shared social/tools.jpg), like every other site;
    // the old openvibe.network/assets/og-tools.png no longer exists (404).
    return seo.headTags(Object.assign({ siteName: NAME, image: `${SITE}${social.url('tools')}`, type: 'website', locale: 'en_US' }, o));
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

// ── The API, per tool (descriptors: run path, inputs, files, auth, an example) ──
const descriptorOf = (id) => require('../registry/descriptors').snapshot().tools.find((d) => d.id === id) || null;
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const mb = (bytes) => `${Math.round(bytes / 1048576)} MB`;
/** "Use it from code" on a tool's page: the one request that runs it, who may call it, what it takes. */
function apiSection(t) {
    const d = descriptorOf(t.id);
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
// The home groups the suite by the job a person came to do, not by internal family names. Every
// family page stays linked, and every tool stays one tap from the group it lives in.
const JOB_GROUPS = [
    { id: 'files', name: 'Images and documents', line: 'Shrink a picture, merge a PDF, convert a scan: one file in, the file you need out.', families: ['img', 'docs'] },
    { id: 'text', name: 'Text and design', line: 'Fancy fonts, clean-ups, counters, barcodes and simple logos you can download.', families: ['text', 'codes'] },
    { id: 'audio', name: 'Audio', line: 'Convert, trim, join and clean up recordings.', families: ['audio'] },
    { id: 'media', name: 'Video', line: 'Save a YouTube video, or just its sound, for offline use.', families: ['media'] },
    { id: 'data', name: 'Data and code', line: 'Format JSON, decode tokens, test regex and move data between formats.', families: ['dev'] },
    { id: 'web', name: 'Web and network', line: 'Check DNS, domains, certificates, ports and mail servers.', families: ['net'] },
    { id: 'places', name: 'Maps and food', line: 'Find water, shelter, supplies and an affordable meal nearby.', families: ['places'] },
];
/**
 * The job sections as one block. On a phone (640 px and under) a row of chips picks one job at a time, so the home
 * stays short (the owner's short-pages rule, 2026-10-30): radio inputs and :has(), no script, and every section stays
 * in the page for crawlers. A wider screen, or a browser without :has(), shows every section and no chips. A link to
 * #job-x still opens that section (:target).
 */
function jobsBlock(sections, jobs) {
    if (!sections.length) return '';
    const shown = jobs.filter((j) => sections.some((h) => h.includes(`id="job-${j.id}"`)));
    const chips = shown.map((j, i) => `<input type="radio" name="job-pick" id="jp-${j.id}" value="${j.id}"${i === 0 ? ' checked' : ''}><label for="jp-${j.id}">${esc(j.name)}</label>`).join('');
    return `<div class="jobs"><div class="sec-h job-pick-h"><h2>Tools by job</h2><a class="more" href="/all-tools">All tools</a></div><div class="job-pick" role="radiogroup" aria-label="Tools by job">${chips}</div>${sections.join('')}</div>`;
}
const QUICK_LINKS = [['mergepdf', 'merge a PDF'], ['fancy', 'fancy text'], ['compress', 'compress an image'], ['json', 'format JSON'], ['dns', 'check DNS']];
const FAMILY_SHORT = { img: 'image tools', docs: 'PDF tools', text: 'text tools', codes: 'barcode tools', audio: 'audio tools', media: 'video tools', dev: 'developer tools', net: 'network tools', places: 'map tools' };

function pageIndex(top = []) {
    // Only built tools: a home never shows what is planned (plan §1 "no placeholders").
    const { tools, families } = registry.get();
    const byId = new Map(tools.map(t => [t.id, t]));
    const fams = families.filter(f => f.path);
    const withApi = require('../registry/descriptors').snapshot().tools.filter((d) => d.api && d.status !== 'unavailable').length;
    // Most opened this week (registry/opens.js): real counts, shown once at least four tools have some.
    const opened = top.map((r) => [byId.get(r.tool), r.opens]).filter(([t, n]) => t && n > 0).slice(0, 6);
    const openedCard = ([t, n]) => toolCard(t).replace('</small><i>', `</small><i><span class="opens">${n.toLocaleString('en-US')} ${n === 1 ? 'person' : 'people'} this week</span> · `);
    const tile = (t) => `<a class="tile" href="${esc(t.url)}"${go(t)} title="${esc(t.tagline)}">${icon(t.icon, 28)}<span><b>${esc(t.name)}</b><small>${esc(t.tagline)}</small></span></a>`;
    // Hand-picked first, then registry order; eight is enough to scan, the family links carry the rest.
    const pick = (list) => [...list.filter((t) => POPULAR.includes(t.id)), ...list.filter((t) => !POPULAR.includes(t.id))].slice(0, 8);
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
<p class="promo-foot"><a ${startLink(fancy)}>Open Fancy Text →</a></p>
</aside>` : '';
    const jsonIn = '{"b":1,"a":2}';
    const jsonOut = JSON.stringify(JSON.parse(jsonIn), null, 2);
    const quick = QUICK_LINKS.map(([id, label]) => { const t = byId.get(id); return t ? `<a href="${esc(t.url)}"${go(t)}>${esc(label)}</a>` : ''; }).filter(Boolean);
    const body = `<div class="hero hero-split">
<div class="hero-copy"><p class="kicker">Open source · community-run · no account needed to start</p>
<h1>Small tools that <span>finish the job.</span></h1>
<p class="hero-sub">Convert a file, merge a PDF, format JSON, check DNS: ${tools.length} tools that open in the browser and get out of your way. Free, and no sign-up to look.</p>
${searchForm('')}
<p class="hero-links">Straight to it: ${quick.join(' · ')}</p></div>
${demo}</div>
<ul class="stats"><li><b>${tools.length}</b> tools</li><li><b>${fams.length}</b> families</li><li><b>${withApi}</b> with an API</li><li>nothing to install</li></ul>
<section id="results" hidden aria-live="polite"><div class="sec-h"><h2>Results</h2></div><div class="grid" id="results-grid"></div><p class="empty" id="results-empty" hidden>No tool matches that yet. <a href="/all-tools">Browse every tool</a>.</p></section>
<section id="recent" hidden aria-labelledby="recent-h"><div class="sec-h"><h2 id="recent-h">Your tools</h2><span class="more" id="recent-note"></span></div><div class="grid" id="recent-grid"></div></section>
<section aria-labelledby="start-h"><div class="sec-h"><h2 id="start-h">Good places to start</h2><a class="more" href="/all-tools">A to Z list</a></div>
<p class="sec-p">Real examples, not a feature list. Each card opens the tool itself.</p>
<div class="start-grid">
${startCard('json', (t) => `<span class="start-name">${esc(t.name)}<small>${host(t)}</small></span><pre tabindex="0"><code>${esc(jsonIn)}</code></pre><span class="start-arrow" aria-hidden="true">↓</span><pre tabindex="0"><code>${esc(jsonOut)}</code></pre><span class="start-go">Format JSON →</span>`)}
${startCard('mergepdf', (t) => `<span class="start-name">${esc(t.name)}<small>${host(t)}</small></span><div class="flow" aria-hidden="true"><span>PDF</span><span>PDF</span><span>PDF</span><span class="flow-arrow">→</span><span class="flow-out">one PDF</span></div><p class="start-note">Drop the files, drag them into order, download one document.</p><span class="start-go">Merge PDFs →</span>`)}
${startCard('compress', (t) => `<span class="start-name">${esc(t.name)}<small>${host(t)}</small></span><div class="flow" aria-hidden="true"><span>PNG</span><span>JPG</span><span>WebP</span><span class="flow-arrow">→</span><span class="flow-out">smaller file</span></div><p class="start-note">Keep the pixels, lose the weight. iPhone HEIC works too.</p><span class="start-go">Compress an image →</span>`)}
${startCard('dns', (t) => `<span class="start-name">${esc(t.name)}<small>${host(t)}</small></span><div class="flow" aria-hidden="true"><span>domain</span><span class="flow-arrow">→</span><span class="flow-out">A · AAAA · MX · TXT</span></div><p class="start-note">See what a domain actually points at, from outside your network.</p><span class="start-go">Look up DNS →</span>`)}
</div></section>
${opened.length >= 4 ? foldBlock({
        id: 'top',
        head: '<h2 id="top-h">Most opened this week</h2>',
        html: `<section aria-labelledby="top-h"><p class="sec-p">How many people opened each tool in the last seven days, counted once per person a day.</p><div class="grid">${opened.map(openedCard).join('')}</div></section>`,
    }) : ''}
${jobsBlock(JOB_GROUPS.map((job) => {
        const list = job.families.flatMap((fid) => tools.filter((t) => t.family === fid));
        if (!list.length) return '';
        const groupFamilies = job.families.map((fid) => families.find((f) => f.id === fid)).filter((f) => f && f.path && tools.some((t) => t.family === f.id));
        return `<section class="job" id="job-${job.id}" aria-labelledby="job-${job.id}-h"><div class="sec-h"><h2 id="job-${job.id}-h">${esc(job.name)}</h2></div><p class="sec-p">${esc(job.line)}</p><div class="tiles">${pick(list).map(tile).join('')}</div><p class="group-links">${groupFamilies.map((f) => { const n = tools.filter((t) => t.family === f.id).length; const label = FAMILY_SHORT[f.id] || f.name.toLowerCase(); return `<a href="${esc(f.path)}">${n === 1 ? `The ${label.replace(/s$/, '')}` : `All ${n} ${label}`} →</a>`; }).join('')}</p></section>`;
    }).filter(Boolean), JOB_GROUPS)}
<section class="fold" aria-labelledby="dev-h"><details><summary><h2 id="dev-h">Use any tool from code</h2></summary><div class="sec-h"><a class="more" href="/developers">Developer guide</a></div><p class="sec-p">${withApi} of the ${tools.length} tools take one request each, the same engines the pages use. Each tool's page shows its own request.</p>
<div class="dev"><pre tabindex="0"><code>curl -X POST ${SITE}/api/v1/tools/jsonminify/run \\
  -H 'Content-Type: application/json' \\
  -d '{"input":{"text":"{ \\"a\\": 1 }"}}'</code></pre>
<ul><li><a href="/api/v1/openapi.json">OpenAPI 3.1</a>, generated from the tool descriptors</li><li><a href="/api/v1/tools">/api/v1/tools</a>: every tool's inputs, limits and access</li><li>Long work runs as a job you can follow over server-sent events</li><li><a href="https://github.com/OpenVibers/OpenVibe.SDK">openvibe-sdk</a>: <code>tools.run(id, input)</code> from JavaScript</li></ul></div></details></section>
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
        head: '<h2 id="faq-h">Questions</h2>',
        html: `<section aria-labelledby="faq-h">${HOME_FAQ.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}</section>`,
    })}`;
    return shell({ families, agent: true, body, head: head({
        title: 'Online Tools for Files, Text, Code & Networks', description: `${tools.length} online tools in one place: video and audio converters, image and PDF tools, developer utilities and network diagnostics. Open source and community-run.`,
        canonical: SITE + '/', keywords: 'online tools, converter, pdf tools, image converter, developer tools, network tools, youtube downloader',
        jsonLd: [seo.jsonLd.organization(), seo.jsonLd.website({ name: NAME, url: SITE + '/', description: 'Online tools for files, text, code and networks.', searchUrl: SITE + '/search?q={search_term_string}' }),
            seo.jsonLd.itemList('Tool families', fams.map(f => ({ name: f.name, url: SITE + f.path, description: f.tagline }))),
            seo.jsonLd.faq(HOME_FAQ.map(([q, a]) => ({ q, a })))] }) });
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
    return shell({ families, agent: true, body, head: head({ title: `${f.name}: ${f.tagline}`, description: f.description, canonical: url, keywords: list.slice(0, 12).map(t => t.name.toLowerCase()).join(', '),
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
${apiSection(t)}
${related.length ? `<section><div class="sec-h"><h2>Related tools</h2>${f && f.path ? `<a class="more" href="${esc(f.path)}">All ${esc(f.name)}</a>` : ''}</div><div class="grid">${related.map(toolCard).join('')}</div></section>` : ''}`;
    return shell({ families, agent: true, body, head: head({ title: `${t.name}: ${t.tagline}`, description: t.description, canonical: url, keywords: (t.keywords || []).join(', '),
        jsonLd: [seo.jsonLd.breadcrumbs([{ name: 'Tools', url: SITE + '/' }, ...(f && f.path ? [{ name: f.name, url: SITE + f.path }] : []), { name: t.name, url }]),
            seo.jsonLd.softwareApp({ name: t.name, url: t.url, description: t.description, category: 'UtilitiesApplication', keywords: t.keywords })] }) });
}

function pageAll() {
    const { tools, families } = registry.get();
    const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
    const body = `<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Tools</a> › All tools</nav><div class="page-h">${icon('tools', 56)}<h1>All ${tools.length} tools, A to Z</h1></div>
${searchForm('')}<section><ul class="az">${sorted.map(t => `<li><a href="${esc(t.url)}">${esc(t.name)}</a> <small><a href="/tool/${esc(t.id)}" aria-label="About ${esc(t.name)}">about</a></small></li>`).join('')}</ul></section>`;
    return shell({ families, agent: true, body, head: head({ title: `All ${tools.length} Online Tools, A to Z`, description: 'The complete list of tools on OpenVibe.Tools: converters, downloaders, PDF and image tools, text utilities, developer tools and network diagnostics.', canonical: SITE + '/all-tools',
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
function cached(key, render, extra = '') {
    const ver = `${registry.get().updated}|${extra}`;
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
    const body = `<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Tools</a> › Developers</nav><div class="page-h">${icon('code', 56)}<h1>Tools API</h1></div>
<p class="lead">${withApi.length} of ${snap.tools.length} tools can be called from code, with the same engines the pages use. One request shape for all of them; long work runs as a job you can follow.</p>
<section><div class="sec-h"><h2>At a glance</h2></div><p class="sec-p">The six calls behind every tool. Rate limits are the anonymous allowance; signing in or using a token raises it, and a tool's cost counts against the limit.</p>
<table class="api-table" role="table"><caption class="sr-only">Tools API endpoints, what they do, who may call them, their anonymous rate limit and an example request</caption>
<thead><tr role="row"><th scope="col" role="columnheader">Endpoint</th><th scope="col" role="columnheader">Purpose</th><th scope="col" role="columnheader">Auth</th><th scope="col" role="columnheader">Rate limit</th><th scope="col" role="columnheader">Example</th></tr></thead>
<tbody>${apiRows.map((r) => `<tr role="row"><td role="cell" data-label="Endpoint"><code>${esc(r[0])}</code></td><td role="cell" data-label="Purpose">${esc(r[1])}</td><td role="cell" data-label="Auth">${esc(r[2])}</td><td role="cell" data-label="Rate limit">${esc(r[3])}</td><td role="cell" data-label="Example"><code>${esc(r[4])}</code></td></tr>`).join('')}</tbody></table>
<p class="sec-p">Over a limit is <b>429</b> with <code>Retry-After</code>; every answer also carries <code>RateLimit-*</code> headers. Errors are RFC 9457 problems with a stable <code>code</code>.</p></section>
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
<p class="sec-p">The SDK is <a href="https://github.com/OpenVibers/OpenVibe.SDK">openvibe-sdk</a> (this site pins v0.67.0). It retries on 429 after <code>Retry-After</code> and generates idempotency keys for you.</p></section>
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

// ── llms.txt + llms-full.txt ─────────────────────────────────
// The public pages, once, as the data both artifacts read: /llms.txt lists each with its tagline,
// /llms-full.txt carries the same pages with their full description. One source, so the two can
// never disagree about what is public. The noindex search page and the site's own /tool/*,
// /developers and /updates pages were never in llms.txt and stay out of both.
function llmsSections() {
    const { tools, families } = registry.get();
    return families.filter(f => f.path).map(f => ({
        title: f.name,
        links: tools.filter(t => t.family === f.id).map(t => ({ title: t.name, url: t.url, note: t.tagline, text: t.description || t.tagline })),
    }));
}
function llmsSummary() {
    const { tools } = registry.get();
    return `${tools.length} online tools for files, text, code and networks. Open source and community-run. A machine-readable catalog is at ${SITE}/api/catalog.json.`;
}
function llmsTxtBody() {
    return seo.llmsTxt({ name: NAME, summary: llmsSummary(),
        sections: [{ title: 'API', links: [{ title: 'Developer guide', url: SITE + '/developers', note: 'run any tool from code' }, { title: 'OpenAPI 3.1', url: SITE + '/api/v1/openapi.json' }, { title: 'Tool registry (JSON)', url: SITE + '/api/v1/tools' }, { title: 'Full text (llms-full.txt)', url: SITE + '/llms-full.txt', note: 'the public pages below as one plain-text document' }] }].concat(llmsSections()) });
}
// /llms-full.txt: the same header and summary as /llms.txt, then every public page llms.txt lists
// with its text, under the same sections. The 512 KB ceiling keeps the answer a document, not a
// payload — llmsFull stops before the page that would pass it.
const LLMS_FULL_MAX_BYTES = 512 * 1024;
function llmsFullBody() {
    return seo.llmsFull({ site: { name: NAME, url: SITE }, summary: llmsSummary(), maxBytes: LLMS_FULL_MAX_BYTES,
        sections: llmsSections().map(s => ({ title: s.title, pages: s.links.map(l => ({ title: l.title, url: l.url, text: l.text })) })) });
}

function createSiteRouter({ opens = null } = {}) {
    const router = express.Router();
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
    router.get('/developers', (req, res) => send(req, res, 'developers', pageDevelopers));
    // What shipped on OpenVibe.Tools: the shared update log every OpenVibe site has.
    router.get('/updates', (req, res) => send(req, res, 'updates', pageUpdates));
    router.get('/api/catalog.json', (req, res) => { res.set('Access-Control-Allow-Origin', '*'); send(req, res, 'catalog', () => JSON.stringify(registry.catalog()), 'application/json; charset=utf-8'); });
    // The home carries the week's most opened tools (registry/opens.js, read at most every 5 minutes); a read that
    // fails leaves that section out, never the page.
    router.get('/', async (req, res) => {
        const top = opens ? await opens.top(7, 12).catch(() => []) : [];
        send(req, res, '/', () => pageIndex(top), undefined, opens ? opens.version() : '');
    });
    router.get('/all-tools', (req, res) => send(req, res, '/all-tools', pageAll));
    router.get('/search', (req, res) => { res.set('Cache-Control', 'no-store'); res.type('html').send(pageSearch(String(req.query.q || '').slice(0, 80))); });
    router.get('/tool/:id', (req, res, next) => { const t = registry.get().tools.find(x => x.id === req.params.id); return t ? send(req, res, '/tool/' + t.id, () => pageTool(t)) : next(); });
    router.get('/sitemap.xml', (req, res) => send(req, res, 'sitemap', () => seo.sitemapXml(sitemapEntries()), 'application/xml; charset=utf-8'));
    router.get('/robots.txt', (req, res) => send(req, res, 'robots', () => seo.robotsTxt({ sitemaps: [SITE + '/sitemap.xml'], disallow: ['/api/', '/auth/'], allow: ['/api/catalog.json'], allowAI: true }) + `# Agent manifest: ${SITE}/.well-known/agent.json\n`, 'text/plain; charset=utf-8'));
    router.get('/llms.txt', (req, res) => send(req, res, 'llms', llmsTxtBody, 'text/plain; charset=utf-8'));
    // The same document with every public page's text: what /llms.txt lists, readable whole.
    router.get('/llms-full.txt', (req, res) => send(req, res, 'llms-full', llmsFullBody, 'text/plain; charset=utf-8'));
    router.get('/:slug', (req, res, next) => { const f = registry.get().families.find(x => x.path === '/' + req.params.slug); return f ? send(req, res, f.path, () => pageFamily(f)) : next(); });
    return router;
}

const renderNotFound = () => pageSearch('').replace('<h1>Search tools</h1>', '<h1>That page is not here</h1>').replace(/<title>[^<]*<\/title>/, '<title>Page not found | OpenVibe.Tools</title>');

module.exports = { createSiteRouter, pageIndex, pageFamily, pageTool, pageAll, search, sitemapEntries, renderNotFound, SITE, NAME };
