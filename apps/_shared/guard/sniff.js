'use strict';
// ═══════════════════════════════════════════════════════════════
// What an upload really is, from its first bytes (never the client's Content-Type or file name), and
// whether a tool's descriptor accepts it (files.accept: media types, `type/*` allowed).
//
// detect(buf) → { mime, ext, also: [equivalent media types] } | null. Text formats a demuxer would
// follow (HLS playlists, ffconcat lists, SDP) are never detected as media, so they never pass.
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');

const HEAD_BYTES = 4096;

const EQUIV = {
    'image/png': [], 'image/gif': [], 'image/webp': [], 'image/avif': [], 'image/tiff': [], 'image/svg+xml': [],
    'image/jpeg': ['image/jpg', 'image/pjpeg'],
    'image/bmp': ['image/x-bmp', 'image/x-ms-bmp'],
    'image/x-icon': ['image/vnd.microsoft.icon', 'image/ico'],
    'image/heic': ['image/heif', 'image/heic-sequence', 'image/heif-sequence'],
    'image/heif': ['image/heic'],
    'application/pdf': ['application/x-pdf'],
    'audio/mpeg': ['audio/mp3', 'audio/mpeg3', 'audio/x-mpeg'],
    'audio/wav': ['audio/x-wav', 'audio/wave', 'audio/vnd.wave'],
    'audio/flac': ['audio/x-flac'],
    'audio/ogg': ['application/ogg', 'audio/vorbis', 'video/ogg'],
    'audio/opus': ['audio/ogg', 'application/ogg'],
    'audio/aac': ['audio/x-aac', 'audio/aacp'],
    'audio/mp4': ['audio/x-m4a', 'audio/m4a', 'video/mp4'],
    'video/mp4': ['audio/mp4', 'audio/x-m4a'],
    'video/quicktime': ['video/mp4'],
    'video/3gpp': ['audio/3gpp', 'video/mp4'],
    'audio/x-ms-wma': ['video/x-ms-asf', 'audio/x-ms-asf', 'video/x-ms-wmv'],
    'audio/aiff': ['audio/x-aiff'],
    'audio/ac3': ['audio/x-ac3'],
    'audio/amr': [],
    'video/webm': ['audio/webm', 'video/x-matroska'],
    'video/x-matroska': ['video/webm', 'audio/webm', 'audio/x-matroska'],
    'video/x-msvideo': ['video/avi', 'video/msvideo'],
    'video/x-flv': [],
};

const EXT = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/tiff': 'tiff',
    'image/bmp': 'bmp', 'image/x-icon': 'ico', 'image/heic': 'heic', 'image/heif': 'heif', 'image/svg+xml': 'svg',
    'application/pdf': 'pdf',
    'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/flac': 'flac', 'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/aac': 'aac',
    'audio/mp4': 'm4a', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/3gpp': '3gp', 'audio/x-ms-wma': 'wma',
    'audio/aiff': 'aiff', 'audio/ac3': 'ac3', 'audio/amr': 'amr', 'video/webm': 'webm', 'video/x-matroska': 'mkv',
    'video/x-msvideo': 'avi', 'video/x-flv': 'flv',
};

// File name extensions that plausibly go with each type. An upload whose name says something else
// (song.m3u8 holding MP3 bytes) is renamed to the canonical extension, because some tools derive the
// output format from the input's extension and ffmpeg takes extensions as hints.
const FITTING = {
    'image/jpeg': ['jpg', 'jpeg', 'jpe', 'jfif'], 'image/tiff': ['tif', 'tiff'], 'image/bmp': ['bmp', 'dib'], 'image/x-icon': ['ico'],
    'image/heic': ['heic', 'heif', 'hif'], 'image/heif': ['heif', 'heic', 'hif'],
    'audio/mpeg': ['mp3', 'mpga', 'mp2'], 'audio/wav': ['wav', 'wave'], 'audio/ogg': ['ogg', 'oga', 'ogv', 'opus', 'spx'],
    'audio/opus': ['opus', 'ogg', 'oga'], 'audio/aac': ['aac', 'adts'], 'audio/mp4': ['m4a', 'm4b', 'm4p', 'm4r', 'mp4'],
    'video/mp4': ['mp4', 'm4a', 'm4v', 'm4b', 'm4r', 'mov'], 'video/quicktime': ['mov', 'qt', 'mp4', 'm4a'], 'video/3gpp': ['3gp', '3g2', '3gpp'],
    'audio/x-ms-wma': ['wma', 'wmv', 'asf'], 'audio/aiff': ['aiff', 'aif', 'aifc'], 'video/webm': ['webm', 'weba', 'mkv'],
    'video/x-matroska': ['mkv', 'mka', 'webm'],
};

/** Is `name`'s extension one that fits the detected type? */
function extFits(name, detected) {
    const ext = String(name || '').toLowerCase().match(/\.([a-z0-9]{1,8})$/);
    if (!ext || !detected) return false;
    return (FITTING[detected.mime] || [detected.ext]).includes(ext[1]);
}

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs']);

const at = (buf, off, str) => buf.length >= off + str.length && buf.toString('latin1', off, off + str.length) === str;
const found = (mime) => ({ mime, ext: EXT[mime], also: EQUIV[mime] || [] });

function ftyp(buf) {
    const size = Math.min(buf.readUInt32BE(0) || 0, buf.length);
    const brands = [buf.toString('latin1', 8, 12)];
    for (let o = 16; o + 4 <= size; o += 4) brands.push(buf.toString('latin1', o, o + 4));
    if (brands.includes('avif') || brands.includes('avis')) return 'image/avif';
    if (brands.some(b => HEIC_BRANDS.has(b))) return 'image/heic';
    if (brands.includes('mif1') || brands.includes('msf1')) return 'image/heif';
    const major = brands[0];
    if (/^M4[ABP] $/.test(major)) return 'audio/mp4';
    if (major === 'qt  ') return 'video/quicktime';
    if (/^3g[p2]/.test(major)) return 'video/3gpp';
    return 'video/mp4';
}

/** Plausible MPEG audio frame header at `o` (layer I–III, a real bitrate and sample rate). */
function mpegFrame(buf, o = 0) {
    if (buf.length < o + 4 || buf[o] !== 0xff || (buf[o + 1] & 0xe0) !== 0xe0) return false;
    const version = (buf[o + 1] >> 3) & 3, layer = (buf[o + 1] >> 1) & 3, bitrate = buf[o + 2] >> 4, rate = (buf[o + 2] >> 2) & 3;
    return version !== 1 && layer !== 0 && bitrate !== 0 && bitrate !== 15 && rate !== 3;
}

function isSvg(buf) {
    let s = buf.toString('utf8', 0, Math.min(buf.length, HEAD_BYTES)).replace(/^﻿/, '').trimStart();
    // An XML declaration, doctype and comments may come before the root element.
    for (let i = 0; i < 20; i++) {
        const m = /^(<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)\s*/i.exec(s);
        if (!m) break;
        s = s.slice(m[0].length);
    }
    return /^<svg[\s>]/i.test(s);
}

/** The media type of the bytes, or null. */
function detect(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
    if (at(buf, 0, '\x89PNG\r\n\x1a\n')) return found('image/png');
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return found('image/jpeg');
    if (at(buf, 0, 'GIF87a') || at(buf, 0, 'GIF89a')) return found('image/gif');
    if (at(buf, 0, 'RIFF') && at(buf, 8, 'WEBP')) return found('image/webp');
    if (at(buf, 0, 'RIFF') && at(buf, 8, 'WAVE')) return found('audio/wav');
    if (at(buf, 0, 'RIFF') && at(buf, 8, 'AVI ')) return found('video/x-msvideo');
    if (at(buf, 0, 'BM') && buf.length >= 18 && [12, 40, 52, 56, 64, 108, 124].includes(buf.readUInt32LE(14))) return found('image/bmp');
    if (at(buf, 0, 'II*\0') || at(buf, 0, 'MM\0*') || at(buf, 0, 'II+\0') || at(buf, 0, 'MM\0+')) return found('image/tiff');
    if (buf.length >= 22 && buf.readUInt16LE(0) === 0 && buf.readUInt16LE(2) === 1 && buf.readUInt16LE(4) > 0 && buf[9] === 0) return found('image/x-icon');
    if (buf.length >= 12 && at(buf, 4, 'ftyp')) return found(ftyp(buf));
    if (buf.indexOf('%PDF-', 0, 'latin1') >= 0 && buf.indexOf('%PDF-', 0, 'latin1') < 1024) return found('application/pdf');
    if (at(buf, 0, 'fLaC')) return found('audio/flac');
    if (at(buf, 0, 'OggS')) return found(buf.indexOf('OpusHead', 0, 'latin1') > 0 && buf.indexOf('OpusHead', 0, 'latin1') < 100 ? 'audio/opus' : 'audio/ogg');
    if (at(buf, 0, 'ID3')) return found('audio/mpeg');
    if (buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0) return found('audio/aac');       // ADTS: sync + layer 00
    if (mpegFrame(buf, 0)) return found('audio/mpeg');
    if (at(buf, 0, '\x30\x26\xb2\x75\x8e\x66\xcf\x11')) return found('audio/x-ms-wma');
    if (at(buf, 0, 'FORM') && (at(buf, 8, 'AIFF') || at(buf, 8, 'AIFC'))) return found('audio/aiff');
    if (buf[0] === 0x0b && buf[1] === 0x77) return found('audio/ac3');
    if (at(buf, 0, '#!AMR')) return found('audio/amr');
    if (at(buf, 0, '\x1a\x45\xdf\xa3')) return found(buf.indexOf('webm', 0, 'latin1') > 0 && buf.indexOf('webm', 0, 'latin1') < 64 ? 'video/webm' : 'video/x-matroska');
    if (at(buf, 0, 'FLV\x01')) return found('video/x-flv');
    if (isSvg(buf)) return found('image/svg+xml');
    return null;
}

/** Does `accept` (media types, type/* allowed) cover what was detected? */
function accepts(accept, detected) {
    if (!detected) return false;
    const list = Array.isArray(accept) ? accept : [];
    return [detected.mime, ...detected.also].some(m => list.includes(m) || list.includes(`${m.split('/')[0]}/*`));
}

/** An accept list for people: 'PNG, JPG, WEBP…' (aliases folded into the type they stand for). */
function describe(accept) {
    const out = [];
    for (const m of Array.isArray(accept) ? accept : []) {
        if (/octet-stream/.test(m)) continue;
        const canon = EXT[m] ? m : Object.keys(EQUIV).find(c => EQUIV[c].includes(m) && EXT[c]);
        const word = (canon ? EXT[canon] : m.split('/')[1].replace(/^(x-|vnd\.)/, '').replace(/\+xml$/, '')).toUpperCase();
        if (!out.includes(word)) out.push(word);
    }
    return out.join(', ');
}

/** The first HEAD_BYTES of an upload (multer memory `buffer` or disk `path`). */
function head(file) {
    if (file.buffer) return file.buffer.subarray(0, HEAD_BYTES);
    if (!file.path) return Buffer.alloc(0);
    const fd = fs.openSync(file.path, 'r');
    try {
        const b = Buffer.alloc(HEAD_BYTES);
        const n = fs.readSync(fd, b, 0, HEAD_BYTES, 0);
        return b.subarray(0, n);
    } finally { fs.closeSync(fd); }
}

module.exports = { detect, accepts, head, extFits, describe, EQUIV, EXT, HEAD_BYTES };
