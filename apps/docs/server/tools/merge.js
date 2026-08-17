'use strict';

// ═══════════════════════════════════════════════════════════════
// Docs.OpenVibe — Merge PDFs Tool
// Combines multiple PDF files into a single document.
// ═══════════════════════════════════════════════════════════════

const { PDFDocument } = require('pdf-lib');

/**
 * Merge multiple PDF buffers into one.
 * @param {Buffer[]} buffers - Array of PDF file buffers
 * @param {Object} options - { order: number[] (optional reorder indices) }
 * @returns {{ buffer: Buffer, ext: string, mime: string, pageCount: number }}
 */
async function merge(buffers, options = {}) {
    if (!Array.isArray(buffers) || buffers.length < 2) {
        throw new Error('Merge requires at least 2 PDF files.');
    }

    const merged = await PDFDocument.create();
    let totalPages = 0;

    // Apply custom order if provided
    const order = options.order || buffers.map((_, i) => i);

    for (const idx of order) {
        const buf = buffers[idx];
        if (!buf) continue;

        try {
            const src = await PDFDocument.load(buf, { ignoreEncryption: true });
            const pages = await merged.copyPages(src, src.getPageIndices());
            for (const page of pages) {
                merged.addPage(page);
                totalPages++;
            }
        } catch (err) {
            throw new Error(`Failed to read PDF file #${idx + 1}: ${err.message}`);
        }
    }

    if (totalPages === 0) {
        throw new Error('No pages found in the uploaded PDFs.');
    }

    const outputBytes = await merged.save();

    return {
        buffer: Buffer.from(outputBytes),
        ext: 'pdf',
        mime: 'application/pdf',
        pageCount: totalPages,
    };
}

module.exports = merge;
