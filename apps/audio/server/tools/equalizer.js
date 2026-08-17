'use strict';

// ═══════════════════════════════════════════════════════════════
// Audio.OpenVibe — Equalizer Tool
// Applies EQ presets (bass boost, treble boost, vocal, etc.)
// ═══════════════════════════════════════════════════════════════

const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const { tmpFile, probe, getDuration, getMime } = require('./ffmpeg-helper');

const EQ_PRESETS = {
    bass_boost:    'bass=g=8:f=100,treble=g=-2:f=4000',
    treble_boost:  'treble=g=8:f=4000,bass=g=-2:f=100',
    vocal_boost:   'equalizer=f=1000:t=h:w=500:g=5,equalizer=f=3000:t=h:w=1000:g=3',
    flat:          'equalizer=f=1000:t=h:w=2000:g=0',
    rock:          'bass=g=4:f=100,treble=g=3:f=5000,equalizer=f=400:t=h:w=200:g=-2',
    pop:           'bass=g=2:f=100,treble=g=4:f=4000,equalizer=f=1500:t=h:w=500:g=2',
    jazz:          'bass=g=3:f=80,treble=g=2:f=6000,equalizer=f=500:t=h:w=300:g=1',
    classical:     'treble=g=3:f=6000,equalizer=f=2000:t=h:w=1000:g=1,bass=g=1:f=60',
    electronic:    'bass=g=6:f=80,treble=g=5:f=8000,equalizer=f=400:t=h:w=200:g=-3',
    hip_hop:       'bass=g=8:f=60,equalizer=f=500:t=h:w=300:g=-2,treble=g=2:f=5000',
    podcast:       'equalizer=f=200:t=h:w=100:g=-4,equalizer=f=2500:t=h:w=1000:g=4,highpass=f=80',
    telephone:     'highpass=f=300,lowpass=f=3400',
};

/**
 * Apply EQ preset to audio.
 * @param {string} inputPath
 * @param {Object} options
 * @param {string} options.preset - EQ preset name
 * @param {string} [options.format]
 * @returns {Promise<{ outputPath, mime, ext, duration }>}
 */
async function equalizer(inputPath, options = {}) {
    const preset = String(options.preset || 'bass_boost').toLowerCase().replace(/[\s-]/g, '_');
    const filterStr = EQ_PRESETS[preset];
    if (!filterStr) throw new Error(`Unknown EQ preset: ${options.preset}. Available: ${Object.keys(EQ_PRESETS).join(', ')}`);

    const ext = options.format || path.extname(inputPath).slice(1) || 'mp3';
    const outputPath = tmpFile(ext);

    await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .audioFilters(filterStr.split(','))
            .on('error', reject)
            .on('end', resolve)
            .save(outputPath);
    });

    let duration = 0;
    try {
        const info = await probe(outputPath);
        duration = getDuration(info);
    } catch { /* ok */ }

    return { outputPath, mime: getMime(ext), ext, duration, preset };
}

equalizer.presets = Object.keys(EQ_PRESETS);

module.exports = equalizer;
