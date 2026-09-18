'use strict';

// ═══════════════════════════════════════════════════════════════
// Per-subdomain SEO rendering for the shared tool SPAs.
//
// dev.html and net.html are each served for dozens of subdomains. Without this, every one of
// those pages shipped the hub's <title>, the hub's description and a canonical pointing AT the
// hub — telling search engines that sixty-five distinct tools were all the same page, and that
// the real one was somewhere else. Nothing could rank.
//
// This module rewrites the <head> per request and appends a visible, crawlable content block
// (H1, intro, features, FAQ, related tools) so each tool page has genuine text and internal
// links even before the SPA boots. The content is visible rather than hidden: hidden keyword
// text is a penalty risk, and this copy is genuinely useful to a first-time visitor.
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { seoFor, relatedTo, BRAND } = require('./catalog');

const SITE = 'https://openvibe.tools';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Page HTML is read once and cached; a tiny LRU keeps rendered variants hot.
const _base = new Map();
function baseHtml(file) {
    if (!_base.has(file)) _base.set(file, fs.readFileSync(file, 'utf8'));
    return _base.get(file);
}
const _rendered = new Map();

function jsonLd(rec, url, related) {
    const app = {
        '@context': 'https://schema.org', '@type': 'SoftwareApplication',
        name: rec.name, url, applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Any (web browser)', description: rec.desc,
        publisher: { '@type': 'Organization', name: BRAND, url: SITE },
        featureList: rec.bullets || undefined,
    };
    const crumbs = {
        '@context': 'https://schema.org', '@type': 'BreadcrumbList',
        itemListElement: [
            { '@type': 'ListItem', position: 1, name: BRAND, item: SITE },
            { '@type': 'ListItem', position: 2, name: rec.family === 'net' ? 'Network Tools' : 'Developer Tools', item: `https://${rec.family}.openvibe.tools` },
            { '@type': 'ListItem', position: 3, name: rec.name, item: url },
        ],
    };
    const blocks = [app, crumbs];
    if ((rec.faq || []).length) {
        blocks.push({
            '@context': 'https://schema.org', '@type': 'FAQPage',
            mainEntity: rec.faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
        });
    }
    if (related.length) {
        blocks.push({
            '@context': 'https://schema.org', '@type': 'ItemList',
            name: 'Related tools',
            itemListElement: related.map((r, i) => ({ '@type': 'ListItem', position: i + 1, name: r.name, url: `https://${r.sub}.openvibe.tools` })),
        });
    }
    return blocks.map(b => `<script type="application/ld+json">${JSON.stringify(b).replace(/</g, '\\u003c')}</script>`).join('\n');
}

/** The visible content block appended under the tool: real copy, real internal links. */
function contentBlock(rec, related) {
    const hubUrl = `https://${rec.family}.openvibe.tools`;
    const hubName = rec.family === 'net' ? 'network tools' : 'developer tools';
    return `
<section class="seo-about" id="about-this-tool">
  <div class="seo-about-inner">
    <h2>About the ${esc(rec.name)}</h2>
    <p>${esc(rec.about)}</p>
    ${(rec.bullets || []).length ? `<ul class="seo-features">${rec.bullets.map(b => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
    ${(rec.faq || []).length ? `<h2>Frequently asked questions</h2><dl class="seo-faq">${rec.faq.map(([q, a]) => `<dt>${esc(q)}</dt><dd>${esc(a)}</dd>`).join('')}</dl>` : ''}
    ${related.length ? `<h2>Related tools</h2><ul class="seo-related">${related.map(r => `<li><a href="https://${esc(r.sub)}.openvibe.tools"><strong>${esc(r.name)}</strong><span>${esc(r.desc)}</span></a></li>`).join('')}</ul>` : ''}
    <p class="seo-hub"><a href="${hubUrl}">Browse all ${hubName}</a> · <a href="${SITE}">${BRAND} home</a> · <a href="https://openvibe.live">Live streaming</a></p>
  </div>
</section>
<style>
.seo-about{position:relative;z-index:1;max-width:1100px;margin:48px auto 0;padding:28px 20px 40px;border-top:1px solid var(--brd,rgba(255,255,255,.07));color:var(--tx2,#a0a8c4);font-size:.92rem;line-height:1.65}
.seo-about h2{color:var(--tx,#f1f4fb);font-size:1.05rem;font-weight:700;margin:22px 0 10px}
.seo-about h2:first-child{margin-top:0}
.seo-about p{margin:0 0 12px;max-width:72ch}
.seo-features{margin:0 0 4px;padding-left:20px}.seo-features li{margin:4px 0}
.seo-faq{margin:0}.seo-faq dt{color:var(--tx,#f1f4fb);font-weight:600;margin:12px 0 4px}.seo-faq dd{margin:0 0 8px;max-width:72ch}
.seo-related{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:8px}
.seo-related a{display:block;padding:10px 12px;border-radius:12px;background:var(--bg2,#12131c);border:1px solid var(--brd,rgba(255,255,255,.07));transition:border-color .15s,transform .15s}
.seo-related a:hover{border-color:var(--ac,#a78bfa);transform:translateY(-1px)}
.seo-related strong{display:block;color:var(--tx,#f1f4fb);font-size:.88rem;font-weight:600}
.seo-related span{display:block;font-size:.76rem;color:var(--tx3,#5e6580);margin-top:2px;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.seo-hub{margin-top:18px;font-size:.84rem}.seo-hub a{color:var(--ac,#a78bfa)}
</style>`;
}

/**
 * Render the SPA file for one subdomain with its own metadata and content.
 * Returns the original HTML untouched when the subdomain is not catalogued.
 */
function renderTool(file, sub, canonicalHost) {
    const rec = seoFor(sub);
    if (!rec) return baseHtml(file);
    const key = `${file}::${sub}::${canonicalHost || ''}`;
    if (_rendered.has(key)) return _rendered.get(key);

    // The registry decides the canonical host (a custom domain may own the tool).
    const url = `https://${canonicalHost || sub + '.openvibe.tools'}`;
    const related = relatedTo(sub, 6);
    const title = `${rec.title} | ${BRAND}`;
    let html = baseHtml(file);

    // <head>: title, description, canonical, social cards — each replaced rather than appended
    // so we never ship two competing values.
    html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${esc(title)}</title>`);
    html = html.replace(/<meta\s+name=["']description["'][^>]*>/i, `<meta name="description" content="${esc(rec.desc)}">`);
    html = html.replace(/<meta\s+property=["']og:title["'][^>]*>/i, `<meta property="og:title" content="${esc(rec.title)}">`);
    html = html.replace(/<meta\s+property=["']og:description["'][^>]*>/i, `<meta property="og:description" content="${esc(rec.desc)}">`);
    html = html.replace(/<meta\s+property=["']og:url["'][^>]*>/i, `<meta property="og:url" content="${url}">`);
    html = html.replace(/<link\s+rel=["']canonical["'][^>]*>/i, `<link rel="canonical" href="${url}">`);

    const extraHead = [
        `<meta name="ov-tool" content="${esc(sub)}">`,   // the page script reads this: the host may be descriptive, a mirror or a custom domain
        `<meta name="keywords" content="${esc(rec.kw || '')}">`,
        '<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">',
        '<meta name="twitter:card" content="summary_large_image">',
        `<meta name="twitter:title" content="${esc(rec.title)}">`,
        `<meta name="twitter:description" content="${esc(rec.desc)}">`,
        `<meta property="og:site_name" content="${BRAND}">`,
        '<meta property="og:locale" content="en_US">',
        jsonLd(rec, url, related),
    ].join('\n');
    html = html.replace(/<\/head>/i, `${extraHead}\n</head>`);

    // Visible content + internal links, appended before </body> so it renders under the tool.
    html = html.replace(/<\/body>/i, `${contentBlock(rec, related)}\n</body>`);

    if (_rendered.size > 200) _rendered.clear();
    _rendered.set(key, html);
    return html;
}

/** Hub pages list every tool, which gives crawlers a clean path into all of them. */
function toolUrls() {
    const { CATALOG } = require('./catalog');
    const urls = [];
    for (const [sub, rec] of CATALOG) {
        urls.push({ loc: `https://${sub}.openvibe.tools/`, priority: rec.hub ? '0.9' : '0.8', changefreq: rec.hub ? 'weekly' : 'monthly' });
    }
    return urls;
}

/** Full sitemap: the hubs, every tool subdomain, and the satellite apps. */
function buildSitemap(extraUrls = []) {
    const today = new Date().toISOString().slice(0, 10);
    const seen = new Set();
    const all = [
        { loc: `${SITE}/`, priority: '1.0', changefreq: 'weekly' },
        ...toolUrls(),
        ...extraUrls,
    ].filter(u => { if (seen.has(u.loc)) return false; seen.add(u.loc); return true; });
    const body = all.map(u => `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${u.lastmod || today}</lastmod>\n    <changefreq>${u.changefreq || 'monthly'}</changefreq>\n    <priority>${u.priority || '0.7'}</priority>\n  </url>`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

/** Satellite apps that live outside the dev/net catalogs but belong in the sitemap. */
const SATELLITES = [
    'img', 'audio', 'docs', 'food', 'maps', 'yt', 'text', 'logo', 'pastes',
    'case', 'braille', 'binary', 'fancy', 'json', 'markdown', 'escape', 'diff', 'slug',
    'wordcount', 'reverse', 'reversetext',
].map(sub => ({ loc: `https://${sub}.openvibe.tools/`, priority: '0.8', changefreq: 'weekly' }));

module.exports = { renderTool, buildSitemap, SATELLITES, toolUrls, SITE };
