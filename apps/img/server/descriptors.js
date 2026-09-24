'use strict';
// ═══════════════════════════════════════════════════════════════
// Img.OpenVibe — what each image tool is, for the tool registry (tools.tool@1 specs, ADR-027;
// apps/_shared/tools/descriptor.js joins them with the catalogue's name, summary and hosts).
//
// Every image tool is its host's operation (domain-map.js: convert, compress, resize or crop) run as an
// img.process job, with the host's default format as the job's preset (a caller's `format` still wins,
// as it does on the page). Pure data: nothing here loads sharp. apps/gateway/test/descriptors.test.js
// holds it to tools/index.js (the operations exist), tools/convert.js (the formats), process.js (the
// option names, the job timeout) and config.js (the accepted uploads and their size).
// ═══════════════════════════════════════════════════════════════

const { DOMAIN_MAP } = require('./domain-map');
const guardLimits = require('../../_shared/guard/limits');

// tools/convert.js FORMAT_CONFIG: what convert can write, and the media type each one is.
const FORMAT_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif', tiff: 'image/tiff', bmp: 'image/bmp', gif: 'image/gif', ico: 'image/x-icon' };
// config.js upload.allowedMimes: every image tool takes any of these (HEIC needs libheif's decoder).
const ACCEPT = ['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/tiff', 'image/bmp', 'image/gif', 'image/heic', 'image/heif', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon'];
const MAX_BYTES = 50 * 1024 * 1024;           // config.js upload.maxFileSize
const TIMEOUT_MS = 5 * 60 * 1000;             // process.js img.process timeoutMs
// tools/codec.js inputPixels(): no upload larger than this is decoded (sharp's limitInputPixels, and the
// BMP, ICO and HEIC readers), 40 megapixels unless TOOLS_MAX_INPUT_PIXELS says otherwise.
const MAX_PIXELS = guardLimits.bounds().maxInputPixels;
const SAME_AS_INPUT = ['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/tiff', 'image/gif', 'image/bmp'];

const RESULT = {
    type: 'object',
    description: 'result.data: what the operation made (the file itself is result.files[0])',
    required: ['tool', 'output'],
    properties: {
        tool: { type: 'string' },
        output: { type: 'object', properties: { mime: { type: 'string' }, ext: { type: 'string' }, size: { type: 'integer' }, sizeKB: { type: 'number' } } },
        savings: { type: 'object', description: 'compress: before and after sizes' },
        dimensions: { type: 'object', description: 'resize: { original, output } width and height' },
        crop: { type: 'object', description: 'crop: the rectangle that was kept' },
    },
};

const quality = (dflt) => ({ type: 'integer', minimum: 1, maximum: 100, default: dflt, description: 'Quality for lossy formats (JPG, WebP, AVIF); PNG maps it to its compression level' });
const format = (dflt) => ({ enum: Object.keys(FORMAT_MIME), ...(dflt && { default: dflt }), description: 'Output format' });

const INPUT = {
    convert: (dflt) => ({ type: 'object', additionalProperties: false, properties: { format: format(dflt), quality: quality(80) } }),
    compress: () => ({ type: 'object', additionalProperties: false, properties: { quality: quality(75) } }),
    resize: () => ({
        type: 'object', additionalProperties: false,
        properties: {
            width: { type: 'integer', minimum: 1, maximum: 16384, description: 'Target width in pixels' },
            height: { type: 'integer', minimum: 1, maximum: 16384, description: 'Target height in pixels' },
            percentage: { type: 'number', minimum: 1, maximum: 1000, description: 'Scale by a percentage instead (wins over width and height)' },
            fit: { enum: ['cover', 'contain', 'fill', 'inside', 'outside'], default: 'inside', description: 'How the picture fits the box; never enlarged past its own size' },
            background: { type: 'string', pattern: '^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$', description: 'Fill for contain and fill (hex, alpha allowed)' },
        },
    }),
    crop: () => ({
        type: 'object', additionalProperties: false,
        properties: {
            aspect: { enum: ['16:9', '4:3', '1:1', '3:2', '21:9', '9:16', '3:4', '2:3'], description: 'Crop the largest centred area of this ratio (wins over the rectangle)' },
            left: { type: 'integer', minimum: 0 }, top: { type: 'integer', minimum: 0 },
            width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 },
        },
    }),
};

/** One image tool: its host's operation and default format, as an img.process job. */
function tool(id, extra = {}) {
    const ctx = DOMAIN_MAP[`${id}.openvibe.tools`];
    if (!ctx || !ctx.defaultOp) throw new Error(`img: ${id}.openvibe.tools has no operation in domain-map.js`);
    const op = ctx.defaultOp;
    const out = op === 'convert' ? Object.values(FORMAT_MIME).filter((m, i, a) => a.indexOf(m) === i) : SAME_AS_INPUT;
    return {
        id, execution: 'job', api: true,
        job: { type: 'img.process', operation: op, ...(ctx.defaultFormat && { preset: { defaultFormat: ctx.defaultFormat } }) },
        legacy: ['POST /api/process', 'POST /api/process/direct'],
        input: INPUT[op](ctx.defaultFormat),
        files: { min: 1, max: 1, accept: ACCEPT, maxBytes: MAX_BYTES },
        output: { kind: 'file', mime: out, schema: RESULT },
        limits: { timeoutMs: TIMEOUT_MS, maxPixels: MAX_PIXELS },
        auth: { anonymous: true, capability: 'tools.tool.run' },
        quotaClass: 'tools-job', cost: op === 'convert' && ['avif', 'ico'].includes(ctx.defaultFormat) ? 8 : 5, egress: false,
        example: { input: {} },
        ...extra,
    };
}

const SPECS = [
    tool('convert'), tool('compress'), tool('resize', { example: { input: { width: 8 } } }), tool('crop', { example: { input: { aspect: '1:1' } } }),
    tool('png'), tool('jpg'), tool('webp'), tool('avif'),
    // heic.openvibe.tools exists to read iPhone photos: without libheif's decoder it cannot do its job.
    tool('heic', { requires: ['heif-dec'] }),
    tool('svg'), tool('gif'), tool('ico'), tool('favicon'), tool('tiff'), tool('bmp'),
];

module.exports = { SPECS, FORMAT_MIME, ACCEPT, MAX_BYTES, TIMEOUT_MS };
