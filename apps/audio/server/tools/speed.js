'use strict';

// ═══════════════════════════════════════════════════════════════
// Audio.OpenVibe — Speed Change Tool
// Changes playback speed (tempo) without changing pitch.
// ═══════════════════════════════════════════════════════════════

const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const { tmpFile, probe, getDuration, getMime } = require('./ffmpeg-helper');

/**
 * Change audio speed/tempo.
 * @param {string} inputPath
 * @param {Object} options
 * @param {number} options.speed - Speed multiplier (0.25 to 4.0, where 1.0 = normal)
 * @param {string} [options.format] - Output format
 * @returns {Promise<{ outputPath, mime, ext, duration }>}
 */
async function speed(inputPath, options = {}) {
    let spd = parseFloat(options.speed) || 1.0;
    spd = Math.max(0.25, Math.min(4.0, spd));
    if (spd === 1.0) throw new Error('Specify a speed other than 1.0x');

    const ext = options.format || path.extname(inputPath).slice(1) || 'mp3';
    const outputPath = tmpFile(ext);

    // atempo filter only accepts 0.5-100.0, so chain multiple for extreme values
    const tempoFilters = buildTempoChain(spd);

    await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .audioFilters(tempoFilters)
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

/**
 * Build atempo filter chain for extreme speed values.
 * atempo accepts 0.5–100.0, so for values < 0.5 we chain multiple.
 */
function buildTempoChain(spd) {
    const filters = [];
    let remaining = spd;

    while (remaining < 0.5) {
        filters.push('atempo=0.5');
        remaining /= 0.5;
    }
    while (remaining > 100.0) {
        filters.push('atempo=100.0');
        remaining /= 100.0;
    }
    filters.push(`atempo=${remaining.toFixed(4)}`);

    return filters;
}

module.exports = speed;
