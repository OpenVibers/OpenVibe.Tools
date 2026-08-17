'use strict';

// ═══════════════════════════════════════════════════════════════
// Audio.OpenVibe — Silence Removal Tool
// Detects and removes silent sections from audio.
// ═══════════════════════════════════════════════════════════════

const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const { tmpFile, probe, getDuration, getMime } = require('./ffmpeg-helper');

/**
 * Remove silence from audio.
 * @param {string} inputPath
 * @param {Object} options
 * @param {number} [options.threshold] - Silence threshold in dB (default -40)
 * @param {number} [options.minDuration] - Minimum silence duration in seconds to remove (default 0.5)
 * @param {string} [options.format]
 */
async function silence(inputPath, options = {}) {
    const threshold = parseInt(options.threshold, 10) || -40;
    const minDuration = Math.max(0.1, parseFloat(options.minDuration) || 0.5);

    const ext = options.format || path.extname(inputPath).slice(1) || 'mp3';
    const outputPath = tmpFile(ext);

    await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .audioFilters(
                `silenceremove=start_periods=1:start_duration=0:start_threshold=${threshold}dB:` +
                `stop_periods=-1:stop_duration=${minDuration}:stop_threshold=${threshold}dB`
            )
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

module.exports = silence;
