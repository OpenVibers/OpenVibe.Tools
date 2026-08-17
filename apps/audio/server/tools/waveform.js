'use strict';

// ═══════════════════════════════════════════════════════════════
// Audio.OpenVibe — Waveform Generator
// Creates a PNG waveform visualization of an audio file.
// ═══════════════════════════════════════════════════════════════

const ffmpeg = require('fluent-ffmpeg');
const { tmpFile, probe, getDuration } = require('./ffmpeg-helper');

/**
 * Generate a waveform image from audio.
 * @param {string} inputPath
 * @param {Object} options
 * @param {number} [options.width] - Image width (default 1200)
 * @param {number} [options.height] - Image height (default 200)
 * @param {string} [options.color] - Waveform color hex (default '#c0965c')
 * @param {string} [options.bgColor] - Background color hex (default '#1a1a22')
 * @returns {Promise<{ outputPath, mime, ext }>}
 */
async function waveform(inputPath, options = {}) {
    const width = Math.max(200, Math.min(4000, parseInt(options.width, 10) || 1200));
    const height = Math.max(60, Math.min(800, parseInt(options.height, 10) || 200));
    const color = String(options.color || '#c0965c').replace(/[^a-fA-F0-9#]/g, '');
    const bgColor = String(options.bgColor || '#1a1a22').replace(/[^a-fA-F0-9#@]/g, '');

    const outputPath = tmpFile('png');

    await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .complexFilter([
                `[0:a]showwavespic=s=${width}x${height}:colors=${color}:scale=sqrt[wave]`,
            ])
            .outputOptions([
                '-map', '[wave]',
                '-frames:v', '1',
            ])
            .on('error', reject)
            .on('end', resolve)
            .save(outputPath);
    });

    return { outputPath, mime: 'image/png', ext: 'png' };
}

module.exports = waveform;
