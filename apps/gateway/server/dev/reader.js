'use strict';

// ═══════════════════════════════════════════════════════════════
// Reader: HTML → readable text, with no dependencies.
//
// readHtml(html, { baseUrl, format, maxChars }) → { title, description, lang, text, truncated,
// links }. A forgiving tokenizer builds a small tree (void elements, raw-text elements, implied
// </p> and </li>); the walk keeps <main> or <article> when there is one, drops navigation and
// page furniture, and writes headings as `#` lines, list items as `- `, links as [text](href).
// ═══════════════════════════════════════════════════════════════

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);
const SKIP = new Set(['head', 'nav', 'header', 'footer', 'aside', 'script', 'style', 'noscript', 'svg', 'form', 'iframe', 'template', 'select', 'textarea', 'button', 'object', 'canvas', 'math']);
const BLOCK = new Set(['p', 'div', 'section', 'article', 'main', 'ul', 'ol', 'li', 'blockquote', 'pre', 'table', 'tr', 'figure', 'figcaption', 'dl', 'dt', 'dd', 'address', 'details', 'summary', 'fieldset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'caption', 'thead', 'tbody', 'tfoot']);
const MAX_DEPTH = 256;          // deeper nesting is flattened into the parent: no recursion blow-ups
const MAX_LINKS = 50;
const MAX_ATTR_TEXT = 300;

const ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', shy: '',
    mdash: '—', ndash: '–', hellip: '…', copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»',
    lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', bull: '•', middot: '·',
    times: '×', divide: '÷', euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶',
    deg: '°', plusmn: '±', frac12: '½', frac14: '¼', frac34: '¾', larr: '←', rarr: '→', uarr: '↑',
    darr: '↓', hearts: '♥', check: '✓', iexcl: '¡', iquest: '¿', eacute: 'é', egrave: 'è', agrave: 'à',
    aacute: 'á', uuml: 'ü', ouml: 'ö', auml: 'ä', szlig: 'ß', ntilde: 'ñ', ccedil: 'ç',
};

function decodeEntities(s) {
    if (!s || s.indexOf('&') === -1) return s || '';
    return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,9});/gi, (m, e) => {
        if (e[0] === '#') {
            const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            if (!cp || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '';
            return cp === 0xa0 ? ' ' : String.fromCodePoint(cp);
        }
        const v = ENTITIES[e] !== undefined ? ENTITIES[e] : ENTITIES[e.toLowerCase()];
        return v === undefined ? m : v;
    });
}

// ── Tokenizer + tree ─────────────────────────────────────────
function parseAttrs(src) {
    const attrs = {};
    const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let m;
    while ((m = re.exec(src))) {
        const k = m[1].toLowerCase();
        if (attrs[k] === undefined) attrs[k] = decodeEntities(m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] || '');
    }
    return attrs;
}

function parse(html) {
    const root = { tag: '#root', attrs: {}, children: [], parent: null };
    let cur = root, depth = 0;
    const open = [];                       // element stack (cur is its top)
    const pushText = (t) => { if (t) cur.children.push({ text: decodeEntities(t) }); };
    const tokens = /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\?[^>]*>|<\/([a-zA-Z][^\s>\/]*)[^>]*>|<([a-zA-Z][^\s>\/]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
    let last = 0, m;
    while ((m = tokens.exec(html))) {
        if (m.index > last) pushText(html.slice(last, m.index));
        last = tokens.lastIndex;
        if (m[1]) {                                           // </tag>
            const name = m[1].toLowerCase();
            for (let i = open.length - 1; i >= 0; i--) {
                if (open[i].tag === name) { open.length = i; cur = i ? open[i - 1] : root; depth = open.length; break; }
            }
        } else if (m[2]) {                                    // <tag ...>
            const name = m[2].toLowerCase();
            const attrs = parseAttrs(m[3] || '');
            // Implied end tags: a new <li> closes the open one in the same list, a new block closes an open <p>.
            if (name === 'li') {
                for (let i = open.length - 1; i >= 0; i--) {
                    if (/^(ul|ol|menu)$/.test(open[i].tag)) break;
                    if (open[i].tag === 'li') { open.length = i; cur = i ? open[i - 1] : root; depth = open.length; break; }
                }
            } else if (cur.tag === 'p' && BLOCK.has(name)) {
                open.pop(); cur = open.length ? open[open.length - 1] : root; depth = open.length;
            }
            const node = { tag: name, attrs, children: [], parent: cur };
            cur.children.push(node);
            const selfClose = /\/\s*$/.test(m[3] || '');
            if (VOID.has(name) || (selfClose && !RAW.has(name))) continue;
            if (RAW.has(name)) {                              // everything up to the matching close tag is text
                const close = new RegExp('</' + name + '\\s*>', 'ig');
                close.lastIndex = tokens.lastIndex;
                const c = close.exec(html);
                const end = c ? c.index : html.length;
                const body = html.slice(tokens.lastIndex, end);
                if (body && (name === 'title' || name === 'textarea')) node.children.push({ text: body });
                tokens.lastIndex = last = c ? close.lastIndex : html.length;
                continue;
            }
            if (depth >= MAX_DEPTH) continue;                 // too deep: its children stay with the parent
            open.push(node); cur = node; depth++;
        }
    }
    if (last < html.length) pushText(html.slice(last));
    return root;
}

function find(node, pred) {
    const stack = [node];
    while (stack.length) {
        const n = stack.pop();
        if (n.tag && pred(n)) return n;
        if (n.children) for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
    }
    return null;
}
function rawText(n) {
    if (n.text !== undefined) return n.text;
    return (n.children || []).map(rawText).join('');
}
const collapse = (s) => s.replace(/[\s ]+/g, ' ').trim();

function metaContent(root, ...names) {
    const wanted = new Set(names);
    const found = {};
    const stack = [root];
    while (stack.length) {
        const n = stack.pop();
        if (n.tag === 'meta') {
            const k = (n.attrs.name || n.attrs.property || '').toLowerCase();
            if (wanted.has(k) && n.attrs.content && !found[k]) found[k] = collapse(decodeEntities(n.attrs.content));
        }
        if (n.children) for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
    }
    for (const k of names) if (found[k]) return found[k];
    return '';
}

// ── Output ───────────────────────────────────────────────────
function absolute(href, baseUrl) {
    if (!href || /^\s*(javascript|data|mailto|tel|blob):/i.test(href)) return null;
    try {
        const u = new URL(decodeEntities(href).trim(), baseUrl);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        if (u.username || u.password) return null;
        return u.href;
    } catch { return null; }
}

function render(rootNode, { baseUrl, markdown }) {
    const blocks = [];                     // { text, list }
    const links = [];
    const seen = new Set();
    const pageNoHash = (() => { try { const u = new URL(baseUrl); u.hash = ''; return u.href; } catch { return ''; } })();
    let buf = '', prefix = '', flushes = 0, listDepth = 0, quote = 0, pre = 0, listItem = false;

    function flush() {
        const lines = buf.split('\n').map(collapse).filter(Boolean);
        buf = '';
        if (!lines.length) { prefix = ''; listItem = false; return; }
        const pad = '> '.repeat(quote);
        blocks.push({ text: lines.map((l, i) => (i === 0 ? pad + prefix : pad + (prefix ? ' '.repeat(prefix.length) : '')) + l).join('\n'), list: listItem });
        prefix = ''; listItem = false; flushes++;
    }
    function addLink(text, href) {
        if (links.length >= MAX_LINKS || seen.has(href)) return;
        const noHash = href.replace(/#.*$/, '');
        if (noHash === pageNoHash) return;
        seen.add(href);
        links.push({ text: collapse(text).slice(0, MAX_ATTR_TEXT) || href, href });
    }

    function walk(n) {
        if (n.text !== undefined) { buf += pre ? n.text : n.text.replace(/\s+/g, ' '); return; }
        const t = n.tag;
        if (SKIP.has(t) || n.attrs.hidden !== undefined || /^true$/i.test(n.attrs['aria-hidden'] || '')) return;
        if (t === 'br') { buf += '\n'; return; }
        if (t === 'hr') { flush(); if (markdown) blocks.push({ text: '---', list: false }); return; }
        if (t === 'img') { return; }
        if (t === 'pre') {
            flush();
            const body = rawText(n).replace(/\r/g, '').replace(/^\n+|\s+$/g, '');
            if (body) blocks.push({ text: markdown ? '```\n' + body + '\n```' : body, list: false, raw: true });
            return;
        }
        if (/^h[1-6]$/.test(t)) {
            flush();
            if (markdown) prefix = '#'.repeat(Number(t[1])) + ' ';
            kids(n); flush(); return;
        }
        if (t === 'ul' || t === 'ol' || t === 'menu') { flush(); listDepth++; kids(n); flush(); listDepth--; return; }
        if (t === 'li') {
            flush();
            prefix = '  '.repeat(Math.max(0, listDepth - 1)) + '- ';
            listItem = true;
            // A nested list ends this item's own text first, so it is flushed by the child list.
            kids(n); flush(); return;
        }
        if (t === 'blockquote') { flush(); quote++; kids(n); flush(); quote--; return; }
        if (t === 'td' || t === 'th') { if (collapse(buf)) buf += ' | '; kids(n); return; }
        if (t === 'tr') { flush(); kids(n); buf = buf.replace(/\s*\|\s*$/, ''); flush(); return; }
        if (t === 'a') {
            const href = absolute(n.attrs.href, baseUrl);
            const start = buf.length, before = flushes;
            kids(n);
            if (!href || href.replace(/#.*$/, '') === pageNoHash) return;       // not a link, or the page itself
            const inner = collapse(buf.slice(start)) || collapse(n.attrs['aria-label'] || n.attrs.title || '');
            addLink(inner, href);
            if (markdown && flushes === before && inner && start <= buf.length) {
                const lead = /^\s/.test(buf.slice(start)) ? ' ' : '', trail = /\s$/.test(buf.slice(start)) ? ' ' : '';
                buf = buf.slice(0, start) + lead + '[' + inner.replace(/([\[\]])/g, '\\$1') + '](' + href.replace(/\)/g, '%29').replace(/\s/g, '%20') + ')' + trail;
            }
            return;
        }
        if (t === 'code' && markdown && !pre) {
            const c = collapse(rawText(n));
            if (c) buf += '`' + c.replace(/`/g, "'") + '`';
            return;
        }
        if (BLOCK.has(t)) { flush(); kids(n); flush(); return; }
        kids(n);
    }
    function kids(n) { for (const c of n.children) walk(c); }

    walk(rootNode);
    flush();
    let text = '';
    blocks.forEach((b, i) => {
        if (i) text += (b.list && blocks[i - 1].list) ? '\n' : '\n\n';
        text += b.text;
    });
    return { text, links };
}

function readHtml(html, { baseUrl, format = 'markdown', maxChars = 20000 } = {}) {
    const doc = parse(html);
    const markdown = format !== 'text';
    const htmlEl = find(doc, n => n.tag === 'html');
    const titleEl = find(doc, n => n.tag === 'title');
    let title = titleEl ? collapse(decodeEntities(rawText(titleEl))) : '';
    if (!title) title = metaContent(doc, 'og:title', 'twitter:title');
    const description = metaContent(doc, 'description', 'og:description', 'twitter:description');
    const lang = ((htmlEl && htmlEl.attrs.lang) || '').trim().slice(0, 35);

    const body = find(doc, n => n.tag === 'body') || doc;
    const main = find(body, n => n.tag === 'main' || (n.attrs.role || '').toLowerCase() === 'main') || find(body, n => n.tag === 'article');
    let out = render(main || body, { baseUrl, markdown });
    // A <main>/<article> that holds almost nothing (or whose header was dropped) is not the page: use the body.
    if (main && out.text.length < 200) {
        const whole = render(body, { baseUrl, markdown });
        if (whole.text.length > out.text.length) out = whole;
    }
    if (!title) { const h1 = find(body, n => n.tag === 'h1'); if (h1) title = collapse(decodeEntities(rawText(h1))); }

    let text = out.text;
    let truncated = false;
    if (text.length > maxChars) {
        text = text.slice(0, maxChars);
        const cut = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('. '));
        if (cut > maxChars * 0.8) text = text.slice(0, cut + 1);
        text = text.trimEnd();
        truncated = true;
    }
    return { title: title.slice(0, 500), description: description.slice(0, 1000), lang, text, truncated, links: out.links };
}

/** Decode a response body using the header's charset, then a <meta charset>, then UTF-8. */
function decodeBody(buf, contentType) {
    let cs = /charset\s*=\s*"?([\w.:-]+)/i.exec(contentType || '');
    if (!cs) cs = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(buf.subarray(0, 4096).toString('latin1'));
    const label = cs ? cs[1].toLowerCase() : 'utf-8';
    try { return new TextDecoder(label).decode(buf); } catch { return buf.toString('utf8'); }
}

module.exports = { readHtml, decodeBody, decodeEntities };
