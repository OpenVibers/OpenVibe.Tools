'use strict';
// ═══════════════════════════════════════════════════════════════
// Barcode & QR tools — what each tool is, for the tool registry (tools.tool@1 specs, ADR-027;
// apps/_shared/tools/descriptor.js joins them with the catalogue's name, summary and hosts).
//
// The page (public/codes.html) draws and reads every code in the browser. The generators and the GS1
// checker also have a server engine (server/codes/engines.js, the same bwip-js and smart.js) for the API:
// api true, answered inline with an SVG. api false for the scanner (it reads a camera or a picture, which a
// JSON run cannot carry) and the bulk generator (its answer is a ZIP or a print sheet).
// ═══════════════════════════════════════════════════════════════

const KiB = 1024;
const ANYONE = { anonymous: true, capability: 'tools.tool.run' };
const obj = (properties, required = ['text']) => ({ type: 'object', additionalProperties: false, required, properties });
const text = (max, description) => ({ type: 'string', minLength: 1, maxLength: max, ...(description && { description }) });
const COLOR = { type: 'string', pattern: '^#?[0-9a-fA-F]{6}$' };
// The look every code takes: colours, quiet zone.
const LOOK = { color: { ...COLOR, default: '#000000', description: 'Bars or modules' }, background: { ...COLOR, default: '#ffffff' }, quiet: { type: 'integer', minimum: 0, maximum: 40, description: 'Quiet zone, in modules (default 4 for 2D codes, 10 for barcodes)' } };
// …and a 1D barcode's.
const BARS = { ...LOOK, height_mm: { type: 'number', minimum: 2, maximum: 100, description: 'Bar height in millimetres' }, include_text: { type: 'boolean', default: true, description: 'Print the human-readable text' }, rotate: { enum: ['N', 'R', 'I', 'L'], default: 'N', description: 'N normal, R right, I inverted, L left' } };
const ECC = { enum: ['L', 'M', 'Q', 'H'], default: 'M', description: 'Error correction: L 7%, M 15%, Q 25%, H 30% of the code can be lost' };

const SVG_OUT = {
    kind: 'json', schema: {
        type: 'object', required: ['svg', 'symbology', 'text'],
        properties: {
            svg: { type: 'string', description: 'The code as an SVG document (viewBox in bwip-js units: 4 per module)' },
            symbology: { type: 'string', description: 'bwip-js id of the symbology drawn' },
            text: { type: 'string', description: 'What was encoded' },
            width: { type: ['number', 'null'] }, height: { type: ['number', 'null'] },
            payload: { type: 'string', description: 'QR tools: the text the code carries (a WIFI: string, a vCard)' },
            recommended: { type: 'object', description: 'barcode without a symbology: why this one, warnings, and a corrected number', properties: { why: { type: 'string' }, warnings: { type: 'array', items: { type: 'string' } }, fixed: { type: 'string' } } },
            isbn13: { type: 'string' }, isbn10: { type: ['string', 'null'] },
        },
    },
};

/** A generator with a server engine: api true, answered inline. */
function engine(id, input, example, output = SVG_OUT) {
    return {
        id, execution: 'client', api: true, input, files: null, output,
        limits: { timeoutMs: 5000, maxInputBytes: 16 * KiB },
        auth: ANYONE, quotaClass: 'tools-run', cost: 1, egress: false,
        engine: id, example: { input: example },
    };
}

/** A browser-only tool: api false. */
function page(id, output) {
    return { id, execution: 'client', api: false, input: null, files: null, output, limits: { timeoutMs: 10000 }, auth: ANYONE, quotaClass: 'tools-run', cost: 1, egress: false };
}

const SPECS = [
    engine('barcode', obj({ text: text(3000), symbology: { type: 'string', pattern: '^[a-z0-9-]{2,40}$', description: 'A bwip-js symbology id (ean13, code128, qrcode, pdf417…); left out, the one that fits the text is chosen' }, ...BARS,
        eclevel: { type: ['string', 'integer'], maxLength: 2, description: 'Error correction, as the symbology names it (QR L/M/Q/H, PDF417 0-8, Aztec percent)' },
        columns: { type: 'integer', minimum: 1, maximum: 30 }, rows: { type: 'integer', minimum: 1, maximum: 90 }, version: { type: 'string', maxLength: 12 }, format: { enum: ['square', 'rectangle', 'full', 'compact', 'micro'] }, addon: { type: 'string', pattern: '^(\\d{2}|\\d{5})$', description: 'EAN-2 or EAN-5 add-on (retail symbologies)' } }),
    { text: '4006381333931' }),
    engine('qr', obj({ text: text(2900), ecc: ECC, gs1: { type: 'boolean', default: false, description: 'GS1 QR: the text is a bracketed GS1 element string' }, ...LOOK }), { text: 'https://openvibe.tools', ecc: 'M' }),
    engine('wifiqr', obj({
        ssid: text(64, 'Network name'), password: { type: 'string', maxLength: 128 }, security: { enum: ['WPA', 'WEP', 'nopass'], default: 'WPA', description: 'WPA covers WPA2 and WPA3' },
        hidden: { type: 'boolean', default: false }, ecc: ECC, ...LOOK,
    }, ['ssid']), { ssid: 'Cafe Guest', password: 'espresso-2026', security: 'WPA' }),
    engine('vcardqr', obj({
        first: { type: 'string', maxLength: 80 }, last: { type: 'string', maxLength: 80 }, org: { type: 'string', maxLength: 120 }, title: { type: 'string', maxLength: 120 },
        phone: { type: 'string', maxLength: 40 }, email: { type: 'string', maxLength: 160 }, url: { type: 'string', maxLength: 300 }, address: { type: 'string', maxLength: 300 }, ecc: ECC, ...LOOK,
    }, []), { first: 'Ada', last: 'Lovelace', phone: '+44 20 7946 0000', email: 'ada@example.com' }),
    engine('datamatrix', obj({ text: text(2000), gs1: { type: 'boolean', default: false, description: 'GS1 DataMatrix: the text is a bracketed GS1 element string' }, shape: { enum: ['square', 'rectangle'], default: 'square' }, ...LOOK }), { text: '(01)09506000134352(17)251231(10)ABC123', gs1: true }),
    engine('gs1', obj({ text: text(500, 'A GTIN, UPC, EAN, ISBN, ISSN or SSCC number, or a GS1 element string ((01)…(17)… or raw)') }),
        { text: '(01)09506000134352(17)251231(10)ABC123' },
        {
            kind: 'json', schema: {
                type: 'object', required: ['number', 'gs1'],
                properties: {
                    number: { type: ['object', 'null'], description: 'What the number is: kind, valid, expected check digit, the fixed number, conversions', properties: { kind: { type: 'string' }, valid: { type: 'boolean' }, expected: { type: 'string' }, fixed: { type: 'string' }, symbology: { type: 'string' } } },
                    gs1: { type: ['object', 'null'], description: 'A GS1 element string split into Application Identifiers', properties: { ok: { type: 'boolean' }, parts: { type: 'array', items: { type: 'object', properties: { ai: { type: 'string' }, title: { type: 'string' }, value: { type: 'string' }, valid: { type: 'boolean' }, error: { type: 'string' }, display: { type: 'string' } } } }, error: { type: 'string' } } },
                },
            },
        }),
    engine('code128', obj({ text: text(200), ...BARS }), { text: 'OV-2026-0042' }),
    engine('ean13', obj({ text: { type: 'string', pattern: '^[0-9 -]{12,17}$', description: '12 digits (the check digit is added) or 13' }, addon: { type: 'string', pattern: '^(\\d{2}|\\d{5})$' }, ...BARS }), { text: '400638133393' }),
    engine('upc', obj({ text: { type: 'string', pattern: '^[0-9 -]{8,15}$', description: 'UPC-A: 11 digits (the check digit is added) or 12; UPC-E: 8' }, addon: { type: 'string', pattern: '^(\\d{2}|\\d{5})$' }, ...BARS }), { text: '03600029145' }),
    engine('pdf417', obj({ text: text(1800), columns: { type: 'integer', minimum: 1, maximum: 30 }, eclevel: { type: 'integer', minimum: 0, maximum: 8 }, ...LOOK }), { text: 'PDF417 carries up to about 1,800 characters.' }),
    engine('aztec', obj({ text: text(3000), eclevel: { type: 'integer', minimum: 5, maximum: 95, description: 'Error correction, percent (default 23)' }, ...LOOK }), { text: 'TICKET 4471 SEAT 12A' }),
    engine('isbn', obj({ text: { type: 'string', pattern: '^(ISBN[ :-]*)?[0-9Xx -]{10,17}$', description: 'An ISBN-10 or ISBN-13' }, addon: { type: 'string', pattern: '^\\d{5}$', description: 'EAN-5 price add-on, e.g. 51995 for US $19.95' }, ...BARS }), { text: '978-0-306-40615-7', addon: '51995' }),
    page('scan', { kind: 'json', schema: { type: 'object', description: 'The codes found in a camera frame or a picture: format, text and position (in the browser)', properties: { codes: { type: 'array' } } } }),
    page('bulkbarcodes', { kind: 'files', mime: ['application/zip', 'image/png', 'image/svg+xml'] }),
];

module.exports = { SPECS };
