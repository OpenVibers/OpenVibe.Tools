'use strict';

// ═══════════════════════════════════════════════════════════════
// Docs.OpenVibe — Split PDF Tool
// Splits a PDF by page ranges or extracts individual pages.
// ═══════════════════════════════════════════════════════════════

const { PDFDocument } = require('pdf-lib');
const { loadPdf, zip } = require('./pdf');   // pdf-lib's load + the page limit; parts come back as one ZIP

/**
 * Split a PDF into parts.
 * @param {Buffer} buffer - Single PDF buffer
 * @param {Object} options - { ranges: '1-3,5,7-9' | mode: 'all' (every page) | mode: 'half' }
 * @returns {{ buffer: Buffer, ext: string, mime: string, parts: number }}
 */
async function split(buffer, options = {}) {
    const src = await loadPdf(buffer);
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

    // Several parts ("every page", "in half", several ranges) → one PDF per part, in one ZIP.
    // (This used to return only the first part.)
    const width = String(totalPages).length;
    const label = (pages) => (pages.length === 1 ? `page-${String(pages[0]).padStart(width, '0')}` : `pages-${String(pages[0]).padStart(width, '0')}-${String(pages[pages.length - 1]).padStart(width, '0')}`);
    const results = [];
    for (const range of ranges) {
        const output = await PDFDocument.create();
        const pages = await output.copyPages(src, range.map(p => p - 1));
        for (const page of pages) output.addPage(page);
        results.push({ buffer: Buffer.from(await output.save()), pages: range });
    }

    return {
        buffer: zip(results.map((r, i) => ({ name: `part-${String(i + 1).padStart(String(results.length).length, '0')}-${label(r.pages)}.pdf`, data: r.buffer }))),
        ext: 'zip',
        mime: 'application/zip',
        parts: results.length,
        pageCount: results.reduce((n, r) => n + r.pages.length, 0),
        totalPages,
        allParts: results.map((r, i) => ({ part: i + 1, pages: r.pages, size: r.buffer.length })),
        note: `${results.length} PDF files in one ZIP.`,
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
        return [first, second].filter(r => r.length);
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
