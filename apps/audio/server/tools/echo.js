'use strict';

// ═══════════════════════════════════════════════════════════════
// Audio.OpenVibe — Echo / Delay Tool
// ═══════════════════════════════════════════════════════════════

const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const { tmpFile, probe, getDuration, getMime } = require('./ffmpeg-helper');

/**
 * Add echo/delay effect.
 * @param {string} inputPath
 * @param {Object} options
 * @param {number} [options.delay] - Delay in ms (50-2000, default 250)
 * @param {number} [options.decay] - Decay factor (0.1-0.9, default 0.5)
 * @param {number} [options.repeats] - Number of echoes (1-10, default 3)
 * @param {string} [options.format]
 */
async function echo(inputPath, options = {}) {
    const delay = Math.max(50, Math.min(2000, parseInt(options.delay, 10) || 250));
    const decay = Math.max(0.1, Math.min(0.9, parseFloat(options.decay) || 0.5));
    const repeats = Math.max(1, Math.min(10, parseInt(options.repeats, 10) || 3));

    const ext = options.format || path.extname(inputPath).slice(1) || 'mp3';
    const outputPath = tmpFile(ext);

    // Build echo delays and decays
    const delays = [];
    const decays = [];
    for (let i = 1; i <= repeats; i++) {
        delays.push(delay * i);
        decays.push(Math.pow(decay, i).toFixed(2));
    }

    await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .audioFilters(`aecho=0.8:0.88:${delays.join('|')}:${decays.join('|')}`)
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

module.exports = echo;
