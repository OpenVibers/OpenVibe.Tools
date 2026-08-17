'use strict';

// ═══════════════════════════════════════════════════════════════
// Audio.OpenVibe — Podcast Optimizer
// Normalizes loudness, compresses dynamics, converts to podcast format.
// ═══════════════════════════════════════════════════════════════

const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const { tmpFile, probe, getDuration, getMime } = require('./ffmpeg-helper');

/**
 * Optimize audio for podcast publishing.
 * @param {string} inputPath
 * @param {Object} options
 * @param {string} [options.format] - Output format (default mp3)
 * @param {number} [options.bitrate] - Bitrate (default 128 for podcasts)
 * @param {boolean} [options.mono] - Force mono (recommended for speech)
 * @returns {Promise<{ outputPath, mime, ext, duration }>}
 */
async function podcast(inputPath, options = {}) {
    const format = String(options.format || 'mp3').toLowerCase();
    const bitrate = parseInt(options.bitrate, 10) || 128;
    const mono = options.mono !== false; // default true

    const codecs = {
        mp3: 'libmp3lame', m4a: 'aac', ogg: 'libvorbis', opus: 'libopus',
    };
    const codec = codecs[format] || 'libmp3lame';
    const ext = format;
    const outputPath = tmpFile(ext);

    const filters = [
        'highpass=f=80',                   // Remove low rumble
        'lowpass=f=15000',                 // Remove ultra-high
        'loudnorm=I=-16:TP=-1.5:LRA=11',  // EBU R128 normalization (-16 LUFS, podcast standard)
        'acompressor=threshold=-20dB:ratio=4:attack=5:release=50', // Dynamic compression
    ];

    await new Promise((resolve, reject) => {
        let cmd = ffmpeg(inputPath)
            .audioCodec(codec)
            .audioBitrate(bitrate)
            .audioFrequency(44100)
            .audioFilters(filters);

        if (mono) cmd = cmd.audioChannels(1);

        if (format === 'm4a') {
            cmd = cmd.outputOption('-movflags', '+faststart');
        }

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

module.exports = podcast;
