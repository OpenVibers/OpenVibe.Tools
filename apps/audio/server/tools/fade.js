'use strict';

// ═══════════════════════════════════════════════════════════════
// Audio.OpenVibe — Fade In/Out Tool
// Adds fade-in and/or fade-out effects.
// ═══════════════════════════════════════════════════════════════

const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const { tmpFile, probe, getDuration, getMime } = require('./ffmpeg-helper');

/**
 * Add fade in/out to audio.
 * @param {string} inputPath
 * @param {Object} options
 * @param {number} [options.fadeIn] - Fade-in duration in seconds (0 = none)
 * @param {number} [options.fadeOut] - Fade-out duration in seconds (0 = none)
 * @param {string} [options.format]
 * @returns {Promise<{ outputPath, mime, ext, duration }>}
 */
async function fade(inputPath, options = {}) {
    const fadeIn = Math.max(0, parseFloat(options.fadeIn) || 0);
    const fadeOut = Math.max(0, parseFloat(options.fadeOut) || 0);

    if (fadeIn === 0 && fadeOut === 0) throw new Error('Specify a fade-in and/or fade-out duration');

    const inputInfo = await probe(inputPath);
    const totalDuration = getDuration(inputInfo);

    const ext = options.format || path.extname(inputPath).slice(1) || 'mp3';
    const outputPath = tmpFile(ext);

    const filters = [];
    if (fadeIn > 0) {
        filters.push(`afade=t=in:st=0:d=${fadeIn}`);
    }
    if (fadeOut > 0) {
        const fadeOutStart = Math.max(0, totalDuration - fadeOut);
        filters.push(`afade=t=out:st=${fadeOutStart}:d=${fadeOut}`);
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

module.exports = fade;
