'use strict';

// ═══════════════════════════════════════════════════════════════
// Audio.OpenVibe — Bass Boost Tool
// Boosts or reduces low-frequency content.
// ═══════════════════════════════════════════════════════════════

const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const { tmpFile, probe, getDuration, getMime } = require('./ffmpeg-helper');

/**
 * Boost or cut bass frequencies.
 * @param {string} inputPath
 * @param {Object} options
 * @param {number} options.gain - Bass gain in dB (-20 to +20)
 * @param {number} [options.frequency] - Center frequency in Hz (default 100)
 * @param {string} [options.format]
 * @returns {Promise<{ outputPath, mime, ext, duration }>}
 */
async function bass(inputPath, options = {}) {
    const gain = Math.max(-20, Math.min(20, parseFloat(options.gain) || 6));
    const freq = Math.max(20, Math.min(300, parseInt(options.frequency, 10) || 100));

    const ext = options.format || path.extname(inputPath).slice(1) || 'mp3';
    const outputPath = tmpFile(ext);

    await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .audioFilters(`bass=g=${gain}:f=${freq}:w=0.5`)
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

module.exports = bass;
