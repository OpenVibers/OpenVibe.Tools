'use strict';

// ═══════════════════════════════════════════════════════════════
// Audio.OpenVibe — Extract Audio from Video
// Rips audio track from video files.
// ═══════════════════════════════════════════════════════════════

const ffmpeg = require('fluent-ffmpeg');
const { tmpFile, probe, getDuration, getMime } = require('./ffmpeg-helper');

/**
 * Extract audio from a video file.
 * @param {string} inputPath
 * @param {Object} options
 * @param {string} [options.format] - Output format (default mp3)
 * @param {number} [options.bitrate] - Output bitrate in kbps
 * @returns {Promise<{ outputPath, mime, ext, duration }>}
 */
async function extract(inputPath, options = {}) {
    const format = String(options.format || 'mp3').toLowerCase();
    const bitrate = parseInt(options.bitrate, 10) || 192;
    const ext = format;
    const outputPath = tmpFile(ext);

    // Codec mapping
    const codecs = {
        mp3: 'libmp3lame', wav: 'pcm_s16le', flac: 'flac',
        ogg: 'libvorbis', m4a: 'aac', aac: 'aac',
        opus: 'libopus', wma: 'wmav2',
    };
    const codec = codecs[format] || 'libmp3lame';

    await new Promise((resolve, reject) => {
        let cmd = ffmpeg(inputPath)
            .noVideo()
            .audioCodec(codec);

        if (!['wav', 'flac', 'aiff'].includes(format)) {
            cmd = cmd.audioBitrate(bitrate);
        }

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

module.exports = extract;
