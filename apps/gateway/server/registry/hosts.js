'use strict';
// ═══════════════════════════════════════════════════════════════
// Tool hosts as the code defines them (pure data, no requires): the zone, which tools have a
// descriptive canonical host and a short one, and which builds are folded into another tool.
// The registry (./index.js) adds the owner's domain overrides on top; the satellites read this file
// through apps/_shared/tools to name the same default hosts in their own GET /api/v1/tools.
// ═══════════════════════════════════════════════════════════════

const ZONE = 'openvibe.tools';
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// Human-first defaults: the descriptive host is canonical, the one people already type is short.
const HOST_DEFAULTS = {
    jsminify: { canonical: 'js-minifier', short: 'jsminify', aliases: ["minifyjs", "javascript-minifier", "jsmin"] },
    jsformat: { canonical: 'js-beautifier', short: 'jsformat', aliases: ["jsbeautify", "javascript-beautifier", "unminify"] },
    cssminify: { canonical: 'css-minifier', short: 'cssminify', aliases: ["minifycss", "cssmin", "css-compressor"] },
    cssformat: { canonical: 'css-beautifier', short: 'cssformat', aliases: ["cssbeautify", "css-formatter", "unminifycss"] },
    htmlminify: { canonical: 'html-minifier', short: 'htmlminify', aliases: ["minifyhtml", "htmlmin", "html-compressor"] },
    xmlminify: { canonical: 'xml-minifier', short: 'xmlminify', aliases: ["minifyxml", "xmlmin"] },
    jsonminify: { canonical: 'json-minifier', short: 'jsonminify', aliases: ["minifyjson", "jsonmin", "json-compressor"] },
    jsonparse: { canonical: 'json-parser', short: 'jsonparse', aliases: ["jsonviewer", "json-viewer", "jsontree", "parsejson"] },
    jsonvalidate: { canonical: 'json-validator', short: 'jsonvalidate', aliases: ["jsonlint", "validatejson", "json-lint", "jsoncheck"] },
    jsonstringify: { canonical: 'json-stringify', short: 'jsonstringify', aliases: ["jsonescape", "json-escape", "jsonunescape", "stringifyjson"] },
    html2md: { canonical: 'html-to-markdown', short: 'html2md', aliases: ["htmltomarkdown", "html2markdown", "htmltomd"] },
    md2html: { canonical: 'markdown-to-html', short: 'md2html', aliases: ["markdowntohtml", "md2htm", "mdtohtml"] },
    yt: { canonical: 'youtube-downloader', short: 'yt', aliases: ['youtube', 'ytdl', 'youtubedownloader', 'youtube-download'] },
};

// The same tool built twice (once in Text, once in Developer Tools). People see ONE entry, under the
// friendliest address; the other build keeps serving as a **mirror**: 200, rel=canonical → the primary,
// never listed, never in a sitemap. `alsoIn` lets the primary show up on the second family's page.
const MERGED = {
    jsonfmt: { into: 'json', alsoIn: 'dev' }, md: { into: 'markdown', alsoIn: 'dev' }, codediff: { into: 'compare', alsoIn: 'dev' },
    slugify: { into: 'slug', alsoIn: 'dev' }, entities: { into: 'escape', alsoIn: 'dev' },
};

/** 'yt' → 'yt.openvibe.tools'; a full hostname is kept as it is. */
const toHost = (h) => { const s = String(h || '').trim().toLowerCase(); return s.includes('.') && HOST_RE.test(s) ? s : `${s}.${ZONE}`; };

/** A tool's code-default hosts: { canonical, short|null } (no owner overrides). */
function defaultHosts(id) {
    const d = HOST_DEFAULTS[id] || {};
    const canonical = toHost(d.canonical || id);
    const short = d.short ? toHost(d.short) : null;
    return { canonical, short: short === canonical ? null : short };
}

module.exports = { ZONE, HOST_RE, HOST_DEFAULTS, MERGED, toHost, defaultHosts };
