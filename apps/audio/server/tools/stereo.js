'use strict';

// ═══════════════════════════════════════════════════════════════
// Audio.OpenVibe — Stereo/Mono Tool
// Converts between stereo/mono and adjusts stereo width.
// ═══════════════════════════════════════════════════════════════

const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const { tmpFile, probe, getDuration, getMime } = require('./ffmpeg-helper');

/**
 * Convert between stereo/mono or adjust stereo width.
 * @param {string} inputPath
 * @param {Object} options
 * @param {string} [options.mode] - 'mono', 'stereo', 'wide', 'narrow'
 * @param {string} [options.format]
 */
async function stereo(inputPath, options = {}) {
    const mode = String(options.mode || 'mono').toLowerCase();

    const ext = options.format || path.extname(inputPath).slice(1) || 'mp3';
    const outputPath = tmpFile(ext);

    const configs = {
        mono:   { channels: 1, filters: [] },
        stereo: { channels: 2, filters: [] },
        wide:   { channels: 2, filters: ['stereotools=mlev=1:slev=2'] },
        narrow: { channels: 2, filters: ['stereotools=mlev=2:slev=0.5'] },
    };

    const cfg = configs[mode] || configs.mono;

    await new Promise((resolve, reject) => {
        let cmd = ffmpeg(inputPath).audioChannels(cfg.channels);
        if (cfg.filters.length > 0) cmd = cmd.audioFilters(cfg.filters);
        cmd.on('error', reject)
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

module.exports = stereo;
