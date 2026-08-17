'use strict';

// ═══════════════════════════════════════════════════════════════
// Docs.OpenVibe — Reorder PDF Pages Tool
// Rearranges pages in a PDF according to a new order.
// Can also remove pages by omitting them from the order.
// ═══════════════════════════════════════════════════════════════

const { PDFDocument } = require('pdf-lib');

/**
 * Reorder pages in a PDF.
 * @param {Buffer} buffer - PDF buffer
 * @param {Object} options - { order: '3,1,2,5,4' (new page order, 1-based) }
 * @returns {{ buffer: Buffer, ext: string, mime: string, pageCount: number }}
 */
async function reorder(buffer, options = {}) {
    if (!options.order) {
        throw new Error('Page order is required. Provide a comma-separated list of page numbers.');
    }

    const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const totalPages = src.getPageCount();

    // Parse order
    const newOrder = String(options.order)
        .split(',')
        .map(s => parseInt(s.trim()))
        .filter(n => Number.isFinite(n) && n >= 1 && n <= totalPages);

    if (newOrder.length === 0) {
        throw new Error(`Invalid page order. PDF has ${totalPages} pages.`);
    }

    // Create new document with pages in the specified order
    const output = await PDFDocument.create();
    const pages = await output.copyPages(src, newOrder.map(p => p - 1));
    for (const page of pages) {
        output.addPage(page);
    }

    const outputBytes = await output.save();
    return {
        buffer: Buffer.from(outputBytes),
        ext: 'pdf',
        mime: 'application/pdf',
        pageCount: newOrder.length,
        originalPageCount: totalPages,
        removedPages: totalPages - newOrder.length,
    };
}

module.exports = reorder;
