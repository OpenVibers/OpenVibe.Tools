'use strict';

// ═══════════════════════════════════════════════════════════════
// Docs.OpenVibe — Tool Registry
// Central registry of all document/PDF processing tools.
// Each tool exports: { label, description, accepts, handler }
// ═══════════════════════════════════════════════════════════════

const merge     = require('./merge');
const split     = require('./split');
const compress  = require('./compress');
const rotate    = require('./rotate');
const reorder   = require('./reorder');
const watermark = require('./watermark');
const protect   = require('./protect');
const unlock    = require('./unlock');
const img2pdf   = require('./img2pdf');
const pdf2img   = require('./pdf2img');
const metadata  = require('./metadata');
const { qpdf, pdftoppm, pdfinfo } = require('./pdf');

const TOOLS = {
    merge: {
        id: 'merge',
        label: 'Merge PDFs',
        description: 'Combine multiple PDF files into one document',
        faIcon: 'fa-object-group',
        accepts: ['pdf'],
        multiFile: true,
        handler: merge,
    },
    split: {
        id: 'split',
        label: 'Split PDF',
        description: 'Split a PDF into multiple files by page range',
        faIcon: 'fa-scissors',
        accepts: ['pdf'],
        multiFile: false,
        handler: split,
    },
    compress: {
        id: 'compress',
        label: 'Compress PDF',
        description: 'Reduce PDF file size',
        faIcon: 'fa-compress',
        accepts: ['pdf'],
        multiFile: false,
        handler: compress,
    },
    rotate: {
        id: 'rotate',
        label: 'Rotate Pages',
        description: 'Rotate PDF pages by 90°, 180°, or 270°',
        faIcon: 'fa-rotate',
        accepts: ['pdf'],
        multiFile: false,
        handler: rotate,
    },
    reorder: {
        id: 'reorder',
        label: 'Reorder Pages',
        description: 'Rearrange or remove pages in a PDF',
        faIcon: 'fa-sort',
        accepts: ['pdf'],
        multiFile: false,
        handler: reorder,
    },
    watermark: {
        id: 'watermark',
        label: 'Watermark',
        description: 'Add text watermarks to PDF pages',
        faIcon: 'fa-stamp',
        accepts: ['pdf'],
        multiFile: false,
        handler: watermark,
    },
    protect: {
        id: 'protect',
        label: 'Protect PDF',
        description: 'Add password protection to a PDF',
        faIcon: 'fa-lock',
        accepts: ['pdf'],
        multiFile: false,
        requires: [qpdf],               // AES-256 encryption
        handler: protect,
    },
    unlock: {
        id: 'unlock',
        label: 'Unlock PDF',
        description: 'Remove password from a PDF',
        faIcon: 'fa-lock-open',
        accepts: ['pdf'],
        multiFile: false,
        requires: [qpdf],               // decryption
        handler: unlock,
    },
    img2pdf: {
        id: 'img2pdf',
        label: 'Images to PDF',
        description: 'Convert images to a PDF document',
        faIcon: 'fa-file-image',
        accepts: ['png', 'jpg', 'jpeg', 'webp', 'tiff', 'bmp', 'gif'],
        multiFile: true,
        handler: img2pdf,
    },
    pdf2img: {
        id: 'pdf2img',
        label: 'PDF to Images',
        description: 'Convert PDF pages to images',
        faIcon: 'fa-image',
        accepts: ['pdf'],
        multiFile: false,
        requires: [pdftoppm, pdfinfo],  // poppler-utils renders the pages
        handler: pdf2img,
    },
    metadata: {
        id: 'metadata',
        label: 'PDF Info',
        description: 'View and edit PDF metadata (title, author, etc.)',
        faIcon: 'fa-circle-info',
        accepts: ['pdf'],
        multiFile: false,
        handler: metadata,
    },
};

function getTool(id) {
    return TOOLS[id] || null;
}

/** Can this server run the tool now? (Its command-line tools are installed.) */
function isAvailable(tool) {
    return (tool.requires || []).every(b => b.available());
}

/** Throws 503 tools.unavailable when a tool's command-line tools are missing. */
function assertAvailable(tool) {
    for (const b of tool.requires || []) b.path({ tool: tool.id });
}

function listTools() {
    return Object.values(TOOLS).map(t => ({
        id: t.id, label: t.label, description: t.description,
        faIcon: t.faIcon, accepts: t.accepts, multiFile: t.multiFile,
        available: isAvailable(t),
        ...(!isAvailable(t) && { unavailable: 'This tool is being set up on the server and is not available yet.' }),
    }));
}

/** Every optional command-line tool, for boot detection and /api/ready. */
const BINARIES = [qpdf, pdftoppm, pdfinfo];

module.exports = { TOOLS, getTool, listTools, isAvailable, assertAvailable, BINARIES };
