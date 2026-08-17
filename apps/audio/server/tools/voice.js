'use strict';

// ═══════════════════════════════════════════════════════════════
// Audio.OpenVibe — Voice Effects / Voice Changer
// Applies fun voice transformations (chipmunk, deep, robot, etc.)
// ═══════════════════════════════════════════════════════════════

const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const { tmpFile, probe, getDuration, getMime } = require('./ffmpeg-helper');

const VOICE_PRESETS = {
    chipmunk: {
        label: 'Chipmunk',
        filters: 'asetrate=65536,aresample=44100,atempo=0.75',
    },
    deep: {
        label: 'Deep Voice',
        filters: 'asetrate=32000,aresample=44100,atempo=1.4',
    },
    robot: {
        label: 'Robot',
        filters: 'afftfilt=real=\'hypot(re,im)*cos(0)\':imag=\'hypot(re,im)*sin(0)\':win_size=512:overlap=0.75',
    },
    echo: {
        label: 'Echo',
        filters: 'aecho=0.8:0.88:60:0.4',
    },
    cave: {
        label: 'Cave',
        filters: 'aecho=0.8:0.9:500|1000:0.3|0.2',
    },
    radio: {
        label: 'Radio',
        filters: 'highpass=f=300,lowpass=f=3400,acompressor=threshold=-20dB:ratio=6:attack=1:release=50',
    },
    underwater: {
        label: 'Underwater',
        filters: 'lowpass=f=500,aecho=0.8:0.7:100:0.5',
    },
    whisper: {
        label: 'Whisper',
        filters: 'highpass=f=1000,volume=0.5,aecho=0.6:0.3:20:0.2',
    },
    megaphone: {
        label: 'Megaphone',
        filters: 'highpass=f=500,lowpass=f=4000,acompressor=threshold=-15dB:ratio=8:attack=1:release=30,volume=1.5',
    },
    demon: {
        label: 'Demon',
        filters: 'asetrate=28000,aresample=44100,aecho=0.8:0.5:300:0.4,atempo=1.5',
    },
};

/**
 * Apply voice effect preset.
 * @param {string} inputPath
 * @param {Object} options
 * @param {string} options.preset - Voice preset name
 * @param {string} [options.format]
 * @returns {Promise<{ outputPath, mime, ext, duration }>}
 */
async function voice(inputPath, options = {}) {
    const presetName = String(options.preset || 'chipmunk').toLowerCase().replace(/[\s-]/g, '_');
    const preset = VOICE_PRESETS[presetName];
    if (!preset) throw new Error(`Unknown voice preset: ${options.preset}. Available: ${Object.keys(VOICE_PRESETS).join(', ')}`);

    const ext = options.format || path.extname(inputPath).slice(1) || 'mp3';
    const outputPath = tmpFile(ext);

    await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .audioFilters(preset.filters.split(','))
            .on('error', reject)
            .on('end', resolve)
            .save(outputPath);
    });

    let duration = 0;
    try {
        const info = await probe(outputPath);
        duration = getDuration(info);
    } catch { /* ok */ }

    return { outputPath, mime: getMime(ext), ext, duration, preset: presetName };
}

voice.presets = Object.entries(VOICE_PRESETS).map(([k, v]) => ({ id: k, label: v.label }));

module.exports = voice;
