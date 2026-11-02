'use strict';

// ═══════════════════════════════════════════════════════════════
// The tool frame for the text and logo pages (openvibe-shared ≥ 4.57.1, owner ask 11, part 2).
//
// The text app's pages are their own HTML files, one per tool (several hosts share one file). The page
// keeps its own editor and its own live output; the frame goes around them: the head (the family crumb,
// the tool's name, one sentence, the terms), the box (the page's own editor), the answer (the page's
// live output, moved into the frame's answer slot by the shared browser glue), the family, the folds
// and "People also use".
//
// The head's copy is the page's own: its title is the tool's name and its description is the one
// sentence. The terms come from the app's real configuration: these tools run in the browser, so
// nothing is sent, and the rate is the guard's own for the class they are in.
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const kit = require('openvibe-shared/kit');
const serve = require('openvibe-shared/serve');
const frame = require('../../_shared/frame')({ kit, serve });
const { SPECS } = require('./descriptors');

const HUB = 'https://text.openvibe.tools/';
const esc = kit.esc;

// The page each tool lives in, and the family row's short names.
const PAGE_OF = {
    fancy: 'fancy.html', zalgo: 'zalgo.html', bubble: 'bubble.html', ascii: 'ascii.html', symbols: 'symbols.html',
    kaomoji: 'kaomoji.html', unicode: 'unicode.html', braille: 'braille.html', morse: 'morse.html', binary: 'binary.html',
    case: 'case.html', count: 'count.html', reversetext: 'reverse.html', clean: 'clean.html', sort: 'sort.html',
    compare: 'compare.html', json: 'json.html', markdown: 'markdown.html', escape: 'escape.html', slug: 'slug.html',
    bio: 'bio.html', nickname: 'nickname.html', logo: 'logo-hub.html', wordmark: 'wordmark.html', title: 'title.html',
    thumbnail: 'thumbnail.html', badge: 'badge.html', watermark: 'watermark.html', transparent: 'transparent.html',
    peso: 'peso.html', spanish: 'spanish.html', slang: 'slang.html', ice: 'ice.html',
};

const SHORT = {
    fancy: 'Fancy', zalgo: 'Zalgo', bubble: 'Bubble', ascii: 'ASCII', symbols: 'Symbols', kaomoji: 'Kaomoji',
    unicode: 'Unicode', braille: 'Braille', morse: 'Morse', binary: 'Binary', case: 'Case', count: 'Count',
    reversetext: 'Reverse', clean: 'Clean', sort: 'Sort', compare: 'Compare', json: 'JSON', markdown: 'Markdown',
    escape: 'Escape', slug: 'Slug', bio: 'Bio', nickname: 'Nickname', logo: 'Logo', wordmark: 'Wordmark',
    title: 'Title', thumbnail: 'Thumbnail', badge: 'Badge', watermark: 'Watermark', transparent: 'Transparent',
    peso: 'Peso', spanish: 'Spanish', slang: 'Slang', ice: 'ICE',
};

const ICON = {
    fancy: 'spark', zalgo: 'wave', bubble: 'spark', ascii: 'grid', symbols: 'list', kaomoji: 'star',
    unicode: 'code', braille: 'grid', morse: 'zap', binary: 'code', case: 'code', count: 'chart',
    reversetext: 'swap', clean: 'spark', sort: 'list', compare: 'swap', json: 'code', markdown: 'book',
    escape: 'lock', slug: 'link', bio: 'user', nickname: 'tag', logo: 'palette', wordmark: 'palette',
    title: 'pencil', thumbnail: 'image', badge: 'star', watermark: 'image', transparent: 'image',
    peso: 'coin', spanish: 'book', slang: 'chat', ice: 'shield',
};

const SPEC = new Map(SPECS.map((s) => [s.id, s]));

// The verb of each tool: the one button says what it does, never "Run".
const VERB = {'fancy': 'Make fancy text', 'zalgo': 'Add Zalgo', 'bubble': 'Make bubble text', 'ascii': 'Make ASCII art', 'symbols': 'Make symbols', 'kaomoji': 'Make kaomoji', 'unicode': 'Make Unicode', 'braille': 'Make braille', 'morse': 'Make Morse code', 'binary': 'Make binary', 'case': 'Change the case', 'count': 'Count the words', 'reversetext': 'Reverse the text', 'clean': 'Clean the text', 'sort': 'Sort the lines', 'compare': 'Compare the text', 'json': 'Format the JSON', 'markdown': 'Make Markdown', 'escape': 'Escape the text', 'slug': 'Make a slug', 'bio': 'Make a bio', 'nickname': 'Make a nickname', 'logo': 'Make a logo', 'wordmark': 'Make a wordmark', 'title': 'Make a title', 'thumbnail': 'Make a thumbnail', 'badge': 'Make a badge', 'watermark': 'Add a watermark', 'transparent': 'Make it transparent', 'peso': 'Make peso art', 'spanish': 'Add Spanish accents', 'slang': 'Make slang', 'ice': 'Make an ICE card'};

// The plain text of a page's element, without its tags.
const textOf = (html) => String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();

/** The first group of a match, as plain text. */
const pick = (html, re) => {
    const m = re.exec(html);
    return m ? textOf(m[1]) : '';
};

/**
 * The terms of a text tool, from the app's real configuration: these tools run in the browser, so
 * nothing is sent; the size of the text is the tool's own limit; and the rate is the guard's own for
 * the class the tool is in (apps/_shared/guard/limits.js).
 */
function termsOf(toolId) {
    const spec = SPEC.get(toolId);
    const facts = frame.terms({
        work: 'browser',
        quotaClass: (spec && spec.quotaClass) || 'tools-run',
        cost: (spec && spec.cost) || 1,
        unit: 'runs',
        needsAccount: !!(spec && spec.auth && spec.auth.anonymous === false),
    });
    // A tool with no server engine is not rate limited at all: it runs on the device. A tool with an
    // engine is limited by the guard's own table, and says so that the rate is not read as the page's.
    const at = facts.findIndex((f) => f.text.includes('a minute'));
    if (at >= 0) {
        facts[at] = spec && spec.api
            ? { ...facts[at], text: `API: ${facts[at].text}` }
            : { text: 'No limit: it runs on your device', icon: 'zap' };
    }
    // The size of the text the tool takes, from the tool's own limit.
    const maxBytes = spec && spec.limits && spec.limits.maxInputBytes;
    if (maxBytes) facts.push({ text: `Up to ${Math.round(maxBytes / 1024)} KB of text`, icon: 'file' });
    return facts;
}

/** The family: every text tool, with the one on the page marked. */
function familyItems(current, hostnameMap, nameOf) {
    const items = [];
    const seen = new Set();
    for (const [host, file] of Object.entries(hostnameMap)) {
        const toolId = TOOL_OF_FILE[file];
        if (!toolId || seen.has(toolId)) continue;
        seen.add(toolId);
        items.push({ href: `https://${host}/`, label: nameOf(toolId), short: SHORT[toolId] || nameOf(toolId), current: toolId === current });
    }
    return items;
}

/** The tool a page file holds. */
const TOOL_OF_FILE = Object.fromEntries(Object.entries(PAGE_OF).map(([id, file]) => [file, id]));

const PUBLIC = path.join(__dirname, '..', 'public');
let _names = null;

/** Every tool's name and its one sentence, read from the page's own head. */
function namesOf() {
    if (_names) return _names;
    _names = new Map();
    for (const [id, file] of Object.entries(PAGE_OF)) {
        let html = '';
        try { html = fs.readFileSync(path.join(PUBLIC, file), 'utf8'); } catch { continue; }
        _names.set(id, {
            name: pick(html, /<h1[^>]*>([\s\S]*?)<\/h1>/) || id,
            desc: pick(html, /<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i),
        });
    }
    return _names;
}

/** The "People also use" of a page: its own related links (the footer's data-related). */
function relatedOf(html) {
    const m = /data-related="([^"]*)"/.exec(html);
    if (!m) return [];
    return m[1].split(';').map((pair) => {
        const [title, href] = pair.split('|');
        if (!title || !href) return null;
        return kit.row({ href: href.trim(), title: title.trim(), sub: '' });
    }).filter(Boolean).slice(0, 4);
}

/**
 * The frame around a text page: the head, the box, the answer slot, the family, the folds and
 * "People also use". The page's own editor and buttons stay inside the box; its live output moves
 * into the answer slot (apps/_shared/public/tool-frame.js).
 *
 * @param {string} html the page's own HTML
 * @param {string} host the host that serves it
 * @param {object} [ctx] { hostnameMap, nameOf }
 * @returns {string} the page with the frame around it
 */
function frameAround(html, host, ctx = {}) {
    const file = ctx.file;
    const toolId = TOOL_OF_FILE[file];
    if (!toolId) return html;

    const own = namesOf().get(toolId) || { name: toolId, desc: '' };
    const name = (ctx.nameOf && ctx.nameOf(toolId)) || own.name;
    const task = (ctx.descOf && ctx.descOf(toolId)) || pick(html, /<p class="subtitle"[^>]*>([\s\S]*?)<\/p>/) || own.desc;
    const about = own.desc;

    const head = frame.head({
        icon: ICON[toolId] || 'code', hue: 140, family: 'text',
        crumb: { href: HUB, label: 'Text tools' },
        title: name, task, facts: termsOf(toolId),
    });

    const items = familyItems(toolId, ctx.hostnameMap || {}, ctx.nameOf || ((id) => (namesOf().get(id) || {}).name || id));
    const family = kit.family({
        title: 'More text tools', more: { href: HUB, label: 'All text tools' },
        items,
    });
    const folds = frame.folds({
        name, about,
        faq: [
            ['Is it free?', 'Yes. Every text tool here is free, and it runs in your browser.'],
            ['Does my text go anywhere?', 'No. The work happens in your browser; nothing is sent to a server.'],
            ['Can I call it from code?', 'Some of these tools have an API: POST /api/v1/tools/<tool>/run. The <a href="https://openvibe.tools/developers">API docs</a> has the list.'],
        ],
        api: {
            id: toolId, path: `/api/v1/tools/${toolId}/run`, fields: 'text',
            payload: { input: { text: 'Hello, World!' } }, needsAccount: false,
        },
    });
    // "People also use": the page's own related links, or the tools next to this one in the family.
    let related = relatedOf(html);
    if (!related.length) {
        related = items.filter((it) => !it.current).slice(0, 3)
            .map((it) => kit.row({ href: it.href, title: it.label, sub: '' }));
    }

    // The page's own main button says the verb, the way the other tools' buttons do.
    const verb = VERB[toolId] || 'Make it';
    const withVerb = html.replace(/(<button[^>]*class="[^"]*generate-btn[^"]*"[^>]*>)([\s\S]*?)(<\/button>)/i,
        // The button's own text is the last text in it: the icon, then the word.
        (m, open, mid, close) => `${open}${mid.replace(/>([^<>]*)$/, (_, text) => `>${esc(verb)}`)}${close}`);

    // The head replaces the page's own header (the page keeps one h1: the frame's), the box holds the
    // page's own editor and buttons, and the answer slot waits for the page's live output.
    let out = withVerb;
    // The page's own header and crumb go: the frame's head takes their place, and the page keeps one h1.
    out = out.replace(/<nav class="crumbs"[^>]*>[\s\S]*?<\/nav>\s*/i, '');
    out = out.replace(/<header class="tool-head"[^>]*>[\s\S]*?<\/header>\s*/i, '');
    out = out.replace(/<div class="page-header"[^>]*>[\s\S]*?<\/div>\s*/i, '');
    out = out.replace(/<div class="hub-hero"[^>]*>[\s\S]*?<\/div>\s*/i, '');
    // A text tool's example: a word to try it on. The page's own field takes it (the kit's try
    // fills the field and the page answers).
    const tryRow = /id="input"/.test(html)
        ? kit.tries({ name: 'text', target: '#input', items: [{ label: 'OpenVibe', value: 'OpenVibe' }] })
        : '';
    const open = `${head}\n<div class="ovk-tool-card">\n${tryRow}`;
    if (/<div class="tool-wrap"[^>]*>/i.test(out)) {
        out = out.replace(/<div class="tool-wrap"[^>]*>/i, (m) => `${m}\n${open}`);
    } else {
        out = out.replace(/<body[^>]*>/i, (m) => `${m}\n${open}`);
    }

    const tail = `</div>\n<div class="ovk-tool-out"></div>\n${family}\n${kit.tool ? `<div class="ovk-tool-folds">${folds.join('')}</div>` : ''}\n`
        + (related.length ? `<div class="ovk-tool-related">${kit.list(related, { title: 'People also use' })}</div>` : '')
        + `\n`;
    out = out.replace(/<div id="ov-footer"/i, `${tail}<div id="ov-footer"`);

    // The kit's look and behaviour, from this app's own pin.
    out = out.replace(/<\/head>/i, `${[
        `<link rel="stylesheet" href="${serve.url('kit.css')}">`,
        `<link rel="stylesheet" href="${serve.url('kit-data.css')}">`,
    ].join('\n')}\n</head>`);
    out = out.replace(/<\/body>/i, `${[
        '<script src="/shared/kit.js" defer></script>',
        '<script src="/shared/kit-web.js" defer></script>',
        '<script src="/shared/kit-data-web.js" defer></script>',
        '<script src="/js/tool-frame.js" defer></script>',
    ].join('\n')}\n</body>`);

    return out;
}

module.exports = { frameAround, termsOf, familyItems, relatedOf, namesOf, PAGE_OF, TOOL_OF_FILE, SHORT, VERB, HUB };
