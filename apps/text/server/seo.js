'use strict';

// ═══════════════════════════════════════════════════════════════
// Canonicals + structured data for the text tool pages.
//
// Several hostnames share one HTML file on purpose (smallcaps and fancy are the same generator,
// glitch and zalgo are the same generator). Served as-is, that is duplicate content across
// subdomains: search engines split the ranking signals between the copies and may pick the
// alias as the one to show. A canonical pointing every alias at the primary host consolidates
// them instead.
//
// Each page already carries a good hand-written <title> and description, so this module reuses
// those rather than inventing a second source of truth.
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** file → the first hostname that serves it; that host is the canonical one. */
function buildPrimaryHosts(hostnameMap) {
    const primary = new Map();
    for (const [host, file] of Object.entries(hostnameMap)) {
        if (!primary.has(file)) primary.set(file, host);
    }
    return primary;
}

const _cache = new Map();

/**
 * Read a page and stamp in canonical, social tags and JSON-LD.
 * Falls back to the untouched file if anything goes wrong — SEO extras must never break serving.
 */
function renderPage(file, primaryHost) {
    const key = `${file}::${primaryHost}`;
    if (_cache.has(key)) return _cache.get(key);

    let html;
    try { html = fs.readFileSync(path.join(PUBLIC, file), 'utf8'); } catch { return null; }

    const url = `https://${primaryHost}`;
    const rawTitle = (html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || 'OpenVibe Text Tools';
    // Titles read "Case Converter — … | case.openvibe.tools"; the host suffix is noise in a share card.
    const name = rawTitle.split('|')[0].trim();
    const desc = (html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i) || [])[1] || '';

    const ld = [
        {
            '@context': 'https://schema.org', '@type': 'WebApplication',
            name, url, description: desc,
            applicationCategory: 'UtilitiesApplication', operatingSystem: 'Any (web browser)',
            publisher: { '@type': 'Organization', name: 'OpenVibe', url: 'https://openvibe.tools' },
        },
        {
            '@context': 'https://schema.org', '@type': 'BreadcrumbList',
            itemListElement: [
                { '@type': 'ListItem', position: 1, name: 'OpenVibe', item: 'https://openvibe.tools' },
                { '@type': 'ListItem', position: 2, name: 'Text Tools', item: 'https://text.openvibe.tools' },
                { '@type': 'ListItem', position: 3, name, item: url },
            ],
        },
    ];

    const head = [
        `<link rel="canonical" href="${url}">`,
        '<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">',
        `<meta property="og:title" content="${esc(name)}">`,
        `<meta property="og:description" content="${esc(desc)}">`,
        `<meta property="og:url" content="${url}">`,
        '<meta property="og:type" content="website">',
        '<meta property="og:site_name" content="OpenVibe">',
        '<meta name="twitter:card" content="summary_large_image">',
        `<meta name="twitter:title" content="${esc(name)}">`,
        `<meta name="twitter:description" content="${esc(desc)}">`,
        ...ld.map(b => `<script type="application/ld+json">${JSON.stringify(b).replace(/</g, '\\u003c')}</script>`),
    ].join('\n');

    // Don't double up on tags a page already sets for itself.
    const wanted = head.split('\n').filter(tag => {
        const m = tag.match(/(?:rel|property|name)=["']([^"']+)["']/);
        if (!m) return true;
        return !new RegExp(`(?:rel|property|name)=["']${m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'i').test(html);
    }).join('\n');

    const out = html.replace(/<\/head>/i, `${wanted}\n</head>`);
    if (_cache.size > 100) _cache.clear();
    _cache.set(key, out);
    return out;
}

/** Express handler factory: serves the host's page with its SEO tags applied. */
function pageSender(hostnameMap, getHostname) {
    const primary = buildPrimaryHosts(hostnameMap);
    return function sendPage(req, res) {
        const hostname = getHostname(req);
        const file = hostnameMap[hostname] || 'index.html';
        res.setHeader('Cache-Control', 'no-cache');
        const rendered = renderPage(file, primary.get(file) || hostname);
        if (!rendered) return res.sendFile(path.join(PUBLIC, file));
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(rendered);
    };
}

/** Sitemap over the primary hosts only — aliases are canonicalised away, so they don't belong. */
function buildSitemap(hostnameMap) {
    const primary = buildPrimaryHosts(hostnameMap);
    const today = new Date().toISOString().slice(0, 10);
    const urls = [...primary.values()].map(host =>
        `  <url>\n    <loc>https://${host}/</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>${host.startsWith('text.') ? '0.9' : '0.8'}</priority>\n  </url>`);
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

module.exports = { pageSender, buildSitemap, renderPage, buildPrimaryHosts };
