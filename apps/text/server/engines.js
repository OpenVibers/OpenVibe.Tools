'use strict';
// ═══════════════════════════════════════════════════════════════
// Text.OpenVibe — server engines for the tools API (ADR-027).
//
// The text pages run everything in the browser, and they keep doing so. These are the same engines,
// public/js/text-engine.js and public/js/format-engine.js, required in Node, so a text tool whose
// descriptor says api: true can be run by POST /api/v1/tools/:id/run (served by the gateway). Each
// engine takes the run's input (already checked against the tool's input schema) and answers
// { text } (output kind text) or { data } (output kind json). Nothing here touches the network or disk.
// ═══════════════════════════════════════════════════════════════

const T = require('../public/js/text-engine');
const F = require('../public/js/format-engine');

// The style sets each page shows (fancy.html: all of them; bubble.html; reverse.html).
const STYLE_SETS = {
    fancy: Object.keys(T.styles),
    bubble: ['circled', 'squared', 'negSquared', 'parenthesized', 'regional'],
    reversetext: ['upsideDown', 'mirrored', 'strikethrough', 'underline', 'doubleUnderline', 'overline', 'slashed', 'dotted', 'spaced'],
};
// compare: the diff table is lines(a) × lines(b); beyond this many lines a side it is refused.
const MAX_DIFF_LINES = 2000;

const styled = (set) => ({ text, styles }) => {
    const ids = styles && styles.length ? STYLE_SETS[set].filter(id => styles.includes(id)) : STYLE_SETS[set];
    return { data: { styles: ids.map(id => ({ id, name: T.styles[id].name, text: T.styles[id].fn(text) })) } };
};

class EngineError extends Error {
    constructor(message) { super(message); this.status = 422; this.code = 'tools.input.invalid'; }
}

const ENGINES = {
    fancy: styled('fancy'),
    bubble: styled('bubble'),
    reversetext: styled('reversetext'),
    zalgo: ({ text, mode = 'add', intensity = 'medium', up, mid, down }) => ({ text: mode === 'remove' ? T.clean.removeZalgo(text) : T.zalgo(text, { intensity, up, mid, down }) }),
    ascii: ({ text, blockChar = '█', spaceChar = ' ' }) => ({ text: T.asciiArt(text, { blockChar, spaceChar }) }),
    unicode: ({ text }) => ({ data: { characters: T.inspectChars(text) } }),
    braille: ({ text, mode = 'encode' }) => ({ text: mode === 'decode' ? T.fromBraille(text) : T.toBraille(text) }),
    morse: ({ text, mode = 'encode' }) => ({ text: mode === 'decode' ? T.fromMorse(text) : T.toMorse(text) }),
    binary: ({ text, to = 'binary' }) => ({ text: { binary: T.toBinary, hex: T.toHex, decimal: T.toDecimal, octal: T.toOctal, text: T.fromBinary }[to](text) }),
    case: ({ text, to }) => ({ text: T.case[to](text) }),
    count: ({ text }) => ({ data: T.analyze(text) }),
    clean: ({ text, ...steps }) => ({ text: T.cleanText(text, steps) }),
    sort: ({ text, mode = 'asc' }) => ({
        text: mode === 'desc' ? T.sortLines(text, { reverse: true }) : mode === 'shuffle' ? T.shuffleLines(text) : mode === 'dedupe' ? T.dedupeLines(text) : mode === 'reverse' ? T.reverseLines(text) : T.sortLines(text),
    }),
    compare: ({ a, b }) => {
        const n = Math.max(a.split('\n').length, b.split('\n').length);
        if (n > MAX_DIFF_LINES) throw new EngineError(`Each text may have at most ${MAX_DIFF_LINES} lines (this one has ${n}).`);
        const lines = F.diffLines(a, b);
        const count = (t) => lines.filter(l => l.type === t).length;
        return { data: { lines, added: count('add'), removed: count('del'), unchanged: count('same') } };
    },
    json: ({ text, mode = 'format', indent = 2 }) => {
        let value;
        try { value = JSON.parse(text.trim()); } catch (err) { throw new EngineError(err.message); }
        if (mode === 'minify') return { text: JSON.stringify(value) };
        return { text: JSON.stringify(mode === 'sort-keys' ? F.sortKeysDeep(value) : value, null, indent) };
    },
    markdown: ({ text }) => ({ text: F.markdownToHtml(text) }),
    escape: ({ text, transform }) => ({ text: T.escapes[transform].fn(text) }),
    slug: ({ text }) => ({ text: T.toSlug(text) }),
    bio: () => ({ text: T.generateBio() }),
    nickname: () => ({ text: T.generateNickname() }),
    symbols: ({ category } = {}) => ({ data: { categories: category ? { [category]: T.symbols[category] } : T.symbols } }),
    kaomoji: ({ mood } = {}) => ({ data: { moods: mood ? { [mood]: T.kaomoji[mood] } : T.kaomoji } }),
};

module.exports = { ENGINES, STYLE_SETS, MAX_DIFF_LINES, EngineError, styleNames: () => Object.fromEntries(Object.entries(T.styles).map(([k, v]) => [k, v.name])), CASES: Object.keys(T.case), ESCAPES: Object.keys(T.escapes), SYMBOL_CATEGORIES: Object.keys(T.symbols), MOODS: Object.keys(T.kaomoji) };
