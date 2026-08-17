'use strict';

// ═══════════════════════════════════════════════════════════════
// Audio.OpenVibe — Metadata / ID3 Tag Tool
// Reads and writes audio metadata.
// ═══════════════════════════════════════════════════════════════

const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const { tmpFile, probe, getDuration, getMime } = require('./ffmpeg-helper');

/**
 * Read metadata from audio file.
 * @param {string} inputPath
 * @returns {Promise<object>} metadata
 */
async function readMetadata(inputPath) {
    const info = await probe(inputPath);
    const audio = info.streams?.find(s => s.codec_type === 'audio');
    const tags = info.format?.tags || {};

    return {
        title: tags.title || tags.TITLE || null,
        artist: tags.artist || tags.ARTIST || null,
        album: tags.album || tags.ALBUM || null,
        genre: tags.genre || tags.GENRE || null,
        year: tags.date || tags.DATE || tags.year || tags.YEAR || null,
        track: tags.track || tags.TRACK || null,
        comment: tags.comment || tags.COMMENT || null,
        duration: getDuration(info),
        codec: audio?.codec_name || null,
        sampleRate: audio?.sample_rate || null,
        channels: audio?.channels || null,
        bitRate: info.format?.bit_rate ? Math.round(parseInt(info.format.bit_rate, 10) / 1000) : null,
        fileSize: info.format?.size || null,
    };
}

/**
 * Write metadata to audio file.
 * @param {string} inputPath
 * @param {Object} options
 * @param {string} [options.title]
 * @param {string} [options.artist]
 * @param {string} [options.album]
 * @param {string} [options.genre]
 * @param {string} [options.year]
 * @param {string} [options.track]
 * @param {string} [options.comment]
 * @param {string} [options.format]
 * @returns {Promise<{ outputPath, mime, ext, duration, metadata }>}
 */
async function writeMetadata(inputPath, options = {}) {
    const ext = options.format || path.extname(inputPath).slice(1) || 'mp3';
    const outputPath = tmpFile(ext);

    const metadataArgs = [];
    if (options.title)   metadataArgs.push('-metadata', `title=${options.title}`);
    if (options.artist)  metadataArgs.push('-metadata', `artist=${options.artist}`);
    if (options.album)   metadataArgs.push('-metadata', `album=${options.album}`);
    if (options.genre)   metadataArgs.push('-metadata', `genre=${options.genre}`);
    if (options.year)    metadataArgs.push('-metadata', `date=${options.year}`);
    if (options.track)   metadataArgs.push('-metadata', `track=${options.track}`);
    if (options.comment) metadataArgs.push('-metadata', `comment=${options.comment}`);

    if (metadataArgs.length === 0) throw new Error('No metadata fields specified');

    await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .audioCodec('copy')
            .outputOptions(metadataArgs)
            .on('error', (err) => {
                // Codec copy may fail — retry with re-encode
                ffmpeg(inputPath)
                    .outputOptions(metadataArgs)
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

    const metadata = await readMetadata(outputPath);

    return { outputPath, mime: getMime(ext), ext, duration, metadata };
}

module.exports = { readMetadata, writeMetadata };
