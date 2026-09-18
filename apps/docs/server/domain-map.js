'use strict';

// ═══════════════════════════════════════════════════════════════
// Docs.OpenVibe — Domain → Context Mapping
// One Express server handles all document/PDF subdomain hostnames.
// Each hostname maps to a brand name, default tool, and SEO data.
// ═══════════════════════════════════════════════════════════════

const DOMAIN_MAP = {
    // ── Hub ──────────────────────────────────────────────────
    'docs.openvibe.tools': {
        toolId: 'hub', brandName: 'Docs.OpenVibe', defaultOp: null,
        faIcon: 'fa-file-pdf',
        seoTitle: 'Docs.OpenVibe — Online PDF & Document Tools',
        seoDescription: 'Merge, split, compress, convert, rotate, reorder, watermark, and sign PDFs online. No sign-up required.',
    },

    // ── PDF Hub alias ────────────────────────────────────────
    'pdf.openvibe.tools': {
        toolId: 'hub', brandName: 'OpenVibePDF', defaultOp: null,
        faIcon: 'fa-file-pdf',
        seoTitle: 'OpenVibePDF — Online PDF Tools',
        seoDescription: 'All the PDF tools you need in one place. Merge, split, compress, convert, rotate, watermark and more — online.',
    },

    // ── PDF Manipulation ─────────────────────────────────────
    'mergepdf.openvibe.tools': {
        toolId: 'merge', brandName: 'MergePDF', defaultOp: 'merge',
        faIcon: 'fa-object-group',
        seoTitle: 'MergePDF — Combine PDF Files Online',
        seoDescription: 'Merge multiple PDF files into one document. Drag and drop to reorder pages. Fast, no sign-up required.',
    },
    'splitpdf.openvibe.tools': {
        toolId: 'split', brandName: 'SplitPDF', defaultOp: 'split',
        faIcon: 'fa-scissors',
        seoTitle: 'SplitPDF — Split PDF Files Online',
        seoDescription: 'Split a PDF into multiple files by page range or extract individual pages. Online PDF splitter.',
    },
    'compresspdf.openvibe.tools': {
        toolId: 'compress', brandName: 'CompressPDF', defaultOp: 'compress',
        faIcon: 'fa-compress',
        seoTitle: 'CompressPDF — Compress PDF Files Online',
        seoDescription: 'Reduce PDF file size while maintaining quality. Compress PDFs for email, web, or storage. Online.',
    },
    'rotatepdf.openvibe.tools': {
        toolId: 'rotate', brandName: 'RotatePDF', defaultOp: 'rotate',
        faIcon: 'fa-rotate',
        seoTitle: 'RotatePDF — Rotate PDF Pages Online',
        seoDescription: 'Rotate individual pages or entire PDFs by 90°, 180°, or 270°. Fix upside-down or sideways scans. Online.',
    },
    'reorderpdf.openvibe.tools': {
        toolId: 'reorder', brandName: 'ReorderPDF', defaultOp: 'reorder',
        faIcon: 'fa-sort',
        seoTitle: 'ReorderPDF — Rearrange PDF Pages Online',
        seoDescription: 'Drag and drop to reorder pages in your PDF. Remove unwanted pages. Online PDF page organizer.',
    },
    'watermarkpdf.openvibe.tools': {
        toolId: 'watermark', brandName: 'WatermarkPDF', defaultOp: 'watermark',
        faIcon: 'fa-stamp',
        seoTitle: 'WatermarkPDF — Add Watermarks to PDFs Online',
        seoDescription: 'Add text or image watermarks to PDF documents. Customize position, opacity, rotation, and font. Online.',
    },
    'protectpdf.openvibe.tools': {
        toolId: 'protect', brandName: 'ProtectPDF', defaultOp: 'protect',
        faIcon: 'fa-lock',
        seoTitle: 'ProtectPDF — Password Protect PDFs Online',
        seoDescription: 'Add password protection to your PDF files. Set owner and user passwords. Online PDF encryption.',
    },
    'unlockpdf.openvibe.tools': {
        toolId: 'unlock', brandName: 'UnlockPDF', defaultOp: 'unlock',
        faIcon: 'fa-lock-open',
        seoTitle: 'UnlockPDF — Remove PDF Password Online',
        seoDescription: 'Remove password protection from PDFs. Unlock PDF files for editing and printing. Online.',
    },

    // ── Image ↔ PDF Conversion ───────────────────────────────
    'image2pdf.openvibe.tools': {
        toolId: 'img2pdf', brandName: 'Image2PDF', defaultOp: 'img2pdf',
        faIcon: 'fa-file-image',
        seoTitle: 'Image2PDF — Convert Images to PDF Online',
        seoDescription: 'Convert JPG, PNG, WebP, AVIF, TIFF, BMP, GIF images to PDF documents. Combine multiple images into one PDF.',
    },
    'jpg2pdf.openvibe.tools': {
        toolId: 'img2pdf', brandName: 'JPG2PDF', defaultOp: 'img2pdf',
        faIcon: 'fa-file-image',
        seoTitle: 'JPG2PDF — Convert JPG to PDF Online',
        seoDescription: 'Convert JPG and JPEG images to PDF documents. Combine multiple JPGs into one PDF file. And fast.',
    },
    'png2pdf.openvibe.tools': {
        toolId: 'img2pdf', brandName: 'PNG2PDF', defaultOp: 'img2pdf',
        faIcon: 'fa-file-image',
        seoTitle: 'PNG2PDF — Convert PNG to PDF Online',
        seoDescription: 'Convert PNG images to PDF documents. Combine multiple PNGs into one PDF file. And fast.',
    },
    'pdf2jpg.openvibe.tools': {
        toolId: 'pdf2img', brandName: 'PDF2JPG', defaultOp: 'pdf2img', defaultFormat: 'jpg',
        faIcon: 'fa-image',
        seoTitle: 'PDF2JPG — Convert PDF to JPG Online',
        seoDescription: 'Convert PDF pages to JPG images. Extract high-quality JPG images from any PDF document. Online.',
    },
    'pdf2png.openvibe.tools': {
        toolId: 'pdf2img', brandName: 'PDF2PNG', defaultOp: 'pdf2img', defaultFormat: 'png',
        faIcon: 'fa-image',
        seoTitle: 'PDF2PNG — Convert PDF to PNG Online',
        seoDescription: 'Convert PDF pages to PNG images. Extract high-quality transparent PNG images from any PDF. Online.',
    },
};

const DEFAULT_CONTEXT = DOMAIN_MAP['docs.openvibe.tools'];

/**
 * Resolve hostname to subdomain context.
 * @param {string} hostname - e.g. 'mergepdf.openvibe.tools' (no port)
 * @returns {Object} Domain context
 */
function resolveContext(hostname) {
    const host = String(hostname || '').split(':')[0].toLowerCase();
    return DOMAIN_MAP[host] || DEFAULT_CONTEXT;
}

/**
 * Get all registered hostnames (for nginx config / docs).
 */
function getAllHosts() {
    return Object.keys(DOMAIN_MAP);
}

module.exports = { resolveContext, getAllHosts, DOMAIN_MAP };
