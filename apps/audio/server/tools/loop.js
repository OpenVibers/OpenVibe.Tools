'use strict';

// ═══════════════════════════════════════════════════════════════
// Audio.OpenVibe — Loop Tool
// Loops audio a specified number of times.
// ═══════════════════════════════════════════════════════════════

const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const { tmpFile, probe, getDuration, getMime } = require('./ffmpeg-helper');

/**
 * Loop audio N times.
 * @param {string} inputPath
 * @param {Object} options
 * @param {number} options.count - Number of times to repeat (2-20)
 * @param {string} [options.format]
 * @returns {Promise<{ outputPath, mime, ext, duration }>}
 */
async function loop(inputPath, options = {}) {
    const count = Math.max(2, Math.min(20, parseInt(options.count, 10) || 2));

    const ext = options.format || path.extname(inputPath).slice(1) || 'mp3';
    const outputPath = tmpFile(ext);

    // Use aloop filter: loops the audio (count-1) additional times
    await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .audioFilters(`aloop=loop=${count - 1}:size=2147483647`)
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

module.exports = loop;
