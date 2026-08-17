'use strict';

// ═══════════════════════════════════════════════════════════════
// Audio.OpenVibe — Noise Reduction Tool
// Reduces background noise using FFmpeg filters.
// ═══════════════════════════════════════════════════════════════

const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const { tmpFile, probe, getDuration, getMime } = require('./ffmpeg-helper');

/**
 * Reduce background noise.
 * @param {string} inputPath
 * @param {Object} options
 * @param {string} [options.strength] - 'light', 'medium' (default), 'heavy'
 * @param {string} [options.format]
 * @returns {Promise<{ outputPath, mime, ext, duration }>}
 */
async function noise(inputPath, options = {}) {
    const strength = String(options.strength || 'medium').toLowerCase();

    const ext = options.format || path.extname(inputPath).slice(1) || 'mp3';
    const outputPath = tmpFile(ext);

    // Use a combination of highpass + lowpass + afftdn for noise reduction
    const filters = {
        light:  ['highpass=f=60', 'afftdn=nf=-20'],
        medium: ['highpass=f=80', 'afftdn=nf=-30', 'volume=1.1'],
        heavy:  ['highpass=f=120', 'afftdn=nf=-40', 'lowpass=f=12000', 'volume=1.2'],
    };

    const filterChain = filters[strength] || filters.medium;

    await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .audioFilters(filterChain)
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

module.exports = noise;
