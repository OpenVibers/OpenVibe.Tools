'use strict';

// ═══════════════════════════════════════════════════════════════
// Audio.OpenVibe — Trim / Cut Tool
// Trims audio to a specific time range using FFmpeg.
// ═══════════════════════════════════════════════════════════════

const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const { tmpFile, probe, getDuration, getMime } = require('./ffmpeg-helper');

/**
 * Trim audio to a specified start/end time.
 * @param {string} inputPath
 * @param {Object} options
 * @param {string|number} options.start - Start time (seconds or HH:MM:SS)
 * @param {string|number} options.end - End time (seconds or HH:MM:SS)
 * @param {string} [options.format] - Output format (defaults to input format)
 * @returns {Promise<{ outputPath, mime, ext, duration }>}
 */
async function trim(inputPath, options = {}) {
    const inputInfo = await probe(inputPath);
    const totalDuration = getDuration(inputInfo);

    const start = parseTime(options.start) || 0;
    const end = parseTime(options.end) || totalDuration;

    if (start >= end) throw new Error('Start time must be before end time');
    if (start >= totalDuration) throw new Error('Start time exceeds audio duration');

    const ext = options.format || path.extname(inputPath).slice(1) || 'mp3';
    const outputPath = tmpFile(ext);

    await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .setStartTime(start)
            .setDuration(end - start)
            .audioCodec('copy')
            .on('error', (err) => {
                // If codec copy fails (format mismatch), retry with re-encode
                ffmpeg(inputPath)
                    .setStartTime(start)
                    .setDuration(end - start)
                    .on('error', reject)
                    .on('end', resolve)
                    .save(outputPath);
            })
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
 * Parse time input — supports seconds (number) or HH:MM:SS / MM:SS strings.
 */
function parseTime(val) {
    if (val == null || val === '') return null;
    if (typeof val === 'number') return val;
    const str = String(val).trim();

    // Numeric seconds
    if (/^\d+(\.\d+)?$/.test(str)) return parseFloat(str);

    // HH:MM:SS or MM:SS
    const parts = str.split(':').map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parseFloat(str) || null;
}

module.exports = trim;
