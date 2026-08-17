'use strict';

// ═══════════════════════════════════════════════════════════════
// Docs.OpenVibe — Images to PDF Tool
// Converts one or more images into a PDF document.
// Each image becomes one page.
// ═══════════════════════════════════════════════════════════════

const { PDFDocument } = require('pdf-lib');
const sharp = require('sharp');

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

    for (const imgBuf of buffers) {
        // Convert to PNG or JPG using sharp for consistency
        const metadata = await sharp(imgBuf).metadata();
        const imgWidth = metadata.width || 800;
        const imgHeight = metadata.height || 600;

        // Determine if we should embed as PNG or JPG
        let embeddedImage;
        if (metadata.format === 'jpeg' || metadata.format === 'jpg') {
            const jpgBuf = await sharp(imgBuf).jpeg({ quality: 90 }).toBuffer();
            embeddedImage = await pdf.embedJpg(jpgBuf);
        } else {
            const pngBuf = await sharp(imgBuf).png().toBuffer();
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
