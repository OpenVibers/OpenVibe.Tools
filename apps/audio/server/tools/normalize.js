'use strict';

// ═══════════════════════════════════════════════════════════════
// Audio.OpenVibe — Normalize Tool
// Normalizes audio loudness to a target level.
// ═══════════════════════════════════════════════════════════════

const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const { tmpFile, probe, getDuration, getMime } = require('./ffmpeg-helper');

/**
 * Normalize audio volume.
 * @param {string} inputPath
 * @param {Object} options
 * @param {string} [options.mode] - 'peak' (default), 'loudness' (EBU R128), or 'rms'
 * @param {number} [options.target] - Target level in dB (e.g. -1 for peak, -16 for loudness)
 * @param {string} [options.format]
 * @returns {Promise<{ outputPath, mime, ext, duration }>}
 */
async function normalize(inputPath, options = {}) {
    const mode = options.mode || 'peak';
    const ext = options.format || path.extname(inputPath).slice(1) || 'mp3';
    const outputPath = tmpFile(ext);

    let filters;
    if (mode === 'loudness') {
        // EBU R128 loudness normalization
        const target = parseFloat(options.target) || -16;
        filters = [`loudnorm=I=${target}:TP=-1.5:LRA=11`];
    } else if (mode === 'rms') {
        // Two-pass: probe RMS then adjust
        const target = parseFloat(options.target) || -20;
        // Single-pass approximation using dynaudnorm
        filters = [`dynaudnorm=f=150:g=15:p=${Math.pow(10, target / 20).toFixed(3)}`];
    } else {
        // Peak normalization — just use volume filter with loudnorm
        const target = parseFloat(options.target) || -1;
        filters = [`loudnorm=I=-16:TP=${target}:LRA=11:print_format=summary`];
    }

    await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .audioFilters(filters)
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

module.exports = normalize;
