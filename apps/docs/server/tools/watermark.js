'use strict';

// ═══════════════════════════════════════════════════════════════
// Docs.OpenVibe — Watermark PDF Tool
// Adds text watermarks to PDF pages with customizable properties.
// ═══════════════════════════════════════════════════════════════

const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');

/**
 * Add text watermarks to a PDF.
 * @param {Buffer} buffer - PDF buffer
 * @param {Object} options - { text, fontSize, opacity, rotation, color, pages }
 * @returns {{ buffer: Buffer, ext: string, mime: string, pageCount: number }}
 */
async function watermark(buffer, options = {}) {
    const text = options.text || 'WATERMARK';
    const fontSize = parseInt(options.fontSize) || 48;
    const opacity = Math.min(1, Math.max(0.01, parseFloat(options.opacity) || 0.15));
    const rotation = parseInt(options.rotation) ?? -45;

    // Parse color (hex to rgb)
    const color = parseColor(options.color || '#888888');

    const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const totalPages = src.getPageCount();
    const font = await src.embedFont(StandardFonts.Helvetica);
    const pages = src.getPages();

    // Determine which pages to watermark
    const targetPages = parsePageList(options.pages, totalPages);

    for (const pageNum of targetPages) {
        const page = pages[pageNum - 1];
        const { width, height } = page.getSize();

        // Center the watermark
        const textWidth = font.widthOfTextAtSize(text, fontSize);
        const x = (width - textWidth) / 2;
        const y = height / 2;

        page.drawText(text, {
            x,
            y,
            size: fontSize,
            font,
            color: rgb(color.r, color.g, color.b),
            opacity,
            rotate: degrees(rotation),
        });
    }

    const outputBytes = await src.save();
    return {
        buffer: Buffer.from(outputBytes),
        ext: 'pdf',
        mime: 'application/pdf',
        pageCount: totalPages,
        watermarkedPages: targetPages.length,
    };
}

function parseColor(hex) {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    const r = parseInt(hex.substring(0, 2), 16) / 255;
    const g = parseInt(hex.substring(2, 4), 16) / 255;
    const b = parseInt(hex.substring(4, 6), 16) / 255;
    return { r: Number.isFinite(r) ? r : 0.5, g: Number.isFinite(g) ? g : 0.5, b: Number.isFinite(b) ? b : 0.5 };
}

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
                for (let i = Math.max(1, start); i <= Math.min(totalPages, end); i++) result.add(i);
            }
        } else {
            const p = Number(part);
            if (Number.isFinite(p) && p >= 1 && p <= totalPages) result.add(p);
        }
    }
    return [...result].sort((a, b) => a - b);
}

module.exports = watermark;
