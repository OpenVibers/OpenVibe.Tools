'use strict';
// ═══════════════════════════════════════════════════════════════
// Dev.OpenVibe — server engines for the tools API (ADR-027).
//
// The developer tools run in the browser, and their pages keep doing so. These are the same
// transforms, public/js/dev-engine.js, required in Node, so a dev tool whose descriptor says
// api: true can be run by POST /api/v1/tools/:id/run. Each engine takes the run's input (already
// checked against the tool's input schema; the API's lower-case modes are the page's buttons) and
// answers { text } (output kind text) or { data } (output kind json). An input the transform cannot
// read (JSON that does not parse, a malformed JWT) throws, and the run fails with that message.
// ═══════════════════════════════════════════════════════════════

const D = require('../../public/js/dev-engine');

const label = (map, value, dflt) => map[value] || map[dflt];

const ENGINES = {
    yaml: ({ text, to = 'json' }) => ({ text: D.yaml(text, to === 'yaml' ? 'JSON→YAML' : 'YAML→JSON') }),
    xml: ({ text, mode = 'format' }) => ({ text: D.xml(text, mode === 'minify' ? 'Minify' : 'Format') }),
    csv: ({ text }) => ({ data: { rows: D.csvObjects(text) } }),
    sql: ({ text, mode = 'format' }) => ({ text: D.sql(text, label({ format: 'Format', uppercase: 'Uppercase', compact: 'Compact' }, mode, 'format')) }),
    html: ({ text, mode = 'format' }) => ({ text: D.html(text, label({ format: 'Format', minify: 'Minify', entities: 'Entities' }, mode, 'format')) }),
    base64: ({ text, mode = 'encode' }) => ({ text: D.base64(text, mode === 'decode' ? 'Decode' : 'Encode') }),
    url: ({ text, mode = 'encode' }) => ({ text: D.url(text, label({ encode: 'Encode', decode: 'Decode', parse: 'Parse' }, mode, 'encode')) }),
    jwt: ({ token }) => {
        const j = D.jwt(token);
        return { data: { header: j.header, payload: j.payload, signature: j.signature, expires_at: j.exp ? j.exp.at : null, expired: j.exp ? j.exp.msLeft <= 0 : null } };
    },
    uuid: ({ mode = 'generate', count = 1, text = '' }) => (mode === 'validate' ? { data: { valid: D.isUuid(text) } } : { data: { uuids: D.uuids(count).split('\n') } }),
    hash: async ({ text, algorithm = 'SHA-256' }) => ({ data: { algorithm, hex: await D.hash(text, algorithm) } }),
    hex: ({ text, mode = 'to-hex' }) => ({ text: D.hex(text, mode === 'from-hex' ? 'From Hex' : 'To Hex') }),
    timestamp: ({ mode = 'now', text = '' }) => ({ text: D.timestamp(text, label({ now: 'Now', 'to-date': 'To Date', 'to-unix': 'To Unix' }, mode, 'now')) }),
    cron: ({ expression }) => ({ text: D.cron(expression) }),
    beautify: ({ text, language = 'html' }) => ({ text: D.beautify(text, language.toUpperCase()) }),
    minify: ({ text, language }) => ({ text: D.minify(text, language.toUpperCase()) }),
    lorem: ({ unit = 'paragraphs', count }) => ({ text: D.lorem(unit, count) }),
    curlconvert: ({ command, to = 'fetch' }) => ({ text: D.curlconvert(command, label({ fetch: 'To fetch', python: 'To Python', node: 'To Node', parsed: 'Parsed' }, to, 'fetch')) }),
    color: ({ color }) => ({ data: D.color(color) }),
    cssminify: ({ text }) => ({ text: D.cssMinify(text) }),
    cssformat: ({ text }) => ({ text: D.cssFormat(text) }),
    htmlminify: ({ text }) => ({ text: D.htmlMinify(text) }),
    jsonminify: ({ text }) => ({ text: D.jsonMinify(text) }),
    // A validator's "no" is its answer, not a failure: invalid JSON is { valid: false, error }.
    jsonvalidate: ({ text }) => {
        try { return { data: { valid: true, ...D.jsonStats(text) } }; } catch (err) { return { data: { valid: false, error: err.message } }; }
    },
    jsonparse: ({ text, view = 'paths' }) => ({ text: D.jsonParse(text, label({ tree: 'Tree', paths: 'Paths', types: 'Types' }, view, 'paths')) }),
    jsonstringify: ({ text, mode = 'stringify' }) => ({ text: D.jsonStringify(text, mode === 'parse' ? 'Parse string' : 'Stringify') }),
    md2html: ({ text }) => ({ text: D.md2html(text) }),
};

module.exports = { ENGINES };
