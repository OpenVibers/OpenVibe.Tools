'use strict';

// ═══════════════════════════════════════════════════════════════
// Audio.OpenVibe — Distortion Tool
// ═══════════════════════════════════════════════════════════════

const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const { tmpFile, probe, getDuration, getMime } = require('./ffmpeg-helper');

/**
 * Apply distortion effect.
 * @param {string} inputPath
 * @param {Object} options
 * @param {number} [options.gain] - Drive amount (1-100, default 20)
 * @param {string} [options.format]
 */
async function distortion(inputPath, options = {}) {
    const gain = Math.max(1, Math.min(100, parseInt(options.gain, 10) || 20));

    const ext = options.format || path.extname(inputPath).slice(1) || 'mp3';
    const outputPath = tmpFile(ext);

    // overdrive filter simulates distortion
    await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .audioFilters(`overdrive=gain=${gain}:colour=${Math.min(gain, 50)}`)
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

module.exports = distortion;
