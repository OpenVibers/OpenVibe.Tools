'use strict';

// ═══════════════════════════════════════════════════════════════
// Img.OpenVibe — Format Conversion Tool
// Converts images between formats using Sharp. BMP is written by ./codec (sharp cannot);
// ICO output uses to-ico for multi-size favicon generation.
// ═══════════════════════════════════════════════════════════════

const sharp = require('sharp');
const toIco = require('to-ico');
const codec = require('./codec');

const ICO_SIZES = [16, 32, 48, 64, 128, 256];
const CLEAR = { r: 0, g: 0, b: 0, alpha: 0 };

// Supported output formats and their Sharp method / mime
const FORMAT_CONFIG = {
    png:  { method: 'png',  mime: 'image/png',  ext: 'png' },
    jpg:  { method: 'jpeg', mime: 'image/jpeg', ext: 'jpg' },
    jpeg: { method: 'jpeg', mime: 'image/jpeg', ext: 'jpg' },
    webp: { method: 'webp', mime: 'image/webp', ext: 'webp' },
    avif: { method: 'avif', mime: 'image/avif', ext: 'avif' },
    tiff: { method: 'tiff', mime: 'image/tiff', ext: 'tiff' },
    bmp:  { method: null,   mime: 'image/bmp',  ext: 'bmp', custom: true },
    gif:  { method: 'gif',  mime: 'image/gif',  ext: 'gif' },
    ico:  { method: null,   mime: 'image/x-icon', ext: 'ico', custom: true },
};

/**
 * Convert an image buffer to the target format.
 * @param {Buffer} inputBuffer - Source image bytes
 * @param {Object} options
 * @param {string} options.format - Target format (png, jpg, webp, avif, tiff, bmp, gif, ico)
 * @param {number} [options.quality] - Quality 1-100 (for lossy formats)
 * @returns {Promise<{ buffer: Buffer, mime: string, ext: string }>}
 */
async function convert(inputBuffer, options = {}) {
    const format = String(options.format || 'png').toLowerCase();
    const cfg = FORMAT_CONFIG[format];
    if (!cfg) throw new Error(`Unsupported output format: ${format}`);

    const quality = Math.max(1, Math.min(100, parseInt(options.quality, 10) || 80));
    const img = await codec.open(inputBuffer);   // decoded once (BMP, ICO and HEIC included)

    // ── ICO (multi-size favicon) ─────────────────────────────
    // One decode, scaled once to the largest icon size; the smaller sizes come from those
    // 256×256 pixels one after another (not six full decodes of the upload in parallel).
    if (format === 'ico') {
        const base = await img.sharp()
            .resize(256, 256, { fit: 'contain', background: CLEAR })
            .ensureAlpha().raw({ depth: 'uchar' })
            .toBuffer({ resolveWithObject: true });
        const raw = { width: base.info.width, height: base.info.height, channels: base.info.channels };
        const pngs = [];
        for (const s of ICO_SIZES) {
            pngs.push(await sharp(base.data, { raw }).resize(s, s, { fit: 'contain', background: CLEAR }).png().toBuffer());
        }
        const icoBuffer = await toIco(pngs);
        return { buffer: Buffer.from(icoBuffer), mime: cfg.mime, ext: cfg.ext };
    }

    // ── BMP (sharp decodes, ./codec writes the file) ────────
    if (format === 'bmp') {
        const { buffer } = await codec.toBmp(img.sharp());
        return { buffer, mime: cfg.mime, ext: cfg.ext };
    }

    // ── Standard Sharp formats ───────────────────────────────
    let pipeline = img.sharp();

    const methodOpts = {};
    if (['jpeg', 'webp', 'avif'].includes(cfg.method)) {
        methodOpts.quality = quality;
    }
    if (cfg.method === 'png') {
        methodOpts.compressionLevel = Math.round(9 - (quality / 100) * 9); // 0-9 (0=fastest)
    }

    pipeline = pipeline[cfg.method](methodOpts);
    const buffer = await pipeline.toBuffer();

    return { buffer, mime: cfg.mime, ext: cfg.ext };
}

/** Get supported output formats */
convert.formats = Object.keys(FORMAT_CONFIG);

module.exports = convert;
