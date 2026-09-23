'use strict';

// ═══════════════════════════════════════════════════════════════
// Per-host <head> tags for the single-page app.
//
// One index.html is served for every hostname in domain-map.js. Served as-is it carries the
// hub's title on every subdomain and no canonical at all, so search engines treat the tool
// hosts as duplicates of each other and social shares have no card. This stamps each host's
// own title, description, canonical, Open Graph / Twitter tags and structured data into the
// HTML on the way out. Rendered variants are cached per host; the file itself is read once.
//
// Canonical host: through the gateway (X-OV-* headers) the canonical, og:url and JSON-LD use the
// host it names — a descriptive host or a custom domain; reached directly, the host itself.
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { canonicalHostFor, ownHost } = require('../../_shared/host-role');
const { DOMAIN_MAP } = require('./domain-map');

const PUBLIC = path.join(__dirname, '..', 'public');
const HUB_HOST = 'img.openvibe.tools';
const HUB_NAME = 'Img.OpenVibe';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let _base = null;
const _cache = new Map();

function baseHtml() {
    if (_base === null) _base = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
    return _base;
}

/**
 * Render index.html for one host with that host's own metadata.
 * @param {object} ctx  domain-map context (brandName, seoTitle, seoDescription, toolId)
 * @param {string} host the satellite's own hostname for this tool, e.g. 'png.openvibe.tools'
 * @param {string} [canonicalHost] the host canonical URLs use (the gateway's; defaults to `host`)
 */
function renderIndex(ctx, host, canonicalHost) {
    const canon = canonicalHost || host;
    const key = `${host}|${canon}`;
    if (_cache.has(key)) return _cache.get(key);

    const url = `https://${canon}/`;
    const title = ctx.seoTitle || ctx.brandName || HUB_NAME;
    const desc = ctx.seoDescription || '';
    const image = `https://${canon}/og.png`;
    let html = baseHtml();

    // Replace what the file already sets, so there is never a second competing value.
    html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${esc(title)}</title>`);
    html = html.replace(/<meta\s+name=["']description["'][^>]*>/i, `<meta name="description" content="${esc(desc)}">`);
    html = html.replace(/<meta\s+property=["']og:title["'][^>]*>/i, `<meta property="og:title" content="${esc(title)}">`);
    html = html.replace(/<meta\s+property=["']og:description["'][^>]*>/i, '');
    html = html.replace(/<meta\s+property=["']og:url["'][^>]*>/i, '');
    html = html.replace(/<meta\s+property=["']og:image["'][^>]*>/i, '');
    html = html.replace(/<link\s+rel=["']canonical["'][^>]*>/i, '');

    const ld = [
        {
            '@context': 'https://schema.org', '@type': 'WebApplication',
            name: title, url, description: desc,
            applicationCategory: 'UtilitiesApplication', operatingSystem: 'Any (web browser)',
            image,
            publisher: { '@type': 'Organization', name: 'OpenVibe', url: 'https://openvibe.tools' },
        },
        {
            '@context': 'https://schema.org', '@type': 'BreadcrumbList',
            itemListElement: [
                { '@type': 'ListItem', position: 1, name: 'OpenVibe', item: 'https://openvibe.tools' },
                { '@type': 'ListItem', position: 2, name: HUB_NAME, item: `https://${HUB_HOST}/` },
                ...(host === HUB_HOST ? [] : [{ '@type': 'ListItem', position: 3, name: title, item: url }]),
            ],
        },
    ];

    const head = [
        `<link rel="canonical" href="${url}">`,
        '<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">',
        `<meta property="og:description" content="${esc(desc)}">`,
        `<meta property="og:url" content="${url}">`,
        `<meta property="og:image" content="${image}">`,
        '<meta property="og:image:width" content="1200">',
        '<meta property="og:image:height" content="630">',
        '<meta property="og:site_name" content="OpenVibe">',
        '<meta name="twitter:card" content="summary_large_image">',
        `<meta name="twitter:title" content="${esc(title)}">`,
        `<meta name="twitter:description" content="${esc(desc)}">`,
        `<meta name="twitter:image" content="${image}">`,
        ...ld.map(b => `<script type="application/ld+json">${JSON.stringify(b).replace(/</g, '\\u003c')}</script>`),
    ].join('\n');

    const out = html.replace(/<\/head>/i, `${head}\n</head>`);
    if (_cache.size > 100) _cache.clear();
    _cache.set(key, out);
    return out;
}

/** Express handler: the SPA with this host's SEO tags applied. */
function sendIndex(req, res) {
    const own = ownHost(req, h => !!DOMAIN_MAP[h]);
    const host = DOMAIN_MAP[own] ? own : HUB_HOST;
    try {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Vary', 'X-OV-Canonical-Host');
        return res.send(renderIndex(req.ctx || {}, host, canonicalHostFor(req, host)));
    } catch (err) {
        console.error('[SEO] render failed:', err.message);
        return res.sendFile(path.join(PUBLIC, 'index.html'));
    }
}

module.exports = { renderIndex, sendIndex };
