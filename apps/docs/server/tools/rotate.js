'use strict';

// ═══════════════════════════════════════════════════════════════
// Docs.OpenVibe — Rotate PDF Pages Tool
// Rotates all or specific pages by 90°, 180°, or 270°.
// ═══════════════════════════════════════════════════════════════

const { PDFDocument, degrees } = require('pdf-lib');

/**
 * Rotate pages in a PDF.
 * @param {Buffer} buffer - PDF buffer
 * @param {Object} options - { angle: 90|180|270, pages: '1,3,5' or 'all' }
 * @returns {{ buffer: Buffer, ext: string, mime: string, pageCount: number }}
 */
async function rotate(buffer, options = {}) {
    const angle = parseInt(options.angle) || 90;
    if (![90, 180, 270].includes(angle)) {
        throw new Error('Rotation angle must be 90, 180, or 270 degrees.');
    }

    const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const totalPages = src.getPageCount();
    const pages = src.getPages();

    // Parse which pages to rotate
    const targetPages = parsePageList(options.pages, totalPages);

    for (const pageNum of targetPages) {
        const page = pages[pageNum - 1];
        const currentRotation = page.getRotation().angle;
        page.setRotation(degrees((currentRotation + angle) % 360));
    }

    const outputBytes = await src.save();
    return {
        buffer: Buffer.from(outputBytes),
        ext: 'pdf',
        mime: 'application/pdf',
        pageCount: totalPages,
        rotatedPages: targetPages.length,
        angle,
    };
}

/**
 * Parse page list: 'all' → [1..n], '1,3,5-7' → [1,3,5,6,7]
 */
function parsePageList(input, totalPages) {
    if (!input || input === 'all') {
        return Array.from({ length: totalPages }, (_, i) => i + 1);
    }

    const result = new Set();
    const parts = String(input).split(',').map(s => s.trim()).filter(Boolean);

    for (const part of parts) {
        if (part.includes('-')) {
            const [start, end] = part.split('-').map(Number);
            if (Number.isFinite(start) && Number.isFinite(end)) {
                for (let i = Math.max(1, start); i <= Math.min(totalPages, end); i++) {
                    result.add(i);
                }
            }
        } else {
            const p = Number(part);
            if (Number.isFinite(p) && p >= 1 && p <= totalPages) result.add(p);
        }
    }

    return [...result].sort((a, b) => a - b);
}

module.exports = rotate;
