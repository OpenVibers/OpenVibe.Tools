'use strict';

// ═══════════════════════════════════════════════════════════════
// Audio.OpenVibe — Chorus Effect Tool
// ═══════════════════════════════════════════════════════════════

const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const { tmpFile, probe, getDuration, getMime } = require('./ffmpeg-helper');

/**
 * Apply chorus effect.
 * @param {string} inputPath
 * @param {Object} options
 * @param {string} [options.intensity] - 'light', 'medium' (default), 'heavy'
 * @param {string} [options.format]
 */
async function chorus(inputPath, options = {}) {
    const intensity = String(options.intensity || 'medium').toLowerCase();

    const ext = options.format || path.extname(inputPath).slice(1) || 'mp3';
    const outputPath = tmpFile(ext);

    const filters = {
        light:  'chorus=0.5:0.9:50|60:0.4|0.32:0.25|0.4:2|2.3',
        medium: 'chorus=0.7:0.9:50|60|70:0.4|0.32|0.28:0.25|0.4|0.35:2|2.3|1.8',
        heavy:  'chorus=0.8:0.9:40|50|60|70|80:0.5|0.4|0.35|0.3|0.25:0.3|0.4|0.35|0.45|0.3:2|2.3|1.8|2.5|1.5',
    };

    const filter = filters[intensity] || filters.medium;

    await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .audioFilters(filter)
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

module.exports = chorus;
