'use strict';

// ═══════════════════════════════════════════════════════════════
// Audio.OpenVibe — Ringtone Creator
// Trims audio and exports as M4R (iPhone) or MP3 (Android).
// ═══════════════════════════════════════════════════════════════

const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const { tmpFile, probe, getDuration, getMime } = require('./ffmpeg-helper');

/**
 * Create a ringtone from audio.
 * @param {string} inputPath
 * @param {Object} options
 * @param {string|number} [options.start] - Start time
 * @param {string|number} [options.end] - End time (max 40s for iPhone, 30s is ideal)
 * @param {string} [options.device] - 'iphone' for M4R, 'android' for MP3
 * @param {number} [options.fadeIn] - Fade in seconds
 * @param {number} [options.fadeOut] - Fade out seconds
 * @returns {Promise<{ outputPath, mime, ext, duration }>}
 */
async function ringtone(inputPath, options = {}) {
    const device = String(options.device || 'iphone').toLowerCase();
    const isIphone = device === 'iphone' || device === 'm4r';

    const ext = isIphone ? 'm4r' : 'mp3';
    const codec = isIphone ? 'aac' : 'libmp3lame';
    const mime = isIphone ? 'audio/x-m4r' : 'audio/mpeg';

    const inputInfo = await probe(inputPath);
    const totalDuration = getDuration(inputInfo);

    const start = parseTime(options.start) || 0;
    let end = parseTime(options.end) || Math.min(totalDuration, start + 30);
    // Cap at 40s for iPhone
    if (isIphone && (end - start) > 40) end = start + 40;
    if ((end - start) > 60) end = start + 60;

    const fadeIn = parseFloat(options.fadeIn) || 0;
    const fadeOut = parseFloat(options.fadeOut) || 0.5; // default light fade out for ringtones

    const outputPath = tmpFile(ext);

    const filters = [];
    if (fadeIn > 0) filters.push(`afade=t=in:st=0:d=${fadeIn}`);
    if (fadeOut > 0) {
        const dur = end - start;
        filters.push(`afade=t=out:st=${Math.max(0, dur - fadeOut)}:d=${fadeOut}`);
    }

    await new Promise((resolve, reject) => {
        let cmd = ffmpeg(inputPath)
            .setStartTime(start)
            .setDuration(end - start)
            .audioCodec(codec)
            .audioBitrate(isIphone ? 256 : 192);

        if (filters.length > 0) {
            cmd = cmd.audioFilters(filters);
        }

        if (isIphone) {
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

    return { outputPath, mime, ext, duration };
}

function parseTime(val) {
    if (val == null || val === '') return null;
    if (typeof val === 'number') return val;
    const str = String(val).trim();
    if (/^\d+(\.\d+)?$/.test(str)) return parseFloat(str);
    const parts = str.split(':').map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parseFloat(str) || null;
}

module.exports = ringtone;
