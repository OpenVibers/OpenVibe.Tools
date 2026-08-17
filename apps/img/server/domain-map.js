'use strict';

// ═══════════════════════════════════════════════════════════════
// Img.OpenVibe — Domain → Context Mapping
// One Express server handles all image subdomain hostnames.
// Each hostname maps to a brand name, default tool, and SEO data.
// ═══════════════════════════════════════════════════════════════

const DOMAIN_MAP = {
    // ── Hub ──────────────────────────────────────────────────
    'img.openvibe.tools': {
        toolId: 'hub', brandName: 'Img.OpenVibe', defaultOp: 'convert',
        faIcon: 'fa-images',
        seoTitle: 'Img.OpenVibe — Free Online Image Converter & Tools',
        seoDescription: 'Convert, compress, resize, and crop images online for free. Supports PNG, JPG, WebP, AVIF, HEIC, SVG, GIF, ICO, TIFF, BMP and more.',
    },

    // ── Format-specific ──────────────────────────────────────
    'png.openvibe.tools': {
        toolId: 'png', brandName: 'OpenVibePNG', defaultOp: 'convert', defaultFormat: 'png',
        faIcon: 'fa-file-image',
        seoTitle: 'OpenVibePNG — Convert Images to PNG Online Free',
        seoDescription: 'Convert JPG, WebP, AVIF, HEIC, GIF, BMP, TIFF and more to PNG format online. Free, fast, no sign-up required.',
    },
    'jpg.openvibe.tools': {
        toolId: 'jpg', brandName: 'OpenVibeJPG', defaultOp: 'convert', defaultFormat: 'jpg',
        faIcon: 'fa-file-image',
        seoTitle: 'OpenVibeJPG — Convert Images to JPG Online Free',
        seoDescription: 'Convert PNG, WebP, AVIF, HEIC, GIF, BMP, TIFF and more to JPG format online. Free, fast, no sign-up required.',
    },
    'jpeg.openvibe.tools': {
        toolId: 'jpg', brandName: 'OpenVibeJPG', defaultOp: 'convert', defaultFormat: 'jpg',
        faIcon: 'fa-file-image', alias: 'jpg.openvibe.tools',
        seoTitle: 'OpenVibeJPG — Convert Images to JPEG Online Free',
        seoDescription: 'Convert any image to JPEG format online. Free, fast, no sign-up required.',
    },
    'webp.openvibe.tools': {
        toolId: 'webp', brandName: 'OpenVibeWebP', defaultOp: 'convert', defaultFormat: 'webp',
        faIcon: 'fa-file-image',
        seoTitle: 'OpenVibeWebP — Convert Images to WebP Online Free',
        seoDescription: 'Convert PNG, JPG, AVIF, HEIC, GIF, BMP, TIFF and more to WebP format. Smaller file sizes with great quality.',
    },
    'avif.openvibe.tools': {
        toolId: 'avif', brandName: 'OpenVibeAVIF', defaultOp: 'convert', defaultFormat: 'avif',
        faIcon: 'fa-file-image',
        seoTitle: 'OpenVibeAVIF — Convert Images to AVIF Online Free',
        seoDescription: 'Convert images to AVIF format for superior compression. Supports PNG, JPG, WebP, HEIC, TIFF, BMP, GIF input.',
    },
    'heic.openvibe.tools': {
        toolId: 'heic', brandName: 'OpenVibeHEIC', defaultOp: 'convert', defaultFormat: 'png',
        faIcon: 'fa-file-image',
        seoTitle: 'OpenVibeHEIC — Convert HEIC/HEIF Images Online Free',
        seoDescription: 'Convert HEIC and HEIF photos from iPhone to PNG, JPG, WebP and more. Free, fast, works in your browser.',
    },
    'heif.openvibe.tools': {
        toolId: 'heic', brandName: 'OpenVibeHEIC', defaultOp: 'convert', defaultFormat: 'png',
        faIcon: 'fa-file-image', alias: 'heic.openvibe.tools',
        seoTitle: 'OpenVibeHEIC — Convert HEIF Images Online Free',
        seoDescription: 'Convert HEIF photos to PNG, JPG, WebP and more. Free, fast, works in your browser.',
    },
    'svg.openvibe.tools': {
        toolId: 'svg', brandName: 'OpenVibeSVG', defaultOp: 'convert', defaultFormat: 'png',
        faIcon: 'fa-bezier-curve',
        seoTitle: 'OpenVibeSVG — Convert SVG Images Online Free',
        seoDescription: 'Convert SVG to PNG, JPG, WebP. Convert bitmap images to SVG vector traces. Free online SVG converter.',
    },
    'gif.openvibe.tools': {
        toolId: 'gif', brandName: 'OpenVibeGIF', defaultOp: 'convert', defaultFormat: 'gif',
        faIcon: 'fa-film',
        seoTitle: 'OpenVibeGIF — Convert Images to GIF Online Free',
        seoDescription: 'Convert images to and from GIF format online. Free, fast, no sign-up required.',
    },
    'ico.openvibe.tools': {
        toolId: 'ico', brandName: 'OpenVibeICO', defaultOp: 'convert', defaultFormat: 'ico',
        faIcon: 'fa-icons',
        seoTitle: 'OpenVibeICO — Create ICO Favicons Online Free',
        seoDescription: 'Convert PNG, JPG, SVG images to ICO favicon format. Multi-size ICO generation for websites.',
    },
    'tiff.openvibe.tools': {
        toolId: 'tiff', brandName: 'OpenVibeTIFF', defaultOp: 'convert', defaultFormat: 'tiff',
        faIcon: 'fa-file-image',
        seoTitle: 'OpenVibeTIFF — Convert Images to TIFF Online Free',
        seoDescription: 'Convert PNG, JPG, WebP and more to TIFF format. High-quality lossless conversion for print and archival.',
    },
    'bmp.openvibe.tools': {
        toolId: 'bmp', brandName: 'OpenVibeBMP', defaultOp: 'convert', defaultFormat: 'bmp',
        faIcon: 'fa-file-image',
        seoTitle: 'OpenVibeBMP — Convert Images to BMP Online Free',
        seoDescription: 'Convert images to and from BMP bitmap format online. Free and fast.',
    },

    // ── Utility tools ────────────────────────────────────────
    'compress.openvibe.tools': {
        toolId: 'compress', brandName: 'OpenVibeCompress', defaultOp: 'compress',
        faIcon: 'fa-compress',
        seoTitle: 'OpenVibeCompress — Compress Images Online Free',
        seoDescription: 'Reduce image file size without losing quality. Compress PNG, JPG, WebP, AVIF images online for free.',
    },
    'resize.openvibe.tools': {
        toolId: 'resize', brandName: 'OpenVibeResize', defaultOp: 'resize',
        faIcon: 'fa-up-right-and-down-left-from-center',
        seoTitle: 'OpenVibeResize — Resize Images Online Free',
        seoDescription: 'Resize images to any dimension. Scale by pixels, percentage, or fit mode. Free online image resizer.',
    },
    'crop.openvibe.tools': {
        toolId: 'crop', brandName: 'OpenVibeCrop', defaultOp: 'crop',
        faIcon: 'fa-crop-simple',
        seoTitle: 'OpenVibeCrop — Crop Images Online Free',
        seoDescription: 'Crop images by custom dimensions or preset aspect ratios (16:9, 4:3, 1:1). Free online image cropper.',
    },
    'convert.openvibe.tools': {
        toolId: 'convert', brandName: 'OpenVibeConvert', defaultOp: 'convert',
        faIcon: 'fa-arrows-rotate',
        seoTitle: 'OpenVibeConvert — Convert Image Formats Online Free',
        seoDescription: 'Convert between 14+ image formats: PNG, JPG, WebP, AVIF, HEIC, SVG, GIF, ICO, TIFF, BMP and more.',
    },
    'favicon.openvibe.tools': {
        toolId: 'favicon', brandName: 'OpenVibeFavicon', defaultOp: 'convert', defaultFormat: 'ico',
        faIcon: 'fa-icons',
        seoTitle: 'OpenVibeFavicon — Generate Favicons Online Free',
        seoDescription: 'Create multi-size favicons (ICO, PNG, SVG) from any image. Perfect favicons for your website.',
    },
};

const DEFAULT_CONTEXT = DOMAIN_MAP['img.openvibe.tools'];

/**
 * Resolve hostname to subdomain context.
 * @param {string} hostname - e.g. 'png.openvibe.tools' (no port)
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
