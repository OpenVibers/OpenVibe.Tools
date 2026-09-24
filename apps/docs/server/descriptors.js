'use strict';
// ═══════════════════════════════════════════════════════════════
// Docs.OpenVibe — what each PDF tool is, for the tool registry (tools.tool@1 specs, ADR-027;
// apps/_shared/tools/descriptor.js joins them with the catalogue's name, summary and hosts).
//
// Every PDF tool is its host's operation (domain-map.js) run as a docs.process job; pdf2jpg's host
// default (JPG) is its preset. Protect and Unlock need qpdf, PDF to image needs poppler's pdftoppm
// and pdfinfo (`requires`): while one is missing on the host the satellite lists the tool as
// unavailable, as its page and /api/process already say. Pure data: nothing here loads pdf-lib.
// apps/gateway/test/descriptors.test.js holds it to tools/index.js, process.js and config.js.
// ═══════════════════════════════════════════════════════════════

const { DOMAIN_MAP } = require('./domain-map');

const PDF = 'application/pdf';
// What Image to PDF takes: config.js upload.allowedMimes without the PDF, and without HEIC/HEIF, which the
// upload accepts but sharp (tools/img2pdf.js) cannot decode.
const IMAGES = ['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/tiff', 'image/bmp', 'image/gif'];
const MAX_BYTES = 100 * 1024 * 1024;          // config.js upload.maxFileSize
const MAX_FILES = 50;                         // process.js docs.process maxFiles (and the upload limit)
const TIMEOUT_MS = 10 * 60 * 1000;            // process.js docs.process timeoutMs
// tools/pdf.js MAX_PAGES and tools/pdf2img.js MAX_PAGES (both from the environment, like theirs).
const MAX_PAGES = Math.max(1, parseInt(process.env.PDF_MAX_PAGES, 10) || 500);
const PDF2IMG_PAGES = Math.max(1, parseInt(process.env.PDF2IMG_MAX_PAGES, 10) || 50);

const RESULT = {
    type: 'object',
    description: 'result.data: what the operation made (the file itself is result.files[0])',
    required: ['tool'],
    properties: {
        tool: { type: 'string' },
        output: { type: 'object', properties: { mime: { type: 'string' }, ext: { type: 'string' }, size: { type: 'integer' }, sizeKB: { type: 'number' } } },
        fileCount: { type: 'integer' }, pageCount: { type: 'integer' },
        savings: { type: 'object' }, metadata: { type: 'object' }, note: { type: 'string' },
        parts: { type: 'array', description: 'split: the page ranges of each part' },
        pages: { type: 'array', description: 'pdf2img: the pages rendered' },
        encryption: { type: 'object', description: 'protect: the encryption applied (never the passwords)' },
    },
};

const pages = { type: 'string', pattern: '^\\s*(all|\\d+(\\s*-\\s*\\d+)?(\\s*,\\s*\\d+(\\s*-\\s*\\d+)?)*)\\s*$', description: 'Pages: all, or a list like 1-3,5 (1-based)', default: 'all' };
const obj = (properties, required) => ({ type: 'object', additionalProperties: false, ...(required && { required }), properties });
const password = { type: 'string', minLength: 1, maxLength: 127, description: 'At most 127 bytes of UTF-8' };

// The options each operation reads (tools/<op>.js; process.js SINGLE_KEYS / MULTI_KEYS).
const OPS = {
    merge: { input: obj({ order: { type: 'array', items: { type: 'integer', minimum: 0, maximum: MAX_FILES - 1 }, maxItems: MAX_FILES, description: 'The files\' order by their index (0-based); default: as uploaded' } }), files: { min: 2, max: MAX_FILES, accept: [PDF] }, mime: [PDF], cost: 8 },
    split: { input: obj({ ranges: { type: 'string', pattern: '^\\s*(all|half|\\d+(\\s*-\\s*\\d+)?(\\s*,\\s*\\d+(\\s*-\\s*\\d+)?)*)\\s*$', default: 'all', description: 'all (every page on its own), half, or ranges like 1-3,5,7-9: one part each; several parts come back as a ZIP' } }), files: { min: 1, max: 1, accept: [PDF] }, mime: [PDF, 'application/zip'], cost: 5 },
    compress: { input: obj({ level: { enum: ['low', 'medium', 'high'], default: 'medium', description: 'high also strips the document metadata' } }), files: { min: 1, max: 1, accept: [PDF] }, mime: [PDF], cost: 5 },
    rotate: { input: obj({ angle: { enum: [90, 180, 270], default: 90 }, pages }), files: { min: 1, max: 1, accept: [PDF] }, mime: [PDF], cost: 5 },
    reorder: { input: obj({ order: { type: 'string', pattern: '^\\s*\\d+(\\s*,\\s*\\d+)*\\s*$', description: 'The new page order, 1-based (3,1,2); pages left out are dropped' } }, ['order']), files: { min: 1, max: 1, accept: [PDF] }, mime: [PDF], cost: 5 },
    watermark: {
        input: obj({
            text: { type: 'string', minLength: 1, maxLength: 200, default: 'WATERMARK' }, fontSize: { type: 'integer', minimum: 6, maximum: 400, default: 48 },
            opacity: { type: 'number', minimum: 0.01, maximum: 1, default: 0.15 }, rotation: { type: 'integer', minimum: -360, maximum: 360, default: -45 },
            color: { type: 'string', pattern: '^#?[0-9a-fA-F]{6}$', default: '#888888' }, pages,
        }),
        files: { min: 1, max: 1, accept: [PDF] }, mime: [PDF], cost: 5,
    },
    protect: {
        input: obj({ password, ownerPassword: { ...password, description: 'Owner password (default: a random one, never shown)' }, allowPrint: { type: 'boolean', default: true }, allowCopy: { type: 'boolean', default: true } }, ['password']),
        files: { min: 1, max: 1, accept: [PDF] }, mime: [PDF], cost: 10, requires: ['qpdf'],
    },
    unlock: { input: obj({ password }, ['password']), files: { min: 1, max: 1, accept: [PDF] }, mime: [PDF], cost: 10, requires: ['qpdf'] },
    img2pdf: { input: obj({ pageSize: { enum: ['a4', 'letter', 'legal', 'fit'], default: 'a4', description: 'fit: each page is its picture\'s size' } }), files: { min: 1, max: MAX_FILES, accept: IMAGES }, mime: [PDF], cost: 8 },
    pdf2img: {
        input: obj({ format: { enum: ['jpg', 'png'], description: 'Default: jpg' }, dpi: { type: 'integer', minimum: 72, maximum: 600, default: 150 }, pages }),
        files: { min: 1, max: 1, accept: [PDF] }, mime: ['image/jpeg', 'image/png', 'application/zip'], cost: 10, requires: ['pdftoppm', 'pdfinfo'],
        maxPages: PDF2IMG_PAGES,
    },
};

/** One PDF tool: its host's operation as a docs.process job. */
function tool(id, extra = {}) {
    const ctx = DOMAIN_MAP[`${id}.openvibe.tools`];
    if (!ctx || !ctx.defaultOp) throw new Error(`docs: ${id}.openvibe.tools has no operation in domain-map.js`);
    const op = ctx.defaultOp;
    const o = OPS[op];
    return {
        id, execution: 'job', api: true,
        job: { type: 'docs.process', operation: op, ...(ctx.defaultFormat && { preset: { defaultFormat: ctx.defaultFormat } }) },
        legacy: [o.files.max > 1 ? 'POST /api/process/multi' : 'POST /api/process'],
        input: o.input,
        files: { ...o.files, maxBytes: MAX_BYTES },
        output: { kind: 'file', mime: o.mime, schema: RESULT },
        limits: { timeoutMs: TIMEOUT_MS, ...(op !== 'img2pdf' && { maxPages: o.maxPages || MAX_PAGES }) },
        // Heavy work (a worker thread each, apps/_shared/jobs/pool.js): a browser session, a person or a token.
        auth: { anonymous: false, capability: 'tools.tool.run' },
        quotaClass: 'tools-job', cost: o.cost, egress: false,
        ...(o.requires && { requires: o.requires }),
        example: { input: op === 'reorder' ? { order: '1' } : op === 'protect' || op === 'unlock' ? { password: 'example' } : {} },
        ...extra,
    };
}

const IDS = ['mergepdf', 'splitpdf', 'compresspdf', 'rotatepdf', 'reorderpdf', 'watermarkpdf', 'protectpdf', 'unlockpdf', 'image2pdf', 'pdf2jpg'];
const SPECS = IDS.map(id => tool(id));

module.exports = { SPECS, OPS, IMAGES, MAX_BYTES, MAX_FILES, TIMEOUT_MS, MAX_PAGES };
