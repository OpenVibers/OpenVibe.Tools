'use strict';

// ═══════════════════════════════════════════════════════════════
// Audio.OpenVibe — FFmpeg Helper
// Shared utility for running ffmpeg commands via fluent-ffmpeg.
// All tools use this as the processing backbone.
// ═══════════════════════════════════════════════════════════════

const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const config = require('../config');

const tmpDir = path.resolve(config.dataDir, 'tmp');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

/**
 * Generate a temp file path with the given extension.
 */
function tmpFile(ext) {
    return path.join(tmpDir, `${crypto.randomBytes(16).toString('hex')}.${ext}`);
}

/**
 * Probe an audio/video file for metadata.
 * @param {string} filePath
 * @returns {Promise<object>} ffprobe data
 */
function probe(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, data) => {
            if (err) return reject(err);
            resolve(data);
        });
    });
}

/**
 * Get the audio stream info from probed data.
 */
function getAudioStream(probeData) {
    return probeData.streams?.find(s => s.codec_type === 'audio') || null;
}

/**
 * Get duration in seconds from probed data.
 */
function getDuration(probeData) {
    if (probeData.format?.duration) return parseFloat(probeData.format.duration);
    const audio = getAudioStream(probeData);
    if (audio?.duration) return parseFloat(audio.duration);
    return 0;
}

/**
 * Run an ffmpeg command and return a promise.
 * @param {function} buildCmd - fn(ffmpeg) → configured ffmpeg command
 * @returns {Promise<string>} output file path
 */
function runFfmpeg(buildCmd) {
    return new Promise((resolve, reject) => {
        const cmd = buildCmd(ffmpeg);
        let outputPath = null;

        cmd.on('start', (cmdLine) => {
            console.log('[FFmpeg] ' + cmdLine);
        });

        cmd.on('error', (err) => {
            // Clean up output on error
            if (outputPath) try { fs.unlinkSync(outputPath); } catch { /* ok */ }
            reject(new Error(err.message || 'FFmpeg processing failed'));
        });

        cmd.on('end', () => {
            resolve(outputPath);
        });

        // Extract output path from the command's _outputs
        // fluent-ffmpeg sets this when .save() or .output() is called
        const origSave = cmd.save.bind(cmd);
        cmd.save = (outPath) => {
            outputPath = outPath;
            return origSave(outPath);
        };

        // If already has output set, extract it
        if (cmd._outputs && cmd._outputs.length > 0) {
            outputPath = cmd._outputs[0].target;
        }
    });
}

/**
 * Clean up temporary files (best-effort).
 */
function cleanTmp(...paths) {
    for (const p of paths) {
        if (p) try { fs.unlinkSync(p); } catch { /* ok */ }
    }
}

// Format → MIME mapping
const FORMAT_MIME = {
    mp3:  'audio/mpeg',
    wav:  'audio/wav',
    flac: 'audio/flac',
    ogg:  'audio/ogg',
    m4a:  'audio/mp4',
    aac:  'audio/aac',
    opus: 'audio/opus',
    wma:  'audio/x-ms-wma',
    aiff: 'audio/aiff',
    ac3:  'audio/ac3',
    webm: 'audio/webm',
    amr:  'audio/amr',
    png:  'image/png',  // for waveform
};

/**
 * Get MIME type for an audio format.
 */
function getMime(format) {
    return FORMAT_MIME[format] || 'application/octet-stream';
}

module.exports = { tmpFile, probe, getAudioStream, getDuration, runFfmpeg, cleanTmp, getMime, tmpDir };
