'use strict';

// ═══════════════════════════════════════════════════════════════
// Audio.OpenVibe — Bitcrusher / Lo-Fi Effect
// Reduces bit depth and sample rate for retro lo-fi effects.
// ═══════════════════════════════════════════════════════════════

const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const { tmpFile, probe, getDuration, getMime } = require('./ffmpeg-helper');

/**
 * Apply bitcrusher effect.
 * @param {string} inputPath
 * @param {Object} options
 * @param {number} [options.bits] - Bit depth (2-16, default 8)
 * @param {number} [options.sampleRate] - Target sample rate (1000-44100, default 8000)
 * @param {string} [options.format]
 * @returns {Promise<{ outputPath, mime, ext, duration }>}
 */
async function bitcrusher(inputPath, options = {}) {
    const bits = Math.max(2, Math.min(16, parseInt(options.bits, 10) || 8));
    const sampleRate = Math.max(1000, Math.min(44100, parseInt(options.sampleRate, 10) || 8000));

    const ext = options.format || path.extname(inputPath).slice(1) || 'mp3';
    const outputPath = tmpFile(ext);

    // Bitcrusher: reduce sample rate then resample, reduce bits with acrusher
    await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .audioFilters([
                `acrusher=bits=${bits}:mix=1:mode=log:aa=1:samples=${Math.round(44100 / sampleRate)}`,
            ])
            .on('error', reject)
            .on('end', resolve)
            .save(outputPath);
    });

    let duration = 0;
    try {
        const info = await probe(outputPath);
        duration = getDuration(info);
    } catch { /* ok */ }

    return { outputPath, mime: getMime(ext), ext, duration };
}

module.exports = bitcrusher;
