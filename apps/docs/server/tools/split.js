'use strict';

// ═══════════════════════════════════════════════════════════════
// Docs.OpenVibe — Split PDF Tool
// Splits a PDF by page ranges or extracts individual pages.
// ═══════════════════════════════════════════════════════════════

const { PDFDocument } = require('pdf-lib');

/**
 * Split a PDF into parts.
 * @param {Buffer} buffer - Single PDF buffer
 * @param {Object} options - { ranges: '1-3,5,7-9' | mode: 'all' (every page) | mode: 'half' }
 * @returns {{ buffer: Buffer, ext: string, mime: string, parts: number }}
 */
async function split(buffer, options = {}) {
    const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const totalPages = src.getPageCount();

    if (totalPages === 0) throw new Error('PDF has no pages.');

    // Parse ranges
    const ranges = parseRanges(options.ranges || options.mode, totalPages);

    if (ranges.length === 1) {
        // Single range → extract those pages into one PDF
        const output = await PDFDocument.create();
        const pages = await output.copyPages(src, ranges[0].map(p => p - 1));
        for (const page of pages) output.addPage(page);

        const outputBytes = await output.save();
        return {
            buffer: Buffer.from(outputBytes),
            ext: 'pdf',
            mime: 'application/pdf',
            parts: 1,
            pageCount: pages.length,
            totalPages,
        };
    }

    // Multiple ranges → create a ZIP-like response (we'll return multiple PDFs)
    // For simplicity, return the first part and metadata about all parts
    // In practice the frontend makes multiple calls or we return all parts
    const results = [];
    for (const range of ranges) {
        const output = await PDFDocument.create();
        const pages = await output.copyPages(src, range.map(p => p - 1));
        for (const page of pages) output.addPage(page);
        results.push({
            buffer: Buffer.from(await output.save()),
            pages: range,
        });
    }

    // Return the combined result as the first part's buffer with metadata
    return {
        buffer: results[0].buffer,
        ext: 'pdf',
        mime: 'application/pdf',
        parts: results.length,
        pageCount: results[0].pages.length,
        totalPages,
        allParts: results.map((r, i) => ({
            part: i + 1,
            pages: r.pages,
            size: r.buffer.length,
        })),
        // Store all part buffers for multi-download
        _partBuffers: results.map(r => r.buffer),
    };
}

/**
 * Parse page range string into arrays of page numbers.
 * '1-3,5,7-9' → [[1,2,3], [5], [7,8,9]]
 * 'all' → [[1], [2], [3], ...] (every page separate)
 * 'half' → [[1..n/2], [n/2+1..n]]
 */
function parseRanges(input, totalPages) {
    if (!input || input === 'all') {
        // Every page as a separate part
        return Array.from({ length: totalPages }, (_, i) => [i + 1]);
    }

    if (input === 'half') {
        const mid = Math.ceil(totalPages / 2);
        const first = Array.from({ length: mid }, (_, i) => i + 1);
        const second = Array.from({ length: totalPages - mid }, (_, i) => mid + i + 1);
        return [first, second];
    }

    // Custom ranges: '1-3,5,7-9'
    const parts = String(input).split(',').map(s => s.trim()).filter(Boolean);
    const ranges = [];

    for (const part of parts) {
        if (part.includes('-')) {
            const [start, end] = part.split('-').map(Number);
            if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end > totalPages || start > end) {
                throw new Error(`Invalid page range: ${part}. PDF has ${totalPages} pages.`);
            }
            ranges.push(Array.from({ length: end - start + 1 }, (_, i) => start + i));
        } else {
            const page = Number(part);
            if (!Number.isFinite(page) || page < 1 || page > totalPages) {
                throw new Error(`Invalid page number: ${part}. PDF has ${totalPages} pages.`);
            }
            ranges.push([page]);
        }
    }

    if (ranges.length === 0) throw new Error('No valid page ranges specified.');
    return ranges;
}

module.exports = split;
