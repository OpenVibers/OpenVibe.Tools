'use strict';

// ═══════════════════════════════════════════════════════════════
// Audio.OpenVibe — Reverb Tool
// ═══════════════════════════════════════════════════════════════

const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const { tmpFile, probe, getDuration, getMime } = require('./ffmpeg-helper');

/**
 * Add reverb effect.
 * @param {string} inputPath
 * @param {Object} options
 * @param {string} [options.preset] - 'room', 'hall' (default), 'cathedral', 'plate'
 * @param {number} [options.mix] - Wet/dry mix 0-100 (default 50)
 * @param {string} [options.format]
 */
async function reverb(inputPath, options = {}) {
    const preset = String(options.preset || 'hall').toLowerCase();
    const mix = Math.max(0, Math.min(100, parseInt(options.mix, 10) || 50)) / 100;

    const ext = options.format || path.extname(inputPath).slice(1) || 'mp3';
    const outputPath = tmpFile(ext);

    // Simulate reverb using aecho with multiple reflections
    const presets = {
        room:       `aecho=0.8:${mix}:40|60|80:0.4|0.3|0.2`,
        hall:       `aecho=0.8:${mix}:100|200|300|400:0.4|0.3|0.2|0.15`,
        cathedral:  `aecho=0.8:${mix}:200|400|600|800|1000:0.5|0.4|0.35|0.3|0.25`,
        plate:      `aecho=0.8:${mix}:20|40|60:0.5|0.4|0.3`,
    };

    const filter = presets[preset] || presets.hall;

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

module.exports = reverb;
