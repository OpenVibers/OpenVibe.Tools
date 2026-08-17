'use strict';

// ═══════════════════════════════════════════════════════════════
// Audio.OpenVibe — Vocal Remover (Center Channel Extraction)
// Removes or isolates vocals using phase cancellation.
// ═══════════════════════════════════════════════════════════════

const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const { tmpFile, probe, getDuration, getMime } = require('./ffmpeg-helper');

/**
 * Remove or isolate vocals.
 * @param {string} inputPath
 * @param {Object} options
 * @param {string} [options.mode] - 'remove' (karaoke) or 'isolate' (vocals only)
 * @param {string} [options.format]
 */
async function vocal(inputPath, options = {}) {
    const mode = String(options.mode || 'remove').toLowerCase();

    const ext = options.format || path.extname(inputPath).slice(1) || 'mp3';
    const outputPath = tmpFile(ext);

    // Phase cancellation technique: pan center = vocals, sides = instruments
    let filter;
    if (mode === 'isolate') {
        // Extract center channel (vocals)
        filter = 'pan=stereo|c0=c0-c1|c1=c1-c0,acompressor=threshold=-20dB:ratio=4';
        // Actually, flip it — vocals are in-phase center content
        filter = 'stereotools=mlev=1:slev=0,acompressor=threshold=-20dB:ratio=2';
    } else {
        // Remove vocals (keep sides)
        filter = 'pan=stereo|c0=c0-c1|c1=c1-c0';
    }

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

module.exports = vocal;
