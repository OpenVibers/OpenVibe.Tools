'use strict';

// ═══════════════════════════════════════════════════════════════
// Img.OpenVibe — Resize Tool
// Resizes images using Sharp with multiple fit modes.
// ═══════════════════════════════════════════════════════════════

const sharp = require('sharp');

const VALID_FITS = ['cover', 'contain', 'fill', 'inside', 'outside'];
const MAX_DIMENSION = 16384; // Sharp max pixel dimension

/**
 * Resize an image buffer.
 * @param {Buffer} inputBuffer - Source image bytes
 * @param {Object} options
 * @param {number}  [options.width]  - Target width in pixels
 * @param {number}  [options.height] - Target height in pixels
 * @param {number}  [options.percentage] - Scale by percentage (overrides w/h)
 * @param {string}  [options.fit='inside'] - Fit mode: cover/contain/fill/inside/outside
 * @param {string}  [options.background='#00000000'] - Background color for contain/fill
 * @param {boolean} [options.withoutEnlargement=true] - Don't upscale beyond original
 * @returns {Promise<{ buffer: Buffer, mime: string, ext: string, dimensions: Object }>}
 */
async function resize(inputBuffer, options = {}) {
    const metadata = await sharp(inputBuffer).metadata();
    const fmt = metadata.format || 'png';

    let width = parseInt(options.width, 10) || null;
    let height = parseInt(options.height, 10) || null;
    const fit = VALID_FITS.includes(options.fit) ? options.fit : 'inside';
    const withoutEnlargement = options.withoutEnlargement !== false;

    // Percentage scaling
    if (options.percentage) {
        const pct = Math.max(1, Math.min(1000, parseFloat(options.percentage)));
        width = Math.round(metadata.width * (pct / 100));
        height = Math.round(metadata.height * (pct / 100));
    }

    // Clamp dimensions
    if (width) width = Math.min(width, MAX_DIMENSION);
    if (height) height = Math.min(height, MAX_DIMENSION);

    if (!width && !height) {
        throw new Error('At least one of width, height, or percentage is required');
    }

    // Parse background color
    let background = { r: 0, g: 0, b: 0, alpha: 0 };
    if (options.background) {
        const hex = String(options.background).replace('#', '');
        if (hex.length >= 6) {
            background = {
                r: parseInt(hex.slice(0, 2), 16),
                g: parseInt(hex.slice(2, 4), 16),
                b: parseInt(hex.slice(4, 6), 16),
                alpha: hex.length >= 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
            };
        }
    }

    let pipeline = sharp(inputBuffer)
        .resize(width, height, { fit, withoutEnlargement, background });

    // Re-encode to same format
    const { mime, ext } = applyFormat(pipeline, fmt);
    const buffer = await pipeline.toBuffer();

    const outMeta = await sharp(buffer).metadata();
    return {
        buffer, mime, ext,
        dimensions: {
            original: { width: metadata.width, height: metadata.height },
            resized: { width: outMeta.width, height: outMeta.height },
        },
    };
}

function applyFormat(pipeline, fmt) {
    switch (fmt) {
        case 'jpeg': case 'jpg':
            pipeline.jpeg({ quality: 90, mozjpeg: true });
            return { mime: 'image/jpeg', ext: 'jpg' };
        case 'webp':
            pipeline.webp({ quality: 90 });
            return { mime: 'image/webp', ext: 'webp' };
        case 'avif':
            pipeline.avif({ quality: 80 });
            return { mime: 'image/avif', ext: 'avif' };
        case 'tiff':
            pipeline.tiff({ quality: 90 });
            return { mime: 'image/tiff', ext: 'tiff' };
        case 'gif':
            pipeline.gif();
            return { mime: 'image/gif', ext: 'gif' };
        default:
            pipeline.png();
            return { mime: 'image/png', ext: 'png' };
    }
}

module.exports = resize;
