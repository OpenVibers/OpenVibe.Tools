'use strict';
// ═══════════════════════════════════════════════════════════════
// Dev.OpenVibe — what each developer tool is, for the tool registry (tools.tool@1 specs, ADR-027;
// apps/_shared/tools/descriptor.js joins them with the catalogue's name, summary and hosts).
//
// The pages (public/dev.html) run the tools in the browser. A pure transform also has a server engine
// for the API (server/dev/engines.js over public/js/dev-engine.js, named by `engine`): api true,
// answered inline, the page unchanged. api false where the engine needs the browser: the XML
// minifier and HTML to Markdown (DOMParser), the JavaScript minifier and beautifier (terser, loaded
// from a CDN by the page), and the regex tester (a caller's pattern would run unbounded on the server;
// it can come back once runs are isolated). Open Graph fetches a URL from the server (sync, egress);
// the webhook tester keeps request bins on the server, which a single run cannot express (api false).
// ═══════════════════════════════════════════════════════════════

const KiB = 1024;
const MAX = 1024 * KiB;                       // the gateway's JSON body limit
const obj = (properties, required = ['text']) => ({ type: 'object', additionalProperties: false, required, properties });
const text = (description) => ({ type: 'string', maxLength: MAX, ...(description && { description }) });
const mode = (values, dflt, description) => ({ enum: values, default: dflt, ...(description && { description }) });
const TEXT = { kind: 'text' };
const ANYONE = { anonymous: true, capability: 'tools.tool.run' };

/** A browser tool with a server engine: api true, answered inline. */
function engine(id, input, output, example, extra = {}) {
    return {
        id, execution: 'client', api: true, input, files: null, output,
        limits: { timeoutMs: 5000, maxInputBytes: MAX },
        auth: ANYONE, quotaClass: 'tools-run', cost: 1, egress: false,
        engine: id, example: { input: example },
        ...extra,
    };
}

/** A browser-only tool: api false. */
function page(id, output = TEXT) {
    return { id, execution: 'client', api: false, input: null, files: null, output, limits: { timeoutMs: 10000 }, auth: ANYONE, quotaClass: 'tools-run', cost: 1, egress: false };
}

const SPECS = [
    engine('yaml', obj({ text: text(), to: mode(['json', 'yaml'], 'json', 'json: YAML → JSON; yaml: JSON → YAML') }), TEXT, { text: 'name: openvibe\nactive: true' }),
    engine('xml', obj({ text: text(), mode: mode(['format', 'minify'], 'format') }), TEXT, { text: '<a><b>1</b></a>' }),
    engine('csv', obj({ text: text('CSV with a header row') }),
        { kind: 'json', schema: { type: 'object', required: ['rows'], properties: { rows: { type: 'array', items: { type: 'object', additionalProperties: { type: 'string' } }, description: 'One object per row, keyed by the header' } } } },
        { text: 'name,age\nAda,36' }),
    engine('sql', obj({ text: text(), mode: mode(['format', 'uppercase', 'compact'], 'format') }), TEXT, { text: 'select * from t where a = 1' }),
    engine('html', obj({ text: text(), mode: mode(['format', 'minify', 'entities'], 'format', 'entities: encode characters as numeric HTML entities') }), TEXT, { text: '<div><p>Hi</p></div>' }),
    engine('base64', obj({ text: text(), mode: mode(['encode', 'decode'], 'encode') }), TEXT, { text: 'Hello, World!' }),
    engine('url', obj({ text: text(), mode: mode(['encode', 'decode', 'parse'], 'encode', 'parse: break a URL into its parts') }), TEXT, { text: 'a b&c', mode: 'encode' }),
    engine('jwt', obj({ token: { type: 'string', maxLength: 64 * KiB, pattern: '^[A-Za-z0-9_=-]+\\.[A-Za-z0-9_=-]+\\.[A-Za-z0-9_=-]*$' } }, ['token']),
        { kind: 'json', schema: { type: 'object', required: ['header', 'payload', 'signature'], description: 'Decoded, never verified', properties: { header: { type: 'object' }, payload: { type: 'object' }, signature: { type: 'string' }, expires_at: { type: ['string', 'null'], format: 'date-time' }, expired: { type: ['boolean', 'null'] } } } },
        { token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig' }),
    engine('uuid', obj({ mode: mode(['generate', 'validate'], 'generate'), count: { type: 'integer', minimum: 1, maximum: 100, default: 1 }, text: { type: 'string', maxLength: 100, description: 'validate: the UUID to check' } }, []),
        { kind: 'json', schema: { type: 'object', properties: { uuids: { type: 'array', items: { type: 'string', format: 'uuid' } }, valid: { type: 'boolean', description: 'validate: is it a v4 UUID' } } } },
        { count: 2 }),
    engine('hash', obj({ text: text(), algorithm: mode(['SHA-256', 'SHA-1', 'SHA-512'], 'SHA-256') }),
        { kind: 'json', schema: { type: 'object', required: ['algorithm', 'hex'], properties: { algorithm: { type: 'string' }, hex: { type: 'string', pattern: '^[0-9a-f]+$' } } } },
        { text: 'Hello, World!' }),
    engine('hex', obj({ text: text(), mode: mode(['to-hex', 'from-hex'], 'to-hex') }), TEXT, { text: 'Hello' }),
    engine('timestamp', obj({ mode: mode(['now', 'to-date', 'to-unix'], 'now', 'to-date: a Unix time (s or ms) → dates; to-unix: a date → Unix time'), text: { type: 'string', maxLength: 100 } }, []), TEXT, { mode: 'to-date', text: '1700000000' }),
    engine('cron', obj({ expression: { type: 'string', maxLength: 200, description: 'minute hour day month weekday' } }, ['expression']), TEXT, { expression: '*/15 9-17 * * 1-5' }),
    engine('beautify', obj({ text: text(), language: mode(['html', 'css', 'json'], 'html') }), TEXT, { text: '{"a":1}', language: 'json' }),
    engine('minify', obj({ text: text(), language: { enum: ['json', 'html', 'css'] } }, ['text', 'language']), TEXT, { text: 'a { color: red; }', language: 'css' }),
    page('regex'),
    engine('lorem', obj({ unit: mode(['paragraphs', 'sentences', 'words'], 'paragraphs'), count: { type: 'integer', minimum: 1, maximum: 100, description: 'Default: 3 paragraphs, 10 sentences or 50 words' } }, []), TEXT, { unit: 'words', count: 5 }),
    engine('curlconvert', obj({ command: { type: 'string', maxLength: 64 * KiB }, to: mode(['fetch', 'python', 'node', 'parsed'], 'fetch') }, ['command']), TEXT, { command: 'curl -X POST https://api.example.com -d x=1' }),
    {
        id: 'webhook', execution: 'sync', api: false, input: null, files: null,
        output: { kind: 'json', schema: { type: 'object', description: 'A request bin: its id and the requests it caught (in memory, 1 hour)', properties: { binId: { type: 'string' }, requests: { type: 'array' } } } },
        limits: { timeoutMs: 5000 }, auth: ANYONE, quotaClass: 'tools-run', cost: 1, egress: false,
        route: { method: 'POST', path: '/api/dev/webhook/bins' },
    },
    engine('color', obj({ color: { type: 'string', maxLength: 64, description: '#rrggbb or rgb(r, g, b)' } }, ['color']),
        { kind: 'json', schema: { type: 'object', required: ['hex', 'rgb', 'hsl', 'complement'], properties: { hex: { type: 'string' }, r: { type: 'integer' }, g: { type: 'integer' }, b: { type: 'integer' }, rgb: { type: 'string' }, hsl: { type: 'string' }, complement: { type: 'string' } } } },
        { color: '#a78bfa' }),
    {
        id: 'opengraph', execution: 'sync', api: true,
        input: obj({ url: { type: 'string', minLength: 1, maxLength: 2048, description: 'A page URL (https:// is assumed when missing)' } }, ['url']),
        files: null,
        output: {
            kind: 'json', schema: {
                type: 'object', required: ['url', 'tags', 'preview'],
                properties: { url: { type: 'string' }, status: { type: 'integer' }, tags: { type: 'object', additionalProperties: { type: 'string' } }, preview: { type: 'object' }, recommendations: { type: 'array' } },
            },
        },
        limits: { timeoutMs: 12000, maxInputBytes: 4 * KiB, perTargetPerMinute: 10 },
        auth: ANYONE, quotaClass: 'tools-fetch', cost: 2, egress: true,
        legacy: ['GET /api/dev/opengraph'],
        route: { method: 'GET', path: '/api/dev/opengraph', query: { url: '{url}' } },
        example: { input: { url: 'https://openvibe.tools' } },
    },
    page('jsminify'), page('jsformat'),
    engine('cssminify', obj({ text: text() }), TEXT, { text: '.a { color: #aabbcc; margin: 0px; }' }),
    engine('cssformat', obj({ text: text() }), TEXT, { text: '.a{color:red}' }),
    engine('htmlminify', obj({ text: text() }), TEXT, { text: '<!-- c -->\n<div>\n  <p>Hi</p>\n</div>' }),
    page('xmlminify'),
    engine('jsonminify', obj({ text: text() }), TEXT, { text: '{\n  "a": 1\n}' }),
    engine('jsonparse', obj({ text: text(), view: mode(['tree', 'paths', 'types'], 'paths') }), TEXT, { text: '{"a":{"b":[1]}}' }),
    engine('jsonvalidate', obj({ text: text() }),
        { kind: 'json', schema: { type: 'object', required: ['valid'], properties: { valid: { type: 'boolean' }, error: { type: 'string', description: 'Where and why it does not parse' }, kind: { enum: ['object', 'array', 'string', 'number', 'boolean', 'null'] }, size: { type: ['integer', 'null'] }, values: { type: 'integer' }, depth: { type: 'integer' } } } },
        { text: '{"a":1,}' }),
    engine('jsonstringify', obj({ text: text(), mode: mode(['stringify', 'parse'], 'stringify', 'parse: turn an escaped string literal back into JSON') }), TEXT, { text: '{"a":"b"}' }),
    page('html2md'),
    engine('md2html', obj({ text: text() }), TEXT, { text: '# Hi\n\n- one' }),
];

module.exports = { SPECS };
