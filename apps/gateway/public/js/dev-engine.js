// ═══════════════════════════════════════════════════════════════
// Dev.OpenVibe — the transforms behind the developer tools.
//
// One engine for two callers: the tool pages (dev.html loads this file and only adds presentation)
// and the server (server/dev/engines.js requires it for the tools API, ADR-027). Everything here is
// pure: no DOM, no network, no storage. The browser globals it uses exist in Node 22 as well
// (atob, btoa, escape, unescape, TextEncoder, URL, crypto.subtle, crypto.randomUUID).
//
// What is NOT here needs a browser: XML validation, XML minify and HTML to Markdown (DOMParser),
// HTML entity decoding (a DOM element), the terser-based JavaScript minifier and beautifier (loaded
// from a CDN on demand), and the regex tester (a visitor's pattern must not run on the server
// without isolation). Those stay in dev.html.
// ═══════════════════════════════════════════════════════════════
(function (root) {
'use strict';

const E = {};

// ── Data & formats ───────────────────────────────────────────
E.jsonfmt = (s, m) => { const o = JSON.parse(s); if (m === 'Minify') return JSON.stringify(o); if (m === 'Validate') return '\u2713 Valid JSON \u2014 ' + (Array.isArray(o) ? o.length + ' items' : typeof o === 'object' ? Object.keys(o).length + ' keys' : typeof o); return JSON.stringify(o, null, 2); };

function j2y(o, ind) {
    let r = '';
    if (Array.isArray(o)) o.forEach(v => { r += ind + '- ' + (typeof v === 'object' && v ? '\n' + j2y(v, ind + '  ') : v) + '\n'; });
    else if (typeof o === 'object' && o) for (const [k, v] of Object.entries(o)) r += typeof v === 'object' && v ? ind + k + ':\n' + j2y(v, ind + '  ') : ind + k + ': ' + v + '\n';
    else r += ind + o + '\n';
    return r;
}
/** mode 'YAML→JSON' (default) or 'JSON→YAML'. */
E.yaml = (s, m) => {
    if (String(m || '').includes('JSON\u2192')) { const o = JSON.parse(s); return j2y(o, ''); }
    const ln = s.split('\n').filter(l => l.trim() && !l.trim().startsWith('#')), r = {};
    for (const l of ln) { const mt = l.match(/^(\s*)([^:]+):\s*(.*)$/); if (mt) { let v = mt[3].trim(); v = v === '' || v === '~' || v === 'null' ? null : v === 'true' ? true : v === 'false' ? false : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v.replace(/^["']|["']$/g, ''); r[mt[2].trim()] = v; } }
    return JSON.stringify(r, null, 2);
};

/** Indent markup one tag per line (the XML, HTML and beautify formatters). */
function indentTags(s) {
    let f = '', ind = 0;
    s.replace(/>\s*</g, '><').split(/(<[^>]+>)/g).filter(Boolean).forEach(n => { if (n.match(/^<\//)) ind--; f += '  '.repeat(Math.max(0, ind)) + n.trim() + '\n'; if (n.match(/^<[^\/!?]/) && !n.match(/\/>/)) ind++; });
    return f.trim();
}
/** mode 'Format' (default) or 'Minify'. Validation needs a DOM parser and stays on the page. */
E.xml = (s, m) => (m === 'Minify' ? s.replace(/>\s+</g, '><').replace(/\s{2,}/g, ' ').trim() : indentTags(s));

/** CSV → rows of cells; quoted fields keep their commas. */
E.csvRows = (s) => s.trim().split('\n').map(r => { const c = []; let cur = '', q = false; for (let i = 0; i < r.length; i++) { if (r[i] === '"') q = !q; else if (r[i] === ',' && !q) { c.push(cur.trim()); cur = ''; } else cur += r[i]; } c.push(cur.trim()); return c; });
/** CSV → one object per row, keyed by the header row. */
E.csvObjects = (s) => { const rows = E.csvRows(s); const hd = rows[0]; return rows.slice(1).map(r => { const o = {}; hd.forEach((h, i) => { o[h] = r[i] || ''; }); return o; }); };

/** mode 'Format' (default), 'Uppercase' or 'Compact'. */
E.sql = (s, m) => {
    if (m === 'Compact') return s.replace(/\s+/g, ' ').trim();
    const kw = ['SELECT', 'DISTINCT', 'FROM', 'WHERE', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'ON', 'AND', 'OR', 'ORDER BY', 'GROUP BY', 'HAVING', 'LIMIT', 'OFFSET', 'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'CREATE TABLE', 'ALTER TABLE', 'UNION', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END'];
    let r = s; if (m === 'Uppercase') kw.forEach(k => { r = r.replace(new RegExp('\\b' + k.replace(/ /g, '\\s+') + '\\b', 'gi'), k); });
    kw.slice(0, 20).forEach(k => { r = r.replace(new RegExp('(\\b)(' + k.replace(/ /g, '\\s+') + ')(\\b)', 'gi'), '\n$1$2$3'); });
    return r.replace(/^\n+/, '').replace(/\n{2,}/g, '\n');
};

/** Markdown → HTML as the Markdown editor renders it (inline styles use the page's theme variables). */
E.md = (s) => s.replace(/^######\s(.+)/gm, '<h6>$1</h6>').replace(/^#####\s(.+)/gm, '<h5>$1</h5>').replace(/^####\s(.+)/gm, '<h4>$1</h4>')
    .replace(/^###\s(.+)/gm, '<h3>$1</h3>').replace(/^##\s(.+)/gm, '<h2>$1</h2>').replace(/^#\s(.+)/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code style="background:var(--bg3);padding:2px 5px;border-radius:4px">$1</code>')
    .replace(/^\- (.+)/gm, '<li>$1</li>').replace(/^> (.+)/gm, '<blockquote style="border-left:3px solid var(--ac);padding-left:12px;color:var(--tx2)">$1</blockquote>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color:var(--ac)">$1</a>')
    .replace(/^---$/gm, '<hr style="border:none;border-top:1px solid var(--brd);margin:16px 0">');
/** Markdown → clean HTML (no inline styles, lists wrapped, paragraphs), as Markdown to HTML copies it. */
E.md2html = (s) => {
    let h = E.md(s).replace(/ style="[^"]*"/g, '').replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>\n$1</ul>\n');
    h = h.split(/\n{2,}/).map(b => /^\s*<(h\d|ul|ol|li|blockquote|hr|pre|table)/.test(b) ? b : '<p>' + b.trim().replace(/\n/g, '<br>\n') + '</p>').join('\n');
    return h;
};

/** mode 'Format' (default), 'Minify' or 'Entities'. Unescaping entities needs a DOM and stays on the page. */
E.html = (s, m) => {
    if (m === 'Entities') return s.replace(/[\u00A0-\u9999<>&'"]/g, c => '&#' + c.charCodeAt(0) + ';');
    if (m === 'Minify') return s.replace(/\s+/g, ' ').replace(/>\s+</g, '><').trim();
    return indentTags(s);
};

// ── Encoding & crypto ────────────────────────────────────────
/** mode 'Encode' (default) or 'Decode'; UTF-8 safe. */
E.base64 = (s, m) => (m === 'Decode' ? decodeURIComponent(escape(atob(s.trim()))) : btoa(unescape(encodeURIComponent(s))));

/** mode 'Encode', 'Decode' or 'Parse' (default). */
E.url = (s, m) => {
    if (m === 'Encode') return encodeURIComponent(s);
    if (m === 'Decode') return decodeURIComponent(s);
    try { const u = new URL(s); return 'Protocol: ' + u.protocol + '\nHost:     ' + u.host + '\nPath:     ' + u.pathname + '\nSearch:   ' + u.search + '\nHash:     ' + u.hash + '\nOrigin:   ' + u.origin; } catch { return 'Invalid URL \u2014 include protocol (https://)'; }
};

/** A JWT's parts, decoded (never verified). exp: { at: ISO time, msLeft } when the payload has one. */
E.jwt = (s, now = Date.now()) => {
    const p = s.trim().split('.'); if (p.length !== 3) throw new Error('JWT must have 3 dot-separated parts');
    const d = v => JSON.parse(decodeURIComponent(escape(atob(v.replace(/-/g, '+').replace(/_/g, '/')))));
    const header = d(p[0]), payload = d(p[1]);
    const exp = payload.exp ? { at: new Date(payload.exp * 1000).toISOString(), msLeft: payload.exp * 1000 - now } : null;
    return { header, payload, signature: p[2], exp };
};

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** n random v4 UUIDs, one per line. */
E.uuids = (n) => Array.from({ length: n }, () => crypto.randomUUID()).join('\n');
E.isUuid = (s) => UUID_V4.test(String(s).trim());
/** mode 'Generate' (default), 'Bulk 10', 'Bulk 100' or 'Validate'. */
E.uuid = (s, m) => {
    if (m === 'Validate') return E.isUuid(s) ? '\u2713 Valid UUID v4' : '\u2717 Invalid UUID v4';
    return E.uuids(String(m || '').includes('100') ? 100 : String(m || '').includes('10') ? 10 : 1);
};

/** Hex digest of the UTF-8 text: algorithm 'SHA-256' (default), 'SHA-1' or 'SHA-512'. */
E.hash = async (s, algorithm) => {
    const a = algorithm === 'SHA-1' ? 'SHA-1' : algorithm === 'SHA-512' ? 'SHA-512' : 'SHA-256';
    const buf = await crypto.subtle.digest(a, new TextEncoder().encode(s));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
};

/** mode 'To Hex' (default) or 'From Hex'. */
E.hex = (s, m) => {
    if (m === 'From Hex') return s.trim().replace(/\s+/g, '').match(/.{2}/g).map(h => String.fromCharCode(parseInt(h, 16))).join('');
    return [...s].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join(' ');
};

// ── Time ─────────────────────────────────────────────────────
/** mode 'Now', 'To Date' or 'To Unix' (default). "Local" is the local time of whoever runs it. */
E.timestamp = (s, m, now = Date.now()) => {
    if (m === 'Now') { const n = now; return 'Unix (s):  ' + Math.floor(n / 1000) + '\nUnix (ms): ' + n + '\nISO 8601:  ' + new Date(n).toISOString() + '\nLocal:     ' + new Date(n).toLocaleString() + '\nUTC:       ' + new Date(n).toUTCString(); }
    if (m === 'To Date') { const v = Number(s.trim()), d = new Date(v < 1e12 ? v * 1000 : v); if (isNaN(d.getTime())) throw new Error('Invalid timestamp'); return 'ISO 8601:  ' + d.toISOString() + '\nLocal:     ' + d.toLocaleString() + '\nUTC:       ' + d.toUTCString() + '\nUnix (s):  ' + Math.floor(d / 1000) + '\nUnix (ms): ' + Number(d); }
    const d = new Date(s.trim()); if (isNaN(d.getTime())) throw new Error('Invalid date string'); return 'Unix (s):  ' + Math.floor(d / 1000) + '\nUnix (ms): ' + Number(d) + '\nISO 8601:  ' + d.toISOString() + '\nUTC:       ' + d.toUTCString();
};

/** A cron expression in words and its next five runs (local time of whoever runs it). */
E.cron = (s, now = Date.now()) => {
    const p = s.trim().split(/\s+/); if (p.length < 5) throw new Error('Need 5 fields: minute hour day month weekday');
    const N = [['minute', 0, 59], ['hour', 0, 23], ['day', 1, 31], ['month', 1, 12], ['weekday', 0, 6]];
    function desc(v, i) { if (v === '*') return 'every ' + N[i][0]; if (v.includes('/')) return 'every ' + v.split('/')[1] + ' ' + N[i][0] + 's'; return N[i][0] + ' ' + v; }
    function expand(v, mn, mx) {
        if (v === '*') return Array.from({ length: mx - mn + 1 }, (_, i) => i + mn);
        if (v.includes('/')) { const [b, st] = v.split('/'); const start = b === '*' ? mn : +b; const r = []; for (let i = start; i <= mx; i += +st) r.push(i); return r; }
        if (v.includes(',')) return v.split(',').map(Number);
        if (v.includes('-')) { const [a, b] = v.split('-').map(Number); return Array.from({ length: b - a + 1 }, (_, i) => i + a); }
        return [+v];
    }
    const mins = expand(p[0], 0, 59), hrs = expand(p[1], 0, 23), doms = expand(p[2], 1, 31), mos = expand(p[3], 1, 12), dws = expand(p[4], 0, 6);
    const nx = []; const d = new Date(now); d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1);
    for (let i = 0; i < 525600 && nx.length < 5; i++) { if (mins.includes(d.getMinutes()) && hrs.includes(d.getHours()) && doms.includes(d.getDate()) && mos.includes(d.getMonth() + 1) && dws.includes(d.getDay())) nx.push(new Date(d)); d.setMinutes(d.getMinutes() + 1); }
    return 'Schedule: ' + p.map((v, i) => desc(v, i)).join(', ') + '\n\nNext 5 runs:\n' + nx.map((x, i) => '  ' + (i + 1) + '. ' + x.toLocaleString()).join('\n');
};

// ── Code quality ─────────────────────────────────────────────
/** mode 'JSON', 'CSS' or 'HTML' (default). */
E.beautify = (s, m) => {
    if (m === 'JSON') return JSON.stringify(JSON.parse(s), null, 2);
    if (m === 'CSS') { let r = '', ind = 0; for (const c of s) { if (c === '{') { r += ' {\n'; ind++; r += '  '.repeat(ind); } else if (c === '}') { ind--; r += '\n' + '  '.repeat(ind) + '}\n' + '  '.repeat(ind); } else if (c === ';') r += ';\n' + '  '.repeat(ind); else r += c; } return r.trim(); }
    return indentTags(s);
};

/** mode 'JSON', 'CSS', 'HTML' or anything else (JavaScript comments and whitespace). */
E.minify = (s, m) => {
    if (m === 'JSON') return JSON.stringify(JSON.parse(s));
    if (m === 'CSS') return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').replace(/\s*([{}:;,])\s*/g, '$1').trim();
    if (m === 'HTML') return s.replace(/\s+/g, ' ').replace(/>\s+</g, '><').trim();
    return s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim();
};

const LOREM = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum'.split(' ');
/** unit 'paragraphs' (default), 'sentences' or 'words'; count of that unit. */
E.lorem = (unit, count) => {
    const rw = () => LOREM[Math.random() * LOREM.length | 0];
    const sent = () => { const n = 8 + (Math.random() * 10 | 0); const s = Array.from({ length: n }, rw).join(' '); return s[0].toUpperCase() + s.slice(1) + '.'; };
    const para = () => Array.from({ length: 4 + (Math.random() * 4 | 0) }, sent).join(' ');
    if (unit === 'words') return Array.from({ length: count || 50 }, rw).join(' ');
    if (unit === 'sentences') return Array.from({ length: count || 10 }, sent).join(' ');
    return Array.from({ length: count || 3 }, para).join('\n\n');
};

/** A curl command → mode 'Parsed', 'To fetch', 'To Python' or Node.js (default). */
E.curlconvert = (s, m) => {
    const cmd = s.trim().replace(/\\\n/g, ' '); let method = 'GET', url = '', body = ''; const hd = {};
    const tok = []; let cur = '', inQ = false, qc = '';
    for (let i = 0; i < cmd.length; i++) { const c = cmd[i]; if (!inQ && (c === "'" || c === '"')) { inQ = true; qc = c; } else if (inQ && c === qc) { inQ = false; } else if (!inQ && c === ' ') { if (cur) { tok.push(cur); cur = ''; } continue; } else cur += c; }
    if (cur) tok.push(cur);
    for (let i = 0; i < tok.length; i++) {
        const t = tok[i];
        if (t === '-X' || t === '--request') method = tok[++i];
        else if (t === '-H' || t === '--header') { const h = tok[++i]; const ci = h.indexOf(':'); if (ci > 0) hd[h.slice(0, ci).trim()] = h.slice(ci + 1).trim(); }
        else if (t === '-d' || t === '--data' || t === '--data-raw') body = tok[++i];
        else if (!t.startsWith('-') && t !== 'curl') url = t;
    }
    if (body && method === 'GET') method = 'POST';
    if (m === 'Parsed') return 'Method:  ' + method + '\nURL:     ' + url + '\nHeaders:\n' + Object.entries(hd).map(([k, v]) => '  ' + k + ': ' + v).join('\n') + '\nBody:    ' + (body || '(none)');
    if (m === 'To fetch') return "fetch('" + url + "', {\n  method: '" + method + "',\n  headers: " + JSON.stringify(hd, null, 4).replace(/\n/g, '\n  ') + ',' + (body ? "\n  body: '" + body + "'," : '') + '\n});';
    if (m === 'To Python') return "import requests\n\nresponse = requests." + method.toLowerCase() + "(\n    '" + url + "',\n    headers=" + JSON.stringify(hd) + ',' + (body ? "\n    data='" + body + "'," : '') + '\n)\nprint(response.json())';
    return "const https = require('https');\n\nconst req = https.request('" + url + "', {\n  method: '" + method + "',\n  headers: " + JSON.stringify(hd, null, 4).replace(/\n/g, '\n  ') + "\n}, res => {\n  let data = '';\n  res.on('data', c => data += c);\n  res.on('end', () => console.log(data));\n});\n" + (body ? "req.write('" + body + "');\n" : '') + 'req.end();';
};

// ── Frontend ─────────────────────────────────────────────────
/** '#rrggbb' or 'rgb(r, g, b)' → { hex, r, g, b, rgb, hsl, complement }. */
E.color = (s) => {
    let r, g, b; const v = s.trim();
    if (v.startsWith('#')) { const hx = v.slice(1); r = parseInt(hx.slice(0, 2), 16); g = parseInt(hx.slice(2, 4), 16); b = parseInt(hx.slice(4, 6), 16); }
    else if (v.startsWith('rgb')) { [r, g, b] = v.match(/\d+/g).map(Number); }
    else throw new Error('Enter HEX (#ff0000) or RGB (rgb(255,0,0))');
    if ([r, g, b].some(x => isNaN(x))) throw new Error('Invalid color value');
    const mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255, d = mx - mn; let h = 0, s2 = 0; const l = (mx + mn) / 2;
    if (d) { s2 = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn); if (mx === r / 255) h = ((g / 255 - b / 255) / d + (g < b ? 6 : 0)) * 60; else if (mx === g / 255) h = ((b / 255 - r / 255) / d + 2) * 60; else h = ((r / 255 - g / 255) / d + 4) * 60; }
    const hex = '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
    return { hex, r, g, b, rgb: 'rgb(' + r + ', ' + g + ', ' + b + ')', hsl: 'hsl(' + Math.round(h) + ', ' + Math.round(s2 * 100) + '%, ' + Math.round(l * 100) + '%)', complement: '#' + [255 - r, 255 - g, 255 - b].map(c => c.toString(16).padStart(2, '0')).join('') };
};

// ── Single-purpose tools ─────────────────────────────────────
/** Stylesheet minifier: strings and url() kept, comments and whitespace out, 0px → 0, #aabbcc → #abc. */
E.cssMinify = (s) => {
    const keep = []; s = s.replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|url\([^)]*\))/g, (m) => { keep.push(m); return '\u0000' + (keep.length - 1) + '\u0000'; });
    s = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').replace(/\s*([{}:;,>+~])\s*/g, '$1').replace(/;}/g, '}').replace(/(^|[\s:,(])0(?:px|em|rem|%|pt|vh|vw)(?=[\s;,)}]|$)/g, '$10').replace(/#([0-9a-f])\1([0-9a-f])\2([0-9a-f])\3\b/gi, '#$1$2$3').trim();
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[+i]);
};
E.cssFormat = (s) => {
    let out = '', depth = 0; const pad = () => '  '.repeat(depth); const min = E.cssMinify(s); let buf = '';
    for (let i = 0; i < min.length; i++) {
        const c = min[i];
        if (c === '{') { out += pad() + buf.trim() + ' {\n'; buf = ''; depth++; }
        else if (c === '}') { if (buf.trim()) out += pad() + buf.trim().replace(/:(?!\/\/)/, ': ') + ';\n'; buf = ''; depth = Math.max(0, depth - 1); out += pad() + '}\n' + (depth ? '' : '\n'); }
        else if (c === ';') { out += pad() + buf.trim().replace(/:(?!\/\/)/, ': ') + ';\n'; buf = ''; }
        else buf += c;
    }
    return out.trim();
};
/** HTML minifier: pre, textarea, script and style kept as they are; comments (not IE conditionals) out. */
E.htmlMinify = (s) => {
    const keep = []; let o = s.replace(/<(pre|textarea|script|style)\b[\s\S]*?<\/\1>/gi, (m) => { keep.push(m); return '\u0000' + (keep.length - 1) + '\u0000'; });
    o = o.replace(/<!--(?!\[if)[\s\S]*?-->/g, '').replace(/\s+/g, ' ').replace(/>\s+</g, '> <').replace(/>\s<(\/?(?:html|head|body|div|p|ul|ol|li|table|tr|td|th|thead|tbody|section|article|header|footer|nav|main|h[1-6]|meta|link|title|br|hr)\b)/gi, '><$1').trim();
    return o.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[+i]);
};

/** JSON.parse with the line, column and a hint for the usual mistakes. */
function jsonWhere(s, e) {
    const m = /position (\d+)/.exec(e.message); if (!m) return e.message;
    const pos = +m[1], pre = s.slice(0, pos), line = pre.split('\n').length, col = pos - pre.lastIndexOf('\n');
    const near = s.slice(Math.max(0, pos - 20), pos + 1); let hint = '';
    if (/,\s*[}\]]$/.test(s.slice(0, pos + 1).replace(/\s+$/, '')) || /,\s*$/.test(pre)) hint = ' A trailing comma is not allowed in JSON.';
    else if (/'/.test(near)) hint = ' JSON strings and keys need double quotes.';
    else if (/\/\/|\/\*/.test(near)) hint = ' JSON has no comments.';
    else if (/[{,]\s*[A-Za-z_]\w*\s*:?$/.test(pre + s[pos])) hint = ' Keys must be in double quotes.';
    return `Line ${line}, column ${col}: ${e.message.replace(/ in JSON at position \d+.*/, '')}.${hint}`;
}
E.jsonIn = (s) => { try { return JSON.parse(s); } catch (e) { throw new Error(jsonWhere(s, e)); } };
const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
E.jsonMinify = (s) => JSON.stringify(E.jsonIn(s));
/** { kind, size (items or keys; null for a scalar), values, depth } of valid JSON; throws with the position otherwise. */
E.jsonStats = (s) => {
    const v = E.jsonIn(s); let n = 0, depth = 0;
    (function walk(x, d) { n++; depth = Math.max(depth, d); if (x && typeof x === 'object') for (const k in x) walk(x[k], d + 1); })(v, 0);
    return { kind: kind(v), size: Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : null, values: n, depth };
};
/** view 'Tree', 'Paths' (default) or 'Types'. */
E.jsonParse = (s, m) => {
    const v = E.jsonIn(s); if (m === 'Tree') return JSON.stringify(v, null, 2); const rows = [];
    (function walk(x, p) {
        if (x && typeof x === 'object') {
            if (m === 'Types') rows.push((p || '$') + '  ' + kind(x));
            const ks = Array.isArray(x) ? x.map((_, i) => i) : Object.keys(x);
            if (!ks.length && m !== 'Types') rows.push((p || '$') + ' = ' + JSON.stringify(x));
            for (const k of ks) walk(x[k], Array.isArray(x) ? p + '[' + k + ']' : (/^[A-Za-z_$][\w$]*$/.test(k) ? (p ? p + '.' : '') + k : p + '[' + JSON.stringify(k) + ']'));
        } else rows.push((p || '$') + (m === 'Types' ? '  ' + kind(x) : ' = ' + JSON.stringify(x)));
    })(v, '');
    return rows.join('\n');
};
/** mode 'Stringify' (default) or 'Parse string'. */
E.jsonStringify = (s, m) => {
    if (m === 'Parse string') { const t = s.trim(); const inner = JSON.parse(/^"/.test(t) ? t : '"' + t.replace(/"/g, '\\"') + '"'); return JSON.stringify(E.jsonIn(inner), null, 2); }
    return JSON.stringify(JSON.stringify(E.jsonIn(s)));
};

if (typeof module !== 'undefined' && module.exports) module.exports = E;
else root.DevEngine = E;
})(typeof window !== 'undefined' ? window : this);
