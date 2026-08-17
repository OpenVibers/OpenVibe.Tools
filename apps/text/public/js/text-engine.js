// ═══════════════════════════════════════════════════════════════
// Text.OpenVibe — Text Transform Engine
// Comprehensive Unicode style transforms, Zalgo, ASCII art,
// case converters, cleanup, and text analysis. 100% client-side.
// ═══════════════════════════════════════════════════════════════

(function (root) {
'use strict';

// ── Unicode Mathematical Alphanumeric Offsets ────────────────
// For styles based on contiguous Unicode blocks, we just offset.
// Format: { upper: startCodePoint, lower: startCodePoint, digit: startCodePoint }
const OFFSET_STYLES = {
    bold:              { upper: 0x1D400, lower: 0x1D41A, digit: 0x1D7CE },
    italic:            { upper: 0x1D434, lower: 0x1D44E },
    boldItalic:        { upper: 0x1D468, lower: 0x1D482 },
    script:            { upper: 0x1D49C, lower: 0x1D4B6 },
    boldScript:        { upper: 0x1D4D0, lower: 0x1D4EA },
    fraktur:           { upper: 0x1D504, lower: 0x1D51E },
    boldFraktur:       { upper: 0x1D56C, lower: 0x1D586 },
    doubleStruck:      { upper: 0x1D538, lower: 0x1D552, digit: 0x1D7D8 },
    sansSerif:         { upper: 0x1D5A0, lower: 0x1D5BA, digit: 0x1D7E2 },
    sansSerifBold:     { upper: 0x1D5D4, lower: 0x1D5EE, digit: 0x1D7EC },
    sansSerifItalic:   { upper: 0x1D608, lower: 0x1D622 },
    sansSerifBoldItalic: { upper: 0x1D63C, lower: 0x1D656 },
    monospace:         { upper: 0x1D670, lower: 0x1D68A, digit: 0x1D7F6 },
    fullwidth:         { upper: 0xFF21, lower: 0xFF41, digit: 0xFF10 },
};

// Exceptions: Some chars in script/fraktur/double-struck have pre-existing code points
const EXCEPTIONS = {
    script:       { B:'\u212C',E:'\u2130',F:'\u2131',H:'\u210B',I:'\u2110',L:'\u2112',M:'\u2133',R:'\u211B',e:'\u212F',g:'\u210A',o:'\u2134' },
    fraktur:      { C:'\u212D',H:'\u210C',I:'\u2111',R:'\u211C',Z:'\u2128' },
    doubleStruck: { C:'\u2102',H:'\u210D',N:'\u2115',P:'\u2119',Q:'\u211A',R:'\u211D',Z:'\u2124' },
};

// ── Lookup-table styles (no simple offset) ───────────────────
const CIRCLED_UPPER = '\u24B6\u24B7\u24B8\u24B9\u24BA\u24BB\u24BC\u24BD\u24BE\u24BF\u24C0\u24C1\u24C2\u24C3\u24C4\u24C5\u24C6\u24C7\u24C8\u24C9\u24CA\u24CB\u24CC\u24CD\u24CE\u24CF';
const CIRCLED_LOWER = '\u24D0\u24D1\u24D2\u24D3\u24D4\u24D5\u24D6\u24D7\u24D8\u24D9\u24DA\u24DB\u24DC\u24DD\u24DE\u24DF\u24E0\u24E1\u24E2\u24E3\u24E4\u24E5\u24E6\u24E7\u24E8\u24E9';
const CIRCLED_DIGITS = '\u24EA\u2460\u2461\u2462\u2463\u2464\u2465\u2466\u2467\u2468';

const NEG_CIRCLED = '\uD83C\uDD50\uD83C\uDD51\uD83C\uDD52\uD83C\uDD53\uD83C\uDD54\uD83C\uDD55\uD83C\uDD56\uD83C\uDD57\uD83C\uDD58\uD83C\uDD59\uD83C\uDD5A\uD83C\uDD5B\uD83C\uDD5C\uD83C\uDD5D\uD83C\uDD5E\uD83C\uDD5F\uD83C\uDD60\uD83C\uDD61\uD83C\uDD62\uD83C\uDD63\uD83C\uDD64\uD83C\uDD65\uD83C\uDD66\uD83C\uDD67\uD83C\uDD68\uD83C\uDD69';

const SQUARED_UPPER = Array.from({length:26}, (_, i) => String.fromCodePoint(0x1F130 + i)).join('');
const NEG_SQUARED_UPPER = Array.from({length:26}, (_, i) => String.fromCodePoint(0x1F170 + i)).join('');
const REGIONAL_UPPER = Array.from({length:26}, (_, i) => String.fromCodePoint(0x1F1E6 + i)).join('');

// Small caps (Latin small caps — not all letters have them)
const SMALL_CAPS_MAP = {
    a:'\u1D00',b:'\u0299',c:'\u1D04',d:'\u1D05',e:'\u1D07',f:'\uA730',g:'\u0262',
    h:'\u029C',i:'\u026A',j:'\u1D0A',k:'\u1D0B',l:'\u029F',m:'\u1D0D',n:'\u0274',
    o:'\u1D0F',p:'\u1D18',q:'\u0071',r:'\u0280',s:'\u0455',t:'\u1D1B',u:'\u1D1C',
    v:'\u1D20',w:'\u1D21',x:'\u0078',y:'\u028F',z:'\u1D22',
};

// Upside-down (flipped) character map
const UPSIDE_DOWN_MAP = {
    a:'\u0250',b:'q',c:'\u0254',d:'p',e:'\u01DD',f:'\u025F',g:'\u0183',
    h:'\u0265',i:'\u0131',j:'\u027E',k:'\u029E',l:'l',m:'\u026F',n:'u',
    o:'o',p:'d',q:'b',r:'\u0279',s:'s',t:'\u0287',u:'n',v:'\u028C',
    w:'\u028D',x:'x',y:'\u028E',z:'z',
    A:'\u2200',B:'\u10412',C:'\u0186',D:'\u15E1',E:'\u018E',F:'\u2132',G:'\u2141',
    H:'H',I:'I',J:'\u017F',K:'\u22CA',L:'\u2142',M:'W',N:'N',O:'O',
    P:'\u0500',Q:'\u038C',R:'\u1D1A',S:'S',T:'\u22A5',U:'\u2229',V:'\u039B',
    W:'M',X:'X',Y:'\u2144',Z:'Z',
    '1':'\u21C2','2':'\u1105','3':'\u0190','4':'\u152D','5':'\u03DB','6':'9','7':'\u3125',
    '8':'8','9':'6','0':'0',
    '.':'\u02D9',',':'\u2018','?':'\u00BF','!':'\u00A1',
    '\'':',','"':'\u201E','(':')',')'
    :'(','{':'}','}':'{','[':']',']':'[',
    '<':'>','>':'<','&':'\u214B','_':'\u203E',
};

// Superscript map
const SUPERSCRIPT_MAP = {
    '0':'\u2070','1':'\u00B9','2':'\u00B2','3':'\u00B3','4':'\u2074',
    '5':'\u2075','6':'\u2076','7':'\u2077','8':'\u2078','9':'\u2079',
    '+':'\u207A','-':'\u207B','=':'\u207C','(':'\u207D',')':'\u207E',
    a:'\u1D43',b:'\u1D47',c:'\u1D9C',d:'\u1D48',e:'\u1D49',f:'\u1DA0',
    g:'\u1D4D',h:'\u02B0',i:'\u2071',j:'\u02B2',k:'\u1D4F',l:'\u02E1',
    m:'\u1D50',n:'\u207F',o:'\u1D52',p:'\u1D56',r:'\u02B3',s:'\u02E2',
    t:'\u1D57',u:'\u1D58',v:'\u1D5B',w:'\u02B7',x:'\u02E3',y:'\u02B8',z:'\u1DBB',
};

// Subscript map
const SUBSCRIPT_MAP = {
    '0':'\u2080','1':'\u2081','2':'\u2082','3':'\u2083','4':'\u2084',
    '5':'\u2085','6':'\u2086','7':'\u2087','8':'\u2088','9':'\u2089',
    '+':'\u208A','-':'\u208B','=':'\u208C','(':'\u208D',')':'\u208E',
    a:'\u2090',e:'\u2091',h:'\u2095',i:'\u1D62',j:'\u2C7C',k:'\u2096',
    l:'\u2097',m:'\u2098',n:'\u2099',o:'\u2092',p:'\u209A',r:'\u1D63',
    s:'\u209B',t:'\u209C',u:'\u1D64',v:'\u1D65',x:'\u2093',
};

// ── Core transform function ──────────────────────────────────
function applyOffsetStyle(text, styleName) {
    const style = OFFSET_STYLES[styleName];
    if (!style) return text;
    const exceptions = EXCEPTIONS[styleName] || {};

    return [...text].map(ch => {
        if (exceptions[ch]) return exceptions[ch];
        const code = ch.codePointAt(0);
        if (code >= 65 && code <= 90 && style.upper) return String.fromCodePoint(style.upper + code - 65);
        if (code >= 97 && code <= 122 && style.lower) return String.fromCodePoint(style.lower + code - 97);
        if (code >= 48 && code <= 57 && style.digit) return String.fromCodePoint(style.digit + code - 48);
        return ch;
    }).join('');
}

function applyLookupStyle(text, upperTable, lowerTable, digitTable) {
    const upArr = upperTable ? [...upperTable] : null;
    const loArr = lowerTable ? [...lowerTable] : null;
    const dgArr = digitTable ? [...digitTable] : null;
    return [...text].map(ch => {
        const code = ch.codePointAt(0);
        if (code >= 65 && code <= 90 && upArr) return upArr[code - 65] || ch;
        if (code >= 97 && code <= 122 && loArr) return loArr[code - 97] || ch;
        if (code >= 48 && code <= 57 && dgArr) return dgArr[code - 48] || ch;
        return ch;
    }).join('');
}

function applyCharMap(text, map) {
    return [...text].map(ch => map[ch] || ch).join('');
}

// ── All fancy text styles ────────────────────────────────────
const ALL_STYLES = {
    bold:              { name: 'Bold',               fn: t => applyOffsetStyle(t, 'bold') },
    italic:            { name: 'Italic',             fn: t => applyOffsetStyle(t, 'italic') },
    boldItalic:        { name: 'Bold Italic',        fn: t => applyOffsetStyle(t, 'boldItalic') },
    script:            { name: 'Script',             fn: t => applyOffsetStyle(t, 'script') },
    boldScript:        { name: 'Bold Script',        fn: t => applyOffsetStyle(t, 'boldScript') },
    fraktur:           { name: 'Fraktur / Gothic',   fn: t => applyOffsetStyle(t, 'fraktur') },
    boldFraktur:       { name: 'Bold Fraktur',       fn: t => applyOffsetStyle(t, 'boldFraktur') },
    doubleStruck:      { name: 'Double-Struck',      fn: t => applyOffsetStyle(t, 'doubleStruck') },
    sansSerif:         { name: 'Sans-Serif',         fn: t => applyOffsetStyle(t, 'sansSerif') },
    sansSerifBold:     { name: 'Sans-Serif Bold',    fn: t => applyOffsetStyle(t, 'sansSerifBold') },
    sansSerifItalic:   { name: 'Sans-Serif Italic',  fn: t => applyOffsetStyle(t, 'sansSerifItalic') },
    sansSerifBoldItalic: { name: 'Sans Bold Italic', fn: t => applyOffsetStyle(t, 'sansSerifBoldItalic') },
    monospace:         { name: 'Monospace',          fn: t => applyOffsetStyle(t, 'monospace') },
    fullwidth:         { name: 'Fullwidth / Wide',   fn: t => applyOffsetStyle(t, 'fullwidth') },
    circled:           { name: 'Circled',            fn: t => applyLookupStyle(t, CIRCLED_UPPER, CIRCLED_LOWER, CIRCLED_DIGITS) },
    squared:           { name: 'Squared',            fn: t => applyLookupStyle(t, SQUARED_UPPER, null, null) },
    negSquared:        { name: 'Negative Squared',   fn: t => applyLookupStyle(t, NEG_SQUARED_UPPER, null, null) },
    regional:          { name: 'Regional Indicator',  fn: t => applyLookupStyle(t, REGIONAL_UPPER, null, null) },
    smallCaps:         { name: 'Small Caps',         fn: t => applyCharMap(t, SMALL_CAPS_MAP) },
    superscript:       { name: 'Superscript',        fn: t => applyCharMap(t, SUPERSCRIPT_MAP) },
    subscript:         { name: 'Subscript',          fn: t => applyCharMap(t, SUBSCRIPT_MAP) },
    upsideDown:        { name: 'Upside Down',        fn: t => applyCharMap([...t].reverse().join(''), UPSIDE_DOWN_MAP) },
    mirrored:          { name: 'Reversed / Mirror',  fn: t => [...t].reverse().join('') },
    strikethrough:     { name: 'Strikethrough',      fn: t => [...t].map(c => c + '\u0336').join('') },
    underline:         { name: 'Underline',          fn: t => [...t].map(c => c + '\u0332').join('') },
    doubleUnderline:   { name: 'Double Underline',   fn: t => [...t].map(c => c + '\u0333').join('') },
    overline:          { name: 'Overline',           fn: t => [...t].map(c => c + '\u0305').join('') },
    slashed:           { name: 'Slashed',            fn: t => [...t].map(c => c + '\u0338').join('') },
    dotted:            { name: 'Dotted',             fn: t => [...t].join('\u2024') },
    spaced:            { name: 'S p a c e d',        fn: t => [...t].join(' ') },
    parenthesized:     { name: 'Parenthesized',      fn: t => [...t].map(c => {
        const code = c.codePointAt(0);
        if (code >= 97 && code <= 122) return String.fromCodePoint(0x249C + code - 97);
        return c;
    }).join('') },
};

// ── Zalgo text generation ────────────────────────────────────
const ZALGO_UP = [
    0x030D,0x030E,0x0304,0x0305,0x033F,0x0311,0x0306,0x0310,0x0352,0x0357,
    0x0351,0x0307,0x0308,0x030A,0x0342,0x0343,0x0344,0x034A,0x034B,0x034C,
    0x0303,0x0302,0x030C,0x0350,0x0300,0x0301,0x030B,0x030F,0x0312,0x0313,
    0x0314,0x033D,0x0309,0x0363,0x0364,0x0365,0x0366,0x0367,0x0368,0x0369,
    0x036A,0x036B,0x036C,0x036D,0x036E,0x036F,0x0346,0x034D,0x034E,
];
const ZALGO_MID = [
    0x0315,0x031B,0x0340,0x0341,0x0358,0x0321,0x0322,0x0327,0x0328,0x0334,
    0x0335,0x0336,0x034F,0x035C,0x035D,0x035E,0x035F,0x0360,0x0362,0x0338,
    0x0337,0x0361,0x0489,
];
const ZALGO_DOWN = [
    0x0316,0x0317,0x0318,0x0319,0x031C,0x031D,0x031E,0x031F,0x0320,0x0324,
    0x0325,0x0326,0x0329,0x032A,0x032B,0x032C,0x032D,0x032E,0x032F,0x0330,
    0x0331,0x0332,0x0333,0x0339,0x033A,0x033B,0x033C,0x0345,0x0347,0x0348,
    0x0349,0x034D,0x034E,0x0353,0x0354,0x0355,0x0356,0x0359,0x035A,0x0323,
];

function zalgo(text, opts = {}) {
    const intensity = opts.intensity || 'medium'; // low, medium, high, insane
    const up = opts.up !== false;
    const mid = opts.mid !== false;
    const down = opts.down !== false;

    const counts = { low: [1,2], medium: [2,5], high: [5,10], insane: [10,20] };
    const [min, max] = counts[intensity] || counts.medium;

    function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
    function randCount() { return min + Math.floor(Math.random() * (max - min + 1)); }

    return [...text].map(ch => {
        if (/\s/.test(ch)) return ch;
        let result = ch;
        if (up)  for (let i = 0; i < randCount(); i++) result += String.fromCodePoint(rand(ZALGO_UP));
        if (mid) for (let i = 0; i < randCount(); i++) result += String.fromCodePoint(rand(ZALGO_MID));
        if (down) for (let i = 0; i < randCount(); i++) result += String.fromCodePoint(rand(ZALGO_DOWN));
        return result;
    }).join('');
}

// ── ASCII Art (banner-style block letters) ───────────────────
const BLOCK_FONT = {
    A:['  █  ','█   █','█████','█   █','█   █'],B:['████ ','█   █','████ ','█   █','████ '],
    C:[' ████','█    ','█    ','█    ',' ████'],D:['████ ','█   █','█   █','█   █','████ '],
    E:['█████','█    ','████ ','█    ','█████'],F:['█████','█    ','████ ','█    ','█    '],
    G:[' ████','█    ','█  ██','█   █',' ████'],H:['█   █','█   █','█████','█   █','█   █'],
    I:['█████','  █  ','  █  ','  █  ','█████'],J:['█████','    █','    █','█   █',' ███ '],
    K:['█   █','█  █ ','███  ','█  █ ','█   █'],L:['█    ','█    ','█    ','█    ','█████'],
    M:['█   █','██ ██','█ █ █','█   █','█   █'],N:['█   █','██  █','█ █ █','█  ██','█   █'],
    O:[' ███ ','█   █','█   █','█   █',' ███ '],P:['████ ','█   █','████ ','█    ','█    '],
    Q:[' ███ ','█   █','█ █ █','█  █ ',' ██ █'],R:['████ ','█   █','████ ','█  █ ','█   █'],
    S:[' ████','█    ',' ███ ','    █','████ '],T:['█████','  █  ','  █  ','  █  ','  █  '],
    U:['█   █','█   █','█   █','█   █',' ███ '],V:['█   █','█   █','█   █',' █ █ ','  █  '],
    W:['█   █','█   █','█ █ █','██ ██','█   █'],X:['█   █',' █ █ ','  █  ',' █ █ ','█   █'],
    Y:['█   █',' █ █ ','  █  ','  █  ','  █  '],Z:['█████','   █ ','  █  ',' █   ','█████'],
    ' ':['     ','     ','     ','     ','     '],
    '0':[' ███ ','█  ██','█ █ █','██  █',' ███ '],'1':['  █  ',' ██  ','  █  ','  █  ','█████'],
    '2':[' ███ ','█   █','  ██ ',' █   ','█████'],'3':['████ ','    █',' ███ ','    █','████ '],
    '4':['█   █','█   █','█████','    █','    █'],'5':['█████','█    ','████ ','    █','████ '],
    '6':[' ███ ','█    ','████ ','█   █',' ███ '],'7':['█████','    █','   █ ','  █  ','  █  '],
    '8':[' ███ ','█   █',' ███ ','█   █',' ███ '],'9':[' ███ ','█   █',' ████','    █',' ███ '],
    '!':[' █ ',' █ ',' █ ','   ',' █ '],'?':[' ███ ','█   █','  █  ','     ','  █  '],
    '.':[' ','  ','  ','  ',' █'],'-':['     ','     ','█████','     ','     '],
    '_':['     ','     ','     ','     ','█████'],
};

function asciiArt(text, opts = {}) {
    const char = opts.blockChar || '█';
    const space = opts.spaceChar || ' ';
    const upper = text.toUpperCase();
    const lines = ['','','','',''];

    for (const ch of upper) {
        const glyph = BLOCK_FONT[ch];
        if (!glyph) {
            for (let r = 0; r < 5; r++) lines[r] += '     ';
            continue;
        }
        for (let r = 0; r < 5; r++) {
            const row = glyph[r] || '     ';
            lines[r] += row.replace(/█/g, char).replace(/ /g, space) + space;
        }
    }
    return lines.join('\n');
}

// ── Case converters ──────────────────────────────────────────
const caseFns = {
    upper: t => t.toUpperCase(),
    lower: t => t.toLowerCase(),
    title: t => t.replace(/\b\w/g, c => c.toUpperCase()),
    sentence: t => t.replace(/(^\s*\w|[.!?]\s+\w)/g, c => c.toUpperCase()),
    capitalize: t => t.replace(/\b\w+/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase()),
    inverse: t => [...t].map(c => c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()).join(''),
    alternating: t => [...t].map((c, i) => i % 2 === 0 ? c.toLowerCase() : c.toUpperCase()).join(''),
    mocking: t => [...t].map(c => Math.random() > 0.5 ? c.toUpperCase() : c.toLowerCase()).join(''),
    snake: t => t.trim().replace(/[\s_-]+/g, '_').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase(),
    camel: t => t.trim().replace(/[\s_-]+(.)/g, (_, c) => c.toUpperCase()).replace(/^[A-Z]/, c => c.toLowerCase()),
    pascal: t => t.trim().replace(/[\s_-]+(.)/g, (_, c) => c.toUpperCase()).replace(/^[a-z]/, c => c.toUpperCase()),
    kebab: t => t.trim().replace(/[\s_]+/g, '-').replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase(),
    constant: t => t.trim().replace(/[\s-]+/g, '_').replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase(),
    dot: t => t.trim().replace(/[\s_-]+/g, '.').replace(/([a-z])([A-Z])/g, '$1.$2').toLowerCase(),
};

// ── Text cleanup ─────────────────────────────────────────────
const cleanFns = {
    trimLines:       t => t.split('\n').map(l => l.trim()).join('\n'),
    collapseSpaces:  t => t.replace(/[^\S\n]+/g, ' '),
    collapseLines:   t => t.replace(/\n{3,}/g, '\n\n'),
    removeBlankLines:t => t.split('\n').filter(l => l.trim() !== '').join('\n'),
    normalizeQuotes: t => t.replace(/[\u2018\u2019\u201A\u201B]/g, "'").replace(/[\u201C\u201D\u201E\u201F]/g, '"'),
    normalizeHyphens:t => t.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, '-'),
    normalizeEllipsis:t => t.replace(/\.{3,}/g, '\u2026'),
    removeInvisible: t => t.replace(/[\u200B\u200C\u200D\uFEFF\u00AD\u034F\u180E\u2060\u2061\u2062\u2063\u2064]/g, ''),
    removeZalgo:     t => t.replace(/[\u0300-\u036F\u0489\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE00-\uFE0F\uFE20-\uFE2F]/g, ''),
    stripHtml:       t => t.replace(/<[^>]*>/g, ''),
    normalizeAll:    t => {
        let r = t;
        r = cleanFns.removeInvisible(r);
        r = cleanFns.normalizeQuotes(r);
        r = cleanFns.normalizeHyphens(r);
        r = cleanFns.collapseSpaces(r);
        r = cleanFns.trimLines(r);
        r = cleanFns.collapseLines(r);
        return r;
    },
};

// ── Text analysis ────────────────────────────────────────────
function analyze(text) {
    const chars = [...text];
    const words = text.trim().split(/\s+/).filter(Boolean);
    const lines = text.split('\n');
    const sentences = text.split(/[.!?]+/).filter(s => s.trim());
    const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim());
    const avgWordLen = words.length ? words.reduce((s, w) => s + w.length, 0) / words.length : 0;
    const readingTime = Math.max(1, Math.ceil(words.length / 200));
    const speakingTime = Math.max(1, Math.ceil(words.length / 130));

    return {
        characters: chars.length,
        charactersNoSpaces: chars.filter(c => !/\s/.test(c)).length,
        words: words.length,
        lines: lines.length,
        sentences: sentences.length,
        paragraphs: paragraphs.length,
        avgWordLength: Math.round(avgWordLen * 10) / 10,
        readingTimeMinutes: readingTime,
        speakingTimeMinutes: speakingTime,
        bytes: new Blob([text]).size,
    };
}

// ── Morse code ───────────────────────────────────────────────
const MORSE_MAP = {
    A:'.-',B:'-...',C:'-.-.',D:'-..',E:'.',F:'..-.',G:'--.',H:'....',I:'..',
    J:'.---',K:'-.-',L:'.-..',M:'--',N:'-.',O:'---',P:'.--.',Q:'--.-',R:'.-.',
    S:'...',T:'-',U:'..-',V:'...-',W:'.--',X:'-..-',Y:'-.--',Z:'--..',
    '0':'-----','1':'.----','2':'..---','3':'...--','4':'....-',
    '5':'.....','6':'-....','7':'--...','8':'---..','9':'----.',
    '.':'.-.-.-',',':'--..--','?':'..--..','/':'-..-.','-':'-....-',
    '(':'-.--.',')':'-.--.-','!':'-.-.--',
};

function toMorse(text) {
    return text.toUpperCase().split('').map(ch => {
        if (ch === ' ') return '/';
        return MORSE_MAP[ch] || '';
    }).filter(Boolean).join(' ');
}

function fromMorse(morse) {
    const reverseMap = {};
    for (const [ch, code] of Object.entries(MORSE_MAP)) reverseMap[code] = ch;
    return morse.split(' / ').map(word =>
        word.split(' ').map(code => reverseMap[code] || '').join('')
    ).join(' ');
}

// ── Binary ───────────────────────────────────────────────────
function toBinary(text) {
    return [...text].map(ch => ch.codePointAt(0).toString(2).padStart(8, '0')).join(' ');
}

function fromBinary(binary) {
    return binary.trim().split(/\s+/).map(b => String.fromCodePoint(parseInt(b, 2) || 0)).join('');
}

// ── Kaomoji library ──────────────────────────────────────────
const KAOMOJI = {
    happy: ['(◕‿◕)','(＾▽＾)','(✿◠‿◠)','(ﾉ◕ヮ◕)ﾉ*:・ﾟ✧','(◠‿◠)','٩(◕‿◕)۶','(⌒‿⌒)','☆*:.｡.o(≧▽≦)o.｡.:*☆','(✧ω✧)','(≧◡≦)'],
    sad: ['(╥_╥)','(ಥ_ಥ)','(；﹏；)','(T_T)','(ノ_<。)','(πーπ)','(;_;)','(´;ω;`)','(╯︵╰,)','(´°̥̥̥̥̥̥̥̥ω°̥̥̥̥̥̥̥̥`)'],
    angry: ['(ノಠ益ಠ)ノ彡┻━┻','(╬ Ò﹏Ó)','(●`ε´●)','ψ(｀∇´)ψ','(╬▔皿▔)╯','(ノ°益°)ノ','(¬_¬)','(⊙_◎)','凸(▀̿̿Ĺ̯̿̿▀̿ ̿)凸'],
    love: ['(♥ω♥*)','(◕‿◕)♡','(´∀`)♡','♡(ŐωŐ人)','(人*´∀`)','(*˘︶˘*).｡.:*♡','(灬♥ω♥灬)','(ɔˆз(ˆ⌣ˆc)','♡＾▽＾♡'],
    shrug: ['¯\\_(ツ)_/¯','┐(´～`)┌','╮(╯_╰)╭','ᕕ( ᐛ )ᕗ','┐(´д`)┌','乁( ˙ω˙ )ㄏ'],
    surprise: ['(⊙_⊙)','(☉_☉)','(°▽°)','⊙.☉','(⊙ˍ⊙)','(°ロ°)','Σ(°△°|||)','(ﾟдﾟ)','(⊙o⊙)'],
    cool: ['(■_■¬)','( •_•)>⌐■-■','(▀̿Ĺ̯▀̿ ̿)','(⌐■_■)','ᕦ(ò_óˇ)ᕤ','(•̀ᴗ•́)و','(ง •̀_•́)ง'],
    silly: ['(ノ≧ڡ≦)','( ˘ ³˘)♥','(づ｡◕‿‿◕｡)づ','(✿╹◡╹)','꒰⑅ᵕ༚ᵕ꒱˖♡','∠( ᐛ 」∠)_','(⊙﹏⊙)'],
    animals: ['ʕ•ᴥ•ʔ','(=^･ω･^=)','(U・x・U)','(*・ω・)','ᓚᘏᗢ','(=①ω①=)','(⁎˃ᆺ˂)','🐧','ᘛ⁐̤ᕐᐷ'],
    music: ['♪♫♪','♬♩♫','(ノ´ヮ`)ノ♪♬','♪ヽ(^^ヽ)♪','♪～(´ε` )','ヾ(´▽`*)ゝ♪♬'],
    tableFlip: ['(╯°□°)╯︵ ┻━┻','(┛◉Д◉)┛彡┻━┻','(ﾉಥ益ಥ）ﾉ彡┻━┻','┻━┻ ︵ヽ(`Д´)ﾉ︵ ┻━┻'],
    tableUnflip: ['┬─┬ノ( º _ ºノ)','┬──┬◡ﾉ(° -°ﾉ)','┬─┬⃰͡ (ᵔᵕᵔ͜ )'],
    lenny: ['( ͡° ͜ʖ ͡°)','/╲/\\╭( ͡° ͡° ͜ʖ ͡° ͡°)╮/\\╱\\','( ͡~ ͜ʖ ͡°)','( ° ͜ʖ °)','(ᴗ ͜ʖ ᴗ)'],
    fight: ['(ง •̀_•́)ง','(ง\'̀-\'́)ง','ᕦ(ò_óˇ)ᕤ','(⌐■_■)','ᕙ(⇀‸↼‶)ᕗ'],
    sparkle: ['✨','✧','⁺˚*・༓☾','☆','˚✧₊⁎⁺˳✧','˗ˏˋ ★ ˎˊ˗','✶'],
};

// ── Symbols library ──────────────────────────────────────────
const SYMBOLS = {
    arrows: ['→','←','↑','↓','↔','↕','⇒','⇐','⇑','⇓','⇔','⟶','⟵','➜','➤','▶','◀','⬆','⬇','↗','↘','↙','↖','⤴','⤵','↪','↩'],
    stars: ['★','☆','✦','✧','✩','✪','✫','✬','✭','✮','✯','✰','⭐','🌟','💫','⁂','✶','✷','✸','✹','✺'],
    hearts: ['♥','♡','❤','❥','❣','❦','❧','💕','💖','💗','💘','💙','💚','💛','💜','🖤','🤍','🤎','💝','💞'],
    music: ['♩','♪','♫','♬','♭','♮','♯','🎵','🎶','🎼'],
    math: ['±','×','÷','≠','≈','≤','≥','∞','∑','∏','∫','√','∂','∆','∇','∈','∉','⊂','⊃','∩','∪','∅'],
    currency: ['$','¢','£','¥','€','₹','₿','₽','₩','₴','₪','₫','₮','₱','₸','₵'],
    bullets: ['•','◦','▪','▫','▸','▹','►','▻','‣','⁃','⊙','⊚','⊛','⦿','◎','⚬'],
    boxes: ['░','▒','▓','█','▀','▄','▌','▐','■','□','▢','▣','▤','▥','▦','▧','▨','▩'],
    lines: ['─','━','│','┃','┌','┐','└','┘','├','┤','┬','┴','┼','═','║','╔','╗','╚','╝','╠','╣','╦','╩','╬'],
    dividers: ['─────','━━━━━','═════','░░░░░','▬▬▬▬▬','☆═══☆','★━━━★','✿───✿','♦───♦','•─────•'],
    check: ['✓','✔','✗','✘','☐','☑','☒','✅','❌','⭕'],
    zodiac: ['♈','♉','♊','♋','♌','♍','♎','♏','♐','♑','♒','♓'],
    weather: ['☀','☁','☂','☃','❄','⛅','⛈','🌈','🌤','🌥','🌦','🌧','🌨','🌩','⚡','🌪','🌫'],
    gaming: ['♔','♕','♖','♗','♘','♙','♚','♛','♜','♝','♞','♟','🎮','🎯','🎲','🏆','⚔','🛡','🎰','🕹'],
    hands: ['👋','✌','🤞','👍','👎','👊','✊','🤜','🤛','👏','🙌','🤝','✋','🖐','🤙','💪','☝','👆','👇','👉','👈'],
    faces: ['😀','😎','🤔','😍','🥺','😤','💀','🤡','👻','🙃','😐','🫠','🥴'],
};

// ── Bio / nickname generation helpers ────────────────────────
const BIO_ADJECTIVES = ['cosmic','neon','stealth','shadow','phantom','retro','cyber','pixel','turbo','midnight','solar','atomic','hyper','zen','savage','arcane','frosty','blazing','lunar','quantum','stellar','cryptic','wild','urban','void'];
const BIO_NOUNS = ['wolf','hawk','fox','raven','cobra','phoenix','panther','viper','falcon','ghost','knight','ninja','samurai','dragon','titan','drifter','scout','nomad','hunter','rambler','vagabond','wanderer','pilgrim','seeker'];
const BIO_EMOJIS = ['⚡','🔥','💀','🐺','🦅','🎯','⚔️','🛡️','🌙','✨','🎮','🏆','💎','🌟','🔱','🗡️','👑','🎭'];

function generateNickname(opts = {}) {
    const adj = BIO_ADJECTIVES[Math.floor(Math.random() * BIO_ADJECTIVES.length)];
    const noun = BIO_NOUNS[Math.floor(Math.random() * BIO_NOUNS.length)];
    const num = Math.floor(Math.random() * 999);
    const styles = [
        `${adj}_${noun}`,
        `${adj}${noun.charAt(0).toUpperCase() + noun.slice(1)}`,
        `x${adj}${noun}x`,
        `${noun}${num}`,
        `${adj.toUpperCase()}_${noun.toUpperCase()}`,
        `${noun}_the_${adj}`,
        `ii${adj}${noun}ii`,
        `${adj}-${noun}-${num}`,
    ];
    return styles[Math.floor(Math.random() * styles.length)];
}

function generateBio(opts = {}) {
    const emoji1 = BIO_EMOJIS[Math.floor(Math.random() * BIO_EMOJIS.length)];
    const emoji2 = BIO_EMOJIS[Math.floor(Math.random() * BIO_EMOJIS.length)];
    const emoji3 = BIO_EMOJIS[Math.floor(Math.random() * BIO_EMOJIS.length)];
    const adj = BIO_ADJECTIVES[Math.floor(Math.random() * BIO_ADJECTIVES.length)];
    const noun = BIO_NOUNS[Math.floor(Math.random() * BIO_NOUNS.length)];
    const templates = [
        `${emoji1} ${adj} ${noun} ${emoji2}\n┊ streaming when the wifi hits\n┊ part of the openvibe network\n╰─ living the dream ${emoji3}`,
        `━━━━━━━━━━━━━━━\n${emoji1} ${adj.toUpperCase()} ${noun.toUpperCase()} ${emoji2}\n━━━━━━━━━━━━━━━\n• Streamer / Creator\n• Building things that matter\n• ${emoji3} openvibe.tools`,
        `╔═══════════════╗\n║  ${adj} ${noun}  ║\n╚═══════════════╝\n${emoji1} Not your average streamer\n${emoji2} Open source everything\n${emoji3} @openvibelive`,
        `${emoji1} | ${adj} ${noun}\n─────────────────\nLevel 99 digital nomad\nStreaming from stolen wifi ${emoji2}\nopenvibe.tools / openvibe.live ${emoji3}`,
    ];
    return templates[Math.floor(Math.random() * templates.length)];
}

// ── Braille art conversion ───────────────────────────────────
function toBraille(text) {
    const BRAILLE_MAP = {
        a:'\u2801',b:'\u2803',c:'\u2809',d:'\u2819',e:'\u2811',f:'\u280B',g:'\u281B',
        h:'\u2813',i:'\u280A',j:'\u281A',k:'\u2805',l:'\u2807',m:'\u280D',n:'\u281D',
        o:'\u2815',p:'\u280F',q:'\u281F',r:'\u2817',s:'\u280E',t:'\u281E',u:'\u2825',
        v:'\u2827',w:'\u283A',x:'\u282D',y:'\u283D',z:'\u2835',' ':'\u2800',
    };
    return [...text.toLowerCase()].map(c => BRAILLE_MAP[c] || c).join('');
}

// ── Slug generation ──────────────────────────────────────────
function toSlug(text) {
    return text.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\w\s-]/g, '').replace(/[\s_]+/g, '-').replace(/^-+|-+$/g, '');
}

// ── Sort / dedupe lines ──────────────────────────────────────
function sortLines(text, opts = {}) {
    const lines = text.split('\n');
    const sorted = opts.reverse ? lines.sort().reverse() : lines.sort();
    return sorted.join('\n');
}

function dedupeLines(text) {
    return [...new Set(text.split('\n'))].join('\n');
}

// ── Escape / unescape ───────────────────────────────────────
function escapeHtml(text) {
    return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function unescapeHtml(text) {
    return text.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
}

// ── Public API ───────────────────────────────────────────────
const TextOpenVibeEngine = {
    // Fancy text
    styles: ALL_STYLES,
    transform: (text, styleName) => ALL_STYLES[styleName]?.fn(text) || text,
    transformAll: (text) => {
        const results = {};
        for (const [key, style] of Object.entries(ALL_STYLES)) {
            results[key] = { name: style.name, text: style.fn(text) };
        }
        return results;
    },

    // Zalgo
    zalgo,

    // ASCII art
    asciiArt,

    // Case converters
    case: caseFns,

    // Cleanup
    clean: cleanFns,

    // Analysis
    analyze,

    // Morse
    toMorse, fromMorse,

    // Binary
    toBinary, fromBinary,

    // Braille
    toBraille,

    // Slug
    toSlug,

    // Sort / dedupe
    sortLines, dedupeLines,

    // Escape
    escapeHtml, unescapeHtml,

    // Kaomoji
    kaomoji: KAOMOJI,

    // Symbols
    symbols: SYMBOLS,

    // Bio / nickname
    generateNickname,
    generateBio,
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = TextOpenVibeEngine;
} else {
    root.TextOpenVibeEngine = TextOpenVibeEngine;
}

})(typeof window !== 'undefined' ? window : this);
