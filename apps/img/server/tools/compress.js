'use strict';

// ═══════════════════════════════════════════════════════════════
// Img.OpenVibe — Compress Tool
// Reduces image file size using format-specific optimization.
// ═══════════════════════════════════════════════════════════════

const codec = require('./codec');

/**
 * Compress an image buffer.
 * Detects input format and applies appropriate compression.
 * @param {Buffer} inputBuffer - Source image bytes
 * @param {Object} options
 * @param {number}  [options.quality=75] - Quality 1-100 (lower = smaller file)
 * @param {string}  [options.inputFormat] - Hint for input format
 * @returns {Promise<{ buffer: Buffer, mime: string, ext: string, savings: Object }>}
 */
async function compress(inputBuffer, options = {}) {
    const quality = Math.max(1, Math.min(100, parseInt(options.quality, 10) || 75));
    const originalSize = inputBuffer.length;

    // Detect input format (BMP, ICO and HEIC are decoded by ./codec; they compress to WebP)
    const img = await codec.open(inputBuffer);
    const fmt = options.inputFormat || img.format || 'png';

    let pipeline = img.sharp();
    let mime, ext;

    switch (fmt) {
        case 'jpeg':
        case 'jpg':
            pipeline = pipeline.jpeg({ quality, mozjpeg: true });
            mime = 'image/jpeg'; ext = 'jpg';
            break;

        case 'png':
            pipeline = pipeline.png({
                quality,
                palette: quality < 90, // enable palette mode for stronger compression
                compressionLevel: 9,
                effort: 10,
            });
            mime = 'image/png'; ext = 'png';
            break;

        case 'webp':
            pipeline = pipeline.webp({ quality, effort: 6 });
            mime = 'image/webp'; ext = 'webp';
            break;

        case 'avif':
            pipeline = pipeline.avif({ quality, effort: 6 });
            mime = 'image/avif'; ext = 'avif';
            break;

        case 'tiff':
            pipeline = pipeline.tiff({ quality, compression: 'lzw' });
            mime = 'image/tiff'; ext = 'tiff';
            break;

        case 'gif':
            pipeline = pipeline.gif({ effort: 10 });
            mime = 'image/gif'; ext = 'gif';
            break;

        default:
            // Fallback: convert to WebP for best compression
            pipeline = pipeline.webp({ quality, effort: 6 });
            mime = 'image/webp'; ext = 'webp';
            break;
    }

    const buffer = await pipeline.toBuffer();
    const compressedSize = buffer.length;
    const savings = {
        originalSize,
        compressedSize,
        savedBytes: originalSize - compressedSize,
        savedPercent: Math.round((1 - compressedSize / originalSize) * 100),
    };

    return { buffer, mime, ext, savings };
}

module.exports = compress;
