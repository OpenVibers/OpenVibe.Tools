'use strict';

// ═══════════════════════════════════════════════════════════════
// Audio.OpenVibe — Merge (join) Tool
// Joins 2–5 audio files, in the order given, into one file. Every input is resampled to one
// rate and to stereo, so an MP3, a WAV and a FLAC can be joined; the result is re-encoded to
// the chosen format (the same formats and codecs as Convert).
// ═══════════════════════════════════════════════════════════════

const ffmpeg = require('fluent-ffmpeg');
const { tmpFile, probe, getAudioStream, getDuration, getMime } = require('./ffmpeg-helper');
const { FORMAT_CONFIG } = require('./convert');

const MIN_FILES = 2;
const MAX_FILES = 5;                          // the upload limit (middleware/upload.js)
const MAX_TOTAL_SECONDS = 3 * 60 * 60;        // three hours of joined audio
const LOSSY = new Set(['mp3', 'ogg', 'm4a', 'aac', 'opus', 'wma', 'ac3', 'webm']);

function refuse(message) { return Object.assign(new Error(message), { status: 422, expose: true }); }

/**
 * @param {string[]} inputPaths  files in the order they are joined
 * @param {Object} options
 * @param {string} [options.format='mp3']  output format (any Convert format)
 * @param {number} [options.bitrate=192]   kbps, lossy formats only
 * @returns {Promise<{ outputPath, mime, ext, duration, inputs }>}
 */
async function merge(inputPaths, options = {}) {
    const paths = Array.isArray(inputPaths) ? inputPaths : [inputPaths];
    if (paths.length < MIN_FILES) throw refuse(`Upload at least ${MIN_FILES} files to merge.`);
    if (paths.length > MAX_FILES) throw refuse(`At most ${MAX_FILES} files can be merged at once.`);
    const format = String(options.format || 'mp3').toLowerCase();
    const cfg = FORMAT_CONFIG[format];
    if (!cfg) throw refuse(`Unsupported output format: ${format}`);
    const bitrate = Math.min(320, Math.max(32, parseInt(options.bitrate, 10) || 192));

    // Every file must carry audio, and the whole must stay within the length limit.
    let total = 0;
    for (let i = 0; i < paths.length; i++) {
        let info;
        try { info = await probe(paths[i]); } catch { throw refuse(`File ${i + 1} is not an audio or video file ffmpeg can read.`); }
        if (!getAudioStream(info)) throw refuse(`File ${i + 1} has no audio track.`);
        total += getDuration(info) || 0;
    }
    if (total > MAX_TOTAL_SECONDS) throw refuse(`The merged audio would be ${Math.round(total / 60)} minutes long; the limit is ${MAX_TOTAL_SECONDS / 60} minutes.`);

    // Opus only encodes at 48 kHz (and 24/16/12/8); everything else is joined at 44.1 kHz.
    const rate = ['opus', 'webm'].includes(format) ? 48000 : 44100;
    const graph = paths.map((_, i) => `[${i}:a:0]aresample=${rate},aformat=sample_fmts=fltp:sample_rates=${rate}:channel_layouts=stereo[a${i}]`)
        .concat(`${paths.map((_, i) => `[a${i}]`).join('')}concat=n=${paths.length}:v=0:a=1[out]`)
        .join(';');

    const outputPath = tmpFile(cfg.ext);
    await new Promise((resolve, reject) => {
        let cmd = ffmpeg();
        for (const p of paths) cmd = cmd.input(p);
        cmd = cmd.complexFilter(graph, 'out').audioCodec(cfg.codec);
        if (LOSSY.has(format)) cmd = cmd.audioBitrate(bitrate);
        for (const arg of cfg.extraArgs) cmd = cmd.outputOption(arg);
        cmd.on('error', reject).on('end', resolve).save(outputPath);
    });

    let duration = 0;
    try { duration = getDuration(await probe(outputPath)); } catch { /* ok */ }
    return { outputPath, mime: getMime(cfg.ext), ext: cfg.ext, duration, inputs: paths.length };
}

merge.MIN_FILES = MIN_FILES;
merge.MAX_FILES = MAX_FILES;
merge.MAX_TOTAL_SECONDS = MAX_TOTAL_SECONDS;

module.exports = merge;
