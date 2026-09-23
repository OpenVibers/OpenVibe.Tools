'use strict';

// ═══════════════════════════════════════════════════════════════
// Img.OpenVibe — Crop Tool
// Crops images by pixel coordinates or aspect ratio presets.
// ═══════════════════════════════════════════════════════════════

const codec = require('./codec');

const ASPECT_RATIOS = {
    '16:9':  16 / 9,
    '4:3':   4 / 3,
    '1:1':   1,
    '3:2':   3 / 2,
    '21:9':  21 / 9,
    '9:16':  9 / 16,
    '3:4':   3 / 4,
    '2:3':   2 / 3,
};

/**
 * Crop an image buffer.
 * @param {Buffer} inputBuffer - Source image bytes
 * @param {Object} options
 * @param {number}  [options.left]   - Left offset in pixels
 * @param {number}  [options.top]    - Top offset in pixels
 * @param {number}  [options.width]  - Crop width in pixels
 * @param {number}  [options.height] - Crop height in pixels
 * @param {string}  [options.aspect] - Aspect ratio preset (e.g. '16:9', '1:1')
 * @param {string}  [options.gravity='centre'] - Gravity for aspect ratio crops
 * @returns {Promise<{ buffer: Buffer, mime: string, ext: string, crop: Object }>}
 */
async function crop(inputBuffer, options = {}) {
    const img = await codec.open(inputBuffer);   // BMP, ICO and HEIC too
    const metadata = await img.sharp().metadata();
    const fmt = img.format || 'png';

    let left, top, cropW, cropH;

    if (options.aspect && ASPECT_RATIOS[options.aspect]) {
        // Aspect ratio mode — calculate max crop within image
        const ratio = ASPECT_RATIOS[options.aspect];
        const imgRatio = metadata.width / metadata.height;

        if (imgRatio > ratio) {
            // Image is wider than target ratio — constrain by height
            cropH = metadata.height;
            cropW = Math.round(metadata.height * ratio);
        } else {
            // Image is taller — constrain by width
            cropW = metadata.width;
            cropH = Math.round(metadata.width / ratio);
        }

        // Center the crop
        left = Math.round((metadata.width - cropW) / 2);
        top = Math.round((metadata.height - cropH) / 2);
    } else {
        // Manual pixel coordinates
        left = Math.max(0, parseInt(options.left, 10) || 0);
        top = Math.max(0, parseInt(options.top, 10) || 0);
        cropW = parseInt(options.width, 10) || (metadata.width - left);
        cropH = parseInt(options.height, 10) || (metadata.height - top);
    }

    // Clamp to image bounds
    left = Math.max(0, Math.min(left, metadata.width - 1));
    top = Math.max(0, Math.min(top, metadata.height - 1));
    cropW = Math.max(1, Math.min(cropW, metadata.width - left));
    cropH = Math.max(1, Math.min(cropH, metadata.height - top));

    const pipeline = img.sharp().extract({ left, top, width: cropW, height: cropH });

    // Re-encode to same format (a BMP stays a BMP)
    let buffer, mime, ext;
    if (fmt === 'bmp') {
        ({ buffer } = await codec.toBmp(pipeline));
        mime = 'image/bmp'; ext = 'bmp';
    } else {
        ({ mime, ext } = applyFormat(pipeline, fmt));
        buffer = await pipeline.toBuffer();
    }

    return {
        buffer, mime, ext,
        crop: { left, top, width: cropW, height: cropH, original: { width: metadata.width, height: metadata.height } },
    };
}

/** Available aspect ratio presets */
crop.aspects = Object.keys(ASPECT_RATIOS);

function applyFormat(pipeline, fmt) {
    switch (fmt) {
        case 'jpeg': case 'jpg':
            pipeline.jpeg({ quality: 95, mozjpeg: true });
            return { mime: 'image/jpeg', ext: 'jpg' };
        case 'webp':
            pipeline.webp({ quality: 95 });
            return { mime: 'image/webp', ext: 'webp' };
        case 'avif':
            pipeline.avif({ quality: 85 });
            return { mime: 'image/avif', ext: 'avif' };
        case 'tiff':
            pipeline.tiff({ quality: 95 });
            return { mime: 'image/tiff', ext: 'tiff' };
        case 'gif':
            pipeline.gif();
            return { mime: 'image/gif', ext: 'gif' };
        default:
            pipeline.png();
            return { mime: 'image/png', ext: 'png' };
    }
}

module.exports = crop;
