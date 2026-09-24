'use strict';

// ═══════════════════════════════════════════════════════════════
// Docs.OpenVibe — Images to PDF Tool
// Converts one or more images into a PDF document.
// Each image becomes one page.
// ═══════════════════════════════════════════════════════════════

const { PDFDocument } = require('pdf-lib');
const sharp = require('sharp');
const guardLimits = require('../../../_shared/guard/limits');

/** No picture larger than the guard's pixel limit (40 MP, TOOLS_MAX_INPUT_PIXELS) is decoded. */
function checkPixels(metadata, i, count) {
    const limit = guardLimits.bounds().maxInputPixels;
    const w = metadata.width || 0, h = metadata.pageHeight || metadata.height || 0;
    if (w * h <= limit) return;
    const mp = (n) => `${Math.round(n / 1e5) / 10} megapixels`;
    throw Object.assign(new Error(`${count > 1 ? `Image ${i + 1}` : 'The image'} is ${w}×${h} (${mp(w * h)}); the limit is ${mp(limit)}.`), { status: 413, code: 'tools.file.too_large', guardReason: 'pixels', expose: true });
}

/**
 * Convert images to PDF.
 * @param {Buffer[]} buffers - Array of image buffers
 * @param {Object} options - { pageSize: 'a4'|'letter'|'fit', quality: number }
 * @returns {{ buffer: Buffer, ext: string, mime: string, pageCount: number }}
 */
async function img2pdf(buffers, options = {}) {
    if (!Array.isArray(buffers) || buffers.length === 0) {
        throw new Error('At least one image is required.');
    }

    const pdf = await PDFDocument.create();
    const pageSize = options.pageSize || 'a4';

    // Standard page sizes in points (1 inch = 72 points)
    const PAGE_SIZES = {
        a4: { width: 595.28, height: 841.89 },
        letter: { width: 612, height: 792 },
        legal: { width: 612, height: 1008 },
    };

    const limitInputPixels = guardLimits.bounds().maxInputPixels;
    for (const [i, imgBuf] of buffers.entries()) {
        // Convert to PNG or JPG using sharp for consistency
        const metadata = await sharp(imgBuf, { limitInputPixels: false }).metadata();   // the header only; checked next
        checkPixels(metadata, i, buffers.length);
        const imgWidth = metadata.width || 800;
        const imgHeight = metadata.height || 600;

        // Determine if we should embed as PNG or JPG
        let embeddedImage;
        if (metadata.format === 'jpeg' || metadata.format === 'jpg') {
            const jpgBuf = await sharp(imgBuf, { limitInputPixels }).jpeg({ quality: 90 }).toBuffer();
            embeddedImage = await pdf.embedJpg(jpgBuf);
        } else {
            const pngBuf = await sharp(imgBuf, { limitInputPixels }).png().toBuffer();
            embeddedImage = await pdf.embedPng(pngBuf);
        }

        let pageWidth, pageHeight;

        if (pageSize === 'fit') {
            // Page fits the image exactly (at 72 DPI)
            pageWidth = imgWidth;
            pageHeight = imgHeight;
        } else {
            const size = PAGE_SIZES[pageSize] || PAGE_SIZES.a4;
            pageWidth = size.width;
            pageHeight = size.height;
        }

        const page = pdf.addPage([pageWidth, pageHeight]);

        // Scale image to fit within the page with margins
        const margin = pageSize === 'fit' ? 0 : 36; // 0.5 inch margin
        const maxW = pageWidth - 2 * margin;
        const maxH = pageHeight - 2 * margin;

        const scale = Math.min(maxW / imgWidth, maxH / imgHeight, 1);
        const drawW = imgWidth * scale;
        const drawH = imgHeight * scale;

        // Center on page
        const x = (pageWidth - drawW) / 2;
        const y = (pageHeight - drawH) / 2;

        page.drawImage(embeddedImage, {
            x,
            y,
            width: drawW,
            height: drawH,
        });
    }

    const outputBytes = await pdf.save();
    return {
        buffer: Buffer.from(outputBytes),
        ext: 'pdf',
        mime: 'application/pdf',
        pageCount: buffers.length,
    };
}

module.exports = img2pdf;
