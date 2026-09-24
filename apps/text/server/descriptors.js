'use strict';
// ═══════════════════════════════════════════════════════════════
// Text.OpenVibe + Logo.OpenVibe — what each text tool is, for the tool registry (tools.tool@1 specs,
// ADR-027; apps/_shared/tools/descriptor.js joins them with the catalogue's name, summary and hosts).
//
// Every page here works in the browser (execution client, nothing leaves it). A tool whose engine is
// a pure transform (public/js/text-engine.js, format-engine.js) also has a server engine for the API
// (server/engines.js, named by `engine`): api true, answered inline. The graphics makers draw on a
// canvas, and the phrasebooks, the slang dictionary, the ICE card and the peso converter (which asks
// an exchange-rate service from the browser) have no engine to run elsewhere: api false.
// The enums below come from the engines themselves, so a new style or case shows up here too.
// ═══════════════════════════════════════════════════════════════

const { STYLE_SETS, MAX_DIFF_LINES, CASES, ESCAPES, SYMBOL_CATEGORIES, MOODS } = require('./engines');

const KiB = 1024;
const obj = (properties, required = ['text']) => ({ type: 'object', additionalProperties: false, required, properties });
const text = (maxLength, description) => ({ type: 'string', maxLength, ...(description && { description }) });
const STYLES_OUT = {
    type: 'object', required: ['styles'],
    properties: { styles: { type: 'array', items: { type: 'object', required: ['id', 'name', 'text'], properties: { id: { type: 'string' }, name: { type: 'string' }, text: { type: 'string' } } } } },
};

/** A browser tool with a server engine: api true, answered inline. */
function engine(id, { input, output, maxChars = 100000, example, cost = 1 }) {
    return {
        id, execution: 'client', api: true,
        input, files: null, output,
        limits: { timeoutMs: 5000, maxInputBytes: Math.min(1024 * KiB, Math.ceil(maxChars * 4 + KiB)) },   // the gateway takes JSON bodies up to 1 MiB
        auth: { anonymous: true, capability: 'tools.tool.run' },
        quotaClass: 'tools-run', cost, egress: false,
        engine: id, example: { input: example },
    };
}

/** A browser-only tool: api false. */
function page(id, output) {
    return {
        id, execution: 'client', api: false,
        input: null, files: null, output,
        limits: { timeoutMs: 5000 },
        auth: { anonymous: true, capability: 'tools.tool.run' },
        quotaClass: 'tools-run', cost: 1, egress: false,
    };
}

const styled = (id, maxChars, example) => engine(id, {
    input: obj({ text: text(maxChars), styles: { type: 'array', uniqueItems: true, items: { enum: STYLE_SETS[id] }, description: 'Only these styles (default: all of them)' } }),
    output: { kind: 'json', schema: STYLES_OUT }, maxChars, example: { text: example },
});
const IMAGE = { kind: 'file', mime: ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'] };
const HTML_TEXT = { kind: 'text' };

const SPECS = [
    styled('fancy', 2000, 'OpenVibe'),
    engine('zalgo', {
        input: obj({
            text: text(2000), mode: { enum: ['add', 'remove'], default: 'add', description: 'remove strips the marks again' },
            intensity: { enum: ['low', 'medium', 'high', 'insane'], default: 'medium' },
            up: { type: 'boolean', default: true }, mid: { type: 'boolean', default: true }, down: { type: 'boolean', default: true },
        }),
        output: { kind: 'text' }, maxChars: 2000, example: { text: 'hello' },
    }),
    styled('bubble', 5000, 'bubble'),
    engine('ascii', { input: obj({ text: text(40), blockChar: { type: 'string', minLength: 1, maxLength: 2, default: '█' }, spaceChar: { type: 'string', minLength: 1, maxLength: 2, default: ' ' } }), output: { kind: 'text' }, maxChars: 40, example: { text: 'HI' } }),
    engine('symbols', {
        input: obj({ category: { enum: SYMBOL_CATEGORIES, description: 'One category (default: every one)' } }, []),
        output: { kind: 'json', schema: { type: 'object', required: ['categories'], properties: { categories: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } } } } },
        maxChars: 0, example: { category: 'arrows' },
    }),
    engine('kaomoji', {
        input: obj({ mood: { enum: MOODS, description: 'One mood (default: every one)' } }, []),
        output: { kind: 'json', schema: { type: 'object', required: ['moods'], properties: { moods: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } } } } },
        maxChars: 0, example: { mood: 'shrug' },
    }),
    engine('unicode', {
        input: obj({ text: text(10000) }),
        output: {
            kind: 'json', schema: {
                type: 'object', required: ['characters'],
                properties: { characters: { type: 'array', items: { type: 'object', properties: { char: { type: 'string' }, codePoint: { type: 'string' }, hex: { type: 'string' }, utf8Bytes: { type: 'integer' }, category: { type: 'string' }, invisible: { type: 'boolean' } } } } },
            },
        },
        maxChars: 10000, example: { text: 'A\u200b' },
    }),
    engine('braille', { input: obj({ text: text(100000), mode: { enum: ['encode', 'decode'], default: 'encode' } }), output: { kind: 'text' }, example: { text: 'hello 42' } }),
    engine('morse', { input: obj({ text: text(100000), mode: { enum: ['encode', 'decode'], default: 'encode' } }), output: { kind: 'text' }, example: { text: 'SOS' } }),
    engine('binary', { input: obj({ text: text(100000), to: { enum: ['binary', 'hex', 'decimal', 'octal', 'text'], default: 'binary', description: 'text: read binary back into text' } }), output: { kind: 'text' }, example: { text: 'Hi' } }),
    engine('case', { input: obj({ text: text(100000), to: { enum: CASES } }, ['text', 'to']), output: { kind: 'text' }, example: { text: 'hello world', to: 'title' } }),
    engine('count', {
        input: obj({ text: text(1000000) }), maxChars: 1000000,
        output: { kind: 'json', schema: { type: 'object', properties: Object.fromEntries(['characters', 'charactersNoSpaces', 'words', 'lines', 'sentences', 'paragraphs', 'readingTimeMinutes', 'speakingTimeMinutes', 'bytes'].map(k => [k, { type: 'integer' }]).concat([['avgWordLength', { type: 'number' }]])) } },
        example: { text: 'One two. Three.' },
    }),
    styled('reversetext', 5000, 'hello'),
    engine('clean', {
        input: obj({
            text: text(1000000),
            invisible: { type: 'boolean', default: true, description: 'Remove zero-width and invisible characters' }, zalgo: { type: 'boolean', default: false, description: 'Remove stacked combining marks' },
            quotes: { type: 'boolean', default: true, description: 'Straighten curly quotes' }, hyphens: { type: 'boolean', default: true, description: 'Dashes to plain hyphens' },
            html: { type: 'boolean', default: false, description: 'Strip HTML tags' }, spaces: { type: 'boolean', default: true, description: 'Collapse runs of spaces' },
            trim: { type: 'boolean', default: true, description: 'Trim every line' }, blank: { type: 'boolean', default: false, description: 'Remove blank lines' },
            lines: { type: 'boolean', default: true, description: 'Collapse three or more line breaks to two' },
        }),
        output: { kind: 'text' }, maxChars: 1000000, example: { text: 'a\u200b  “b”' },
    }),
    engine('sort', { input: obj({ text: text(1000000), mode: { enum: ['asc', 'desc', 'shuffle', 'dedupe', 'reverse'], default: 'asc' } }), output: { kind: 'text' }, maxChars: 1000000, example: { text: 'b\na\nb', mode: 'dedupe' } }),
    engine('compare', {
        input: obj({ a: text(262144, `First text (at most ${MAX_DIFF_LINES} lines)`), b: text(262144, `Second text (at most ${MAX_DIFF_LINES} lines)`) }, ['a', 'b']),
        output: {
            kind: 'json', schema: {
                type: 'object', required: ['lines', 'added', 'removed', 'unchanged'],
                properties: { lines: { type: 'array', items: { type: 'object', properties: { type: { enum: ['same', 'add', 'del'] }, text: { type: 'string' } } } }, added: { type: 'integer' }, removed: { type: 'integer' }, unchanged: { type: 'integer' } },
            },
        },
        maxChars: 524288, cost: 2, example: { a: 'one\ntwo', b: 'one\n2' },
    }),
    engine('json', { input: obj({ text: text(1000000), mode: { enum: ['format', 'minify', 'sort-keys'], default: 'format' }, indent: { type: 'integer', minimum: 0, maximum: 8, default: 2 } }), output: { kind: 'text' }, maxChars: 1000000, example: { text: '{"b":1,"a":2}', mode: 'sort-keys' } }),
    engine('markdown', { input: obj({ text: text(262144) }), output: HTML_TEXT, maxChars: 262144, example: { text: '# Hi\n\n**bold**' } }),
    engine('escape', { input: obj({ text: text(262144), transform: { enum: ESCAPES } }, ['text', 'transform']), output: { kind: 'text' }, maxChars: 262144, example: { text: '<b>', transform: 'htmlEscape' } }),
    engine('slug', { input: obj({ text: text(2000) }), output: { kind: 'text' }, maxChars: 2000, example: { text: 'Hello, World!' } }),
    engine('bio', { input: obj({}, []), output: { kind: 'text' }, maxChars: 0, example: {} }),
    engine('nickname', { input: obj({}, []), output: { kind: 'text' }, maxChars: 0, example: {} }),
    // Canvas graphics: made and exported in the browser.
    page('logo', IMAGE), page('wordmark', IMAGE), page('title', IMAGE), page('thumbnail', IMAGE),
    page('badge', IMAGE), page('watermark', IMAGE), page('transparent', IMAGE),
    // Reference pages and a converter that asks an exchange-rate service from the browser.
    page('peso', { kind: 'text' }), page('spanish', { kind: 'text' }), page('slang', { kind: 'text' }), page('ice', { kind: 'text' }),
];

// The run API reuses an engine's answer for 10 minutes (same tool, same input): not for these, whose
// output is random (zalgo, the mocking case, shuffle, the bio and nickname generators).
const FRESH = new Set(['zalgo', 'case', 'sort', 'bio', 'nickname']);
for (const spec of SPECS) if (FRESH.has(spec.id)) spec.cacheTtlMs = 0;

module.exports = { SPECS };
