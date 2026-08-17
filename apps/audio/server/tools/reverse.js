'use strict';

// ═══════════════════════════════════════════════════════════════
// Audio.OpenVibe — Reverse Tool
// Reverses audio playback.
// ═══════════════════════════════════════════════════════════════

const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const { tmpFile, probe, getDuration, getMime } = require('./ffmpeg-helper');

/**
 * Reverse audio.
 * @param {string} inputPath
 * @param {Object} options
 * @param {string} [options.format] - Output format
 * @returns {Promise<{ outputPath, mime, ext, duration }>}
 */
async function reverse(inputPath, options = {}) {
    const ext = options.format || path.extname(inputPath).slice(1) || 'mp3';
    const outputPath = tmpFile(ext);

    await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .audioFilters('areverse')
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

module.exports = reverse;
