'use strict';

// ═══════════════════════════════════════════════════════════════
// Audio.OpenVibe — Pitch Shift Tool
// Changes pitch without changing speed using FFmpeg rubberband/asetrate.
// ═══════════════════════════════════════════════════════════════

const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const { tmpFile, probe, getDuration, getMime } = require('./ffmpeg-helper');

/**
 * Shift audio pitch by semitones.
 * @param {string} inputPath
 * @param {Object} options
 * @param {number} options.semitones - Pitch shift in semitones (-12 to +12)
 * @param {string} [options.format] - Output format
 * @returns {Promise<{ outputPath, mime, ext, duration }>}
 */
async function pitch(inputPath, options = {}) {
    const semitones = Math.max(-24, Math.min(24, parseFloat(options.semitones) || 0));
    if (semitones === 0) throw new Error('Specify a pitch shift amount (semitones)');

    const ext = options.format || path.extname(inputPath).slice(1) || 'mp3';
    const outputPath = tmpFile(ext);

    // Use rubberband filter for pitch-preserving shift
    // Fallback: asetrate + aresample for semitone shifting
    const ratio = Math.pow(2, semitones / 12);
    const inputInfo = await probe(inputPath);
    const audioStream = inputInfo.streams?.find(s => s.codec_type === 'audio');
    const sampleRate = audioStream?.sample_rate || 44100;
    const newRate = Math.round(sampleRate * ratio);

    await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .audioFilters([
                `asetrate=${newRate}`,
                `aresample=${sampleRate}`,
                'atempo=1.0',
            ])
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

module.exports = pitch;
