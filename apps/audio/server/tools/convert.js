'use strict';

// ═══════════════════════════════════════════════════════════════
// Audio.OpenVibe — Format Conversion Tool
// Converts audio between formats using FFmpeg.
// ═══════════════════════════════════════════════════════════════

const ffmpeg = require('fluent-ffmpeg');
const { tmpFile, probe, getDuration, getMime, cleanTmp } = require('./ffmpeg-helper');

// Format → ffmpeg output options
const FORMAT_CONFIG = {
    mp3:  { ext: 'mp3',  codec: 'libmp3lame', extraArgs: [] },
    wav:  { ext: 'wav',  codec: 'pcm_s16le',  extraArgs: [] },
    flac: { ext: 'flac', codec: 'flac',       extraArgs: [] },
    ogg:  { ext: 'ogg',  codec: 'libvorbis',  extraArgs: [] },
    m4a:  { ext: 'm4a',  codec: 'aac',        extraArgs: ['-movflags', '+faststart'] },
    aac:  { ext: 'aac',  codec: 'aac',        extraArgs: [] },
    opus: { ext: 'opus', codec: 'libopus',    extraArgs: [] },
    wma:  { ext: 'wma',  codec: 'wmav2',      extraArgs: [] },
    aiff: { ext: 'aiff', codec: 'pcm_s16be',  extraArgs: [] },
    ac3:  { ext: 'ac3',  codec: 'ac3',        extraArgs: [] },
    webm: { ext: 'webm', codec: 'libopus',    extraArgs: [] },
};

/**
 * Convert audio to the target format.
 * @param {string} inputPath - Path to source audio file
 * @param {Object} options
 * @param {string} options.format - Target format (mp3, wav, flac, ogg, m4a, etc.)
 * @param {number} [options.bitrate] - Bitrate in kbps (for lossy formats)
 * @param {number} [options.sampleRate] - Sample rate in Hz
 * @param {number} [options.channels] - Number of channels (1=mono, 2=stereo)
 * @returns {Promise<{ outputPath: string, mime: string, ext: string, duration: number }>}
 */
async function convert(inputPath, options = {}) {
    const format = String(options.format || 'mp3').toLowerCase();
    const cfg = FORMAT_CONFIG[format];
    if (!cfg) throw new Error(`Unsupported output format: ${format}`);

    const bitrate = parseInt(options.bitrate, 10) || 192;
    const sampleRate = parseInt(options.sampleRate, 10) || 0;
    const channels = parseInt(options.channels, 10) || 0;

    const outputPath = tmpFile(cfg.ext);

    await new Promise((resolve, reject) => {
        let cmd = ffmpeg(inputPath)
            .noVideo()
            .audioCodec(cfg.codec);

        // Apply bitrate for lossy formats
        if (['mp3', 'ogg', 'm4a', 'aac', 'opus', 'wma', 'ac3', 'webm'].includes(format)) {
            cmd = cmd.audioBitrate(bitrate);
        }

        // Apply sample rate if specified
        if (sampleRate > 0) {
            cmd = cmd.audioFrequency(sampleRate);
        }

        // Apply channel count if specified
        if (channels > 0) {
            cmd = cmd.audioChannels(channels);
        }

        // Extra format-specific args
        for (const arg of cfg.extraArgs) {
            cmd = cmd.outputOption(arg);
        }

        cmd.on('error', reject)
           .on('end', resolve)
           .save(outputPath);
    });

    // Probe output for metadata
    let duration = 0;
    try {
        const info = await probe(outputPath);
        duration = getDuration(info);
    } catch { /* ok */ }

    return {
        outputPath,
        mime: getMime(cfg.ext),
        ext: cfg.ext,
        duration,
    };
}

convert.formats = Object.keys(FORMAT_CONFIG);

module.exports = convert;
