'use strict';

// ═══════════════════════════════════════════════════════════════
// Audio.OpenVibe — Dynamic Range Compressor
// ═══════════════════════════════════════════════════════════════

const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const { tmpFile, probe, getDuration, getMime } = require('./ffmpeg-helper');

/**
 * Apply dynamic range compression.
 * @param {string} inputPath
 * @param {Object} options
 * @param {string} [options.preset] - 'light', 'medium' (default), 'heavy', 'broadcast'
 * @param {string} [options.format]
 */
async function compressor(inputPath, options = {}) {
    const preset = String(options.preset || 'medium').toLowerCase();

    const ext = options.format || path.extname(inputPath).slice(1) || 'mp3';
    const outputPath = tmpFile(ext);

    const presets = {
        light:     'acompressor=threshold=-25dB:ratio=2:attack=20:release=200',
        medium:    'acompressor=threshold=-20dB:ratio=4:attack=10:release=100',
        heavy:     'acompressor=threshold=-15dB:ratio=8:attack=5:release=50',
        broadcast: 'acompressor=threshold=-18dB:ratio=6:attack=5:release=80,loudnorm=I=-16:TP=-1.5:LRA=7',
    };

    const filter = presets[preset] || presets.medium;

    await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .audioFilters(filter.split(','))
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

module.exports = compressor;
