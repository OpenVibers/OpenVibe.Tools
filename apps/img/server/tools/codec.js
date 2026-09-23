'use strict';

// ═══════════════════════════════════════════════════════════════
// Img.OpenVibe — the image formats sharp (libvips) cannot handle itself.
//
//   BMP   read and written here, in plain JavaScript: uncompressed 1/4/8/16/24/32-bit, RLE4/RLE8
//         and bitfield files are read; output is 24-bit, or 32-bit with alpha (V4 header,
//         BI_BITFIELDS) when the picture has transparency.
//   ICO   read here: the largest entry, PNG entries as they are, BMP entries through the BMP reader.
//   HEIC  (HEVC-coded HEIF, what iPhones save) decoded by libheif's command-line decoder,
//         heif-dec or heif-convert (packages libheif-examples + libheif-plugin-libde265). Without
//         it a HEIC upload answers 503 tools.unavailable. AVIF and other HEIF files go to sharp.
//
// open(buffer) is the one way the tools read an upload: it decodes once and hands out fresh
// sharp pipelines over the decoded pixels.
// ═══════════════════════════════════════════════════════════════

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { createBinary, Unavailable } = require('../../../_shared/binaries');

// Largest picture read from or written to BMP (and ICO): 100 megapixels, 400 MB of RGBA.
const MAX_PIXELS = 100 * 1024 * 1024;
const HEIF_TIMEOUT_MS = 60_000;

class ImageError extends Error {
    constructor(message) { super(message); this.status = 422; this.expose = true; }
}

// ── Format sniffing ──────────────────────────────────────────

const HEVC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs']);

/** 'bmp' | 'ico' | 'heic' | null (null: let sharp decide). */
function sniff(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
    if (buf[0] === 0x42 && buf[1] === 0x4d && buf.length >= 26) return 'bmp';
    if (buf.toString('latin1', 4, 8) === 'ftyp') {
        const size = Math.min(buf.readUInt32BE(0), buf.length);
        const brands = [buf.toString('latin1', 8, 12)];
        for (let o = 16; o + 4 <= size; o += 4) brands.push(buf.toString('latin1', o, o + 4));
        if (brands.includes('avif') || brands.includes('avis')) return null;
        return brands.some(b => HEVC_BRANDS.has(b)) ? 'heic' : null;
    }
    if (buf.readUInt16LE(0) === 0 && buf.readUInt16LE(2) === 1 && buf.readUInt16LE(4) > 0 && buf.length >= 6 + 16 * buf.readUInt16LE(4)) return 'ico';
    return null;
}

// ── BMP reader ───────────────────────────────────────────────

function maskInfo(mask) {
    if (!mask) return null;
    let shift = 0;
    while (shift < 32 && !((mask >>> shift) & 1)) shift++;
    let bits = 0;
    while (shift + bits < 32 && ((mask >>> (shift + bits)) & 1)) bits++;
    return { mask: mask >>> 0, shift, max: bits >= 32 ? 0xffffffff : (2 ** bits) - 1 };
}
const channel = (px, m) => (m ? Math.round((((px & m.mask) >>> m.shift) * 255) / m.max) : 0);

/**
 * A DIB (a BMP without its 14-byte file header, or an ICO entry) → { data: RGBA top-down, width, height }.
 * @param {Buffer} buf
 * @param {number} dib        offset of the DIB header
 * @param {number|null} pixelsAt  offset of the pixel array (BMP: from the file header; ICO: right after the palette)
 * @param {boolean} ico       an ICO entry: height is doubled and a 1-bit AND mask follows the pixels
 */
function decodeDib(buf, dib, pixelsAt, ico) {
    if (dib + 12 > buf.length) throw new ImageError('This BMP file is truncated');
    const hsize = buf.readUInt32LE(dib);
    let width, height, bpp, compression = 0, colors = 0, masks = null, alphaMask = 0;
    let palAt, palEntry;
    if (hsize === 12) {
        width = buf.readUInt16LE(dib + 4); height = buf.readInt16LE(dib + 6); bpp = buf.readUInt16LE(dib + 10);
        palAt = dib + 12; palEntry = 3;
    } else if (hsize >= 40 && dib + hsize <= buf.length) {
        width = buf.readInt32LE(dib + 4); height = buf.readInt32LE(dib + 8); bpp = buf.readUInt16LE(dib + 14);
        compression = buf.readUInt32LE(dib + 16); colors = buf.readUInt32LE(dib + 32);
        palAt = dib + hsize; palEntry = 4;
        if (compression === 3 || compression === 6) {
            let at = dib + 40;
            if (hsize === 40) { palAt += compression === 6 ? 16 : 12; }
            if (at + 12 > buf.length) throw new ImageError('This BMP file is truncated');
            masks = [buf.readUInt32LE(at), buf.readUInt32LE(at + 4), buf.readUInt32LE(at + 8)];
            if ((hsize >= 56 || compression === 6) && at + 16 <= buf.length) alphaMask = buf.readUInt32LE(at + 12);
        } else if (hsize >= 56) {
            alphaMask = buf.readUInt32LE(dib + 52);
        }
    } else {
        throw new ImageError('This BMP header is not supported');
    }
    if (ico) height = Math.trunc(height / 2);
    const topDown = height < 0;
    height = Math.abs(height);
    if (!(width > 0 && height > 0)) throw new ImageError('This BMP file has no pixels');
    if (width * height > MAX_PIXELS) throw new ImageError(`This BMP picture is larger than ${MAX_PIXELS / 1024 / 1024} megapixels`);
    if (![1, 4, 8, 16, 24, 32].includes(bpp)) throw new ImageError(`${bpp}-bit BMP files are not supported`);
    if (![0, 1, 2, 3, 6].includes(compression)) throw new ImageError('This BMP compression (JPEG/PNG inside BMP) is not supported');

    let palette = null;
    if (bpp <= 8) {
        const n = Math.min(colors || 2 ** bpp, 256);
        palette = [];
        for (let i = 0; i < n; i++) {
            const o = palAt + i * palEntry;
            palette.push(o + 2 < buf.length ? [buf[o + 2], buf[o + 1], buf[o]] : [0, 0, 0]);
        }
        if (pixelsAt == null) pixelsAt = palAt + n * palEntry;
    } else if (pixelsAt == null) {
        pixelsAt = palAt;
    }

    const out = Buffer.alloc(width * height * 4);
    const put = (x, y, r, g, b, a) => {
        const row = topDown ? y : height - 1 - y;
        const o = (row * width + x) * 4;
        out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
    };
    const fromPalette = (x, y, idx) => { const c = (palette && palette[idx]) || [0, 0, 0]; put(x, y, c[0], c[1], c[2], 255); };

    const stride = Math.floor((bpp * width + 31) / 32) * 4;
    let hasAlpha = false;
    if (compression === 1 || compression === 2) {
        if (bpp !== (compression === 1 ? 8 : 4)) throw new ImageError('This RLE BMP file is malformed');
        decodeRle(buf, pixelsAt, width, height, compression === 2, fromPalette);
    } else {
        if (pixelsAt + stride * height > buf.length) throw new ImageError('This BMP file is truncated');
        let m = null;
        if (bpp === 16 || bpp === 32) {
            const def = bpp === 16 ? [0x7c00, 0x03e0, 0x001f] : [0x00ff0000, 0x0000ff00, 0x000000ff];
            const [r, g, b] = masks || def;
            m = { r: maskInfo(r), g: maskInfo(g), b: maskInfo(b), a: maskInfo(alphaMask) };
        }
        // 32-bit BI_RGB: the fourth byte is "reserved"; many writers put alpha there. It is alpha
        // unless every pixel has 0 there (then the picture is opaque).
        const xrgb32 = bpp === 32 && !masks && !alphaMask;
        let anyX = false;
        for (let y = 0; y < height; y++) {
            const row = pixelsAt + y * stride;
            for (let x = 0; x < width; x++) {
                if (bpp === 24) { const o = row + x * 3; put(x, y, buf[o + 2], buf[o + 1], buf[o], 255); } else if (bpp === 32) {
                    const px = buf.readUInt32LE(row + x * 4);
                    if (xrgb32) { const a = px >>> 24; if (a) anyX = true; put(x, y, (px >>> 16) & 255, (px >>> 8) & 255, px & 255, a); } else put(x, y, channel(px, m.r), channel(px, m.g), channel(px, m.b), m.a ? channel(px, m.a) : 255);
                } else if (bpp === 16) {
                    const px = buf.readUInt16LE(row + x * 2);
                    put(x, y, channel(px, m.r), channel(px, m.g), channel(px, m.b), m.a ? channel(px, m.a) : 255);
                } else {
                    const perByte = 8 / bpp;
                    const byte = buf[row + Math.floor(x / perByte)];
                    const shift = 8 - bpp * ((x % perByte) + 1);
                    fromPalette(x, y, (byte >> shift) & ((1 << bpp) - 1));
                }
            }
        }
        if (xrgb32 && !anyX) for (let i = 3; i < out.length; i += 4) out[i] = 255;
        hasAlpha = (bpp === 32 && (anyX || !!(m && m.a)));
        if (ico && !hasAlpha) {
            // The AND mask: 1 = transparent. Rows are 1-bit, padded to 32 bits, bottom-up.
            const maskAt = pixelsAt + stride * height;
            const mstride = Math.floor((width + 31) / 32) * 4;
            if (maskAt + mstride * height <= buf.length) {
                for (let y = 0; y < height; y++) {
                    for (let x = 0; x < width; x++) {
                        if ((buf[maskAt + y * mstride + (x >> 3)] >> (7 - (x & 7))) & 1) {
                            const row = topDown ? y : height - 1 - y;
                            out[(row * width + x) * 4 + 3] = 0;
                        }
                    }
                }
            }
        }
    }
    return { data: out, width, height };
}

function decodeRle(buf, at, width, height, four, set) {
    let x = 0, y = 0, i = at;
    const plot = (idx) => { if (x < width && y < height) set(x, y, idx); x++; };
    while (i + 1 < buf.length && y < height) {
        const count = buf[i], val = buf[i + 1];
        i += 2;
        if (count > 0) {
            for (let k = 0; k < count; k++) plot(four ? (k % 2 ? val & 15 : val >> 4) : val);
        } else if (val === 0) { x = 0; y++; } else if (val === 1) { return; } else if (val === 2) {
            if (i + 1 >= buf.length) return;
            x += buf[i]; y += buf[i + 1]; i += 2;
        } else {
            const n = val;
            const bytes = four ? Math.ceil(n / 2) : n;
            for (let k = 0; k < n; k++) {
                const b = buf[i + (four ? k >> 1 : k)];
                plot(four ? (k % 2 ? b & 15 : b >> 4) : b);
            }
            i += bytes + (bytes % 2);   // absolute runs are padded to a 16-bit boundary
        }
    }
}

function decodeBmp(buf) {
    if (buf.length < 26 || buf[0] !== 0x42 || buf[1] !== 0x4d) throw new ImageError('Not a BMP file');
    return decodeDib(buf, 14, buf.readUInt32LE(10), false);
}

// ── ICO reader ───────────────────────────────────────────────

/** The largest (then deepest) entry of an .ico → a sharp input: PNG bytes, or RGBA pixels. */
function decodeIco(buf) {
    const n = buf.readUInt16LE(4);
    let best = null;
    for (let i = 0; i < n; i++) {
        const e = 6 + i * 16;
        const w = buf[e] || 256, h = buf[e + 1] || 256, bpp = buf.readUInt16LE(e + 6);
        const size = buf.readUInt32LE(e + 8), offset = buf.readUInt32LE(e + 12);
        if (offset + size > buf.length || size < 8) continue;
        const score = w * h * 64 + bpp;
        if (!best || score > best.score) best = { score, size, offset };
    }
    if (!best) throw new ImageError('This ICO file has no readable image');
    const entry = buf.subarray(best.offset, best.offset + best.size);
    if (entry.readUInt32BE(0) === 0x89504e47) return { png: Buffer.from(entry) };
    return decodeDib(entry, 0, null, true);
}

// ── HEIC (libheif command-line decoder) ──────────────────────

const heif = createBinary({
    name: 'heif_decoder',
    candidates: ['heif-dec', 'heif-convert'],
    envVar: 'HEIF_DEC_PATH',
    // The decoder is useless without an HEVC plugin (libheif-plugin-libde265).
    probe(bin) {
        const r = spawnSync(bin, ['--list-decoders'], { encoding: 'utf8', timeout: 5000 });
        if (r.error || r.status !== 0) return true;   // an older build without --list-decoders: assume it can
        const m = /HEIC decoders:\s*\n((?:\s*-.*\n?)*)/i.exec(r.stdout || '');
        return m && /-\s*\S/.test(m[1]) ? true : 'no HEVC decoder plugin (install libheif-plugin-libde265)';
    },
});

const HEIC_SETTING_UP = 'HEIC (iPhone) photos cannot be read yet: the decoder is being set up on the server. Other formats work now.';

function decodeHeic(buf) {
    if (!heif.available()) throw new Unavailable(HEIC_SETTING_UP, { format: 'heic' });
    const bin = heif.path({ format: 'heic' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-heic-'));
    const input = path.join(dir, 'in.heic');
    const output = path.join(dir, 'out.png');
    fs.writeFileSync(input, buf);
    return new Promise((resolve, reject) => {
        let err = '';
        const child = spawn(bin, [input, output], { stdio: ['ignore', 'ignore', 'pipe'] });
        const timer = setTimeout(() => child.kill('SIGKILL'), HEIF_TIMEOUT_MS);
        child.stderr.on('data', d => { if (err.length < 2000) err += d; });
        child.on('error', (e) => { clearTimeout(timer); reject(e); });
        child.on('close', (code) => {
            clearTimeout(timer);
            try {
                // A file with several pictures is written as out-1.png, out-2.png, …: the first is the primary.
                const png = fs.existsSync(output) ? output : fs.readdirSync(dir).filter(f => /^out.*\.png$/.test(f)).sort().map(f => path.join(dir, f))[0];
                if (code === 0 && png) return resolve(fs.readFileSync(png));
                reject(new ImageError(/No decoding plugin/i.test(err) ? 'HEIC decoding is not available on this server yet' : 'This HEIC file could not be decoded'));
            } catch (e) { reject(e); } finally { fs.rm(dir, { recursive: true, force: true }, () => {}); }
        });
    });
}

// ── The one entry point ──────────────────────────────────────

/**
 * Decode an upload once. → { format: 'bmp'|'ico'|'heic'|<sharp format>, sharp(): a fresh pipeline }
 */
async function open(buf) {
    const kind = sniff(buf);
    if (kind === 'bmp' || kind === 'ico') {
        const d = kind === 'bmp' ? decodeBmp(buf) : decodeIco(buf);
        if (d.png) return { format: kind, sharp: () => sharp(d.png) };
        const raw = { width: d.width, height: d.height, channels: 4 };
        return { format: kind, sharp: () => sharp(d.data, { raw }) };
    }
    if (kind === 'heic') {
        const png = await decodeHeic(buf);
        return { format: 'heic', sharp: () => sharp(png) };
    }
    let format = null;
    try { format = (await sharp(buf).metadata()).format || null; } catch { throw new ImageError('This file is not an image this tool can read'); }
    return { format, sharp: () => sharp(buf) };
}

// ── BMP writer ───────────────────────────────────────────────

/** RGBA pixels (top-down) → a BMP file: 24-bit when opaque, 32-bit BGRA with a V4 header otherwise. */
function encodeBmp(rgba, width, height) {
    if (width * height > MAX_PIXELS) throw new ImageError(`BMP output is limited to ${MAX_PIXELS / 1024 / 1024} megapixels`);
    let alpha = false;
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) { alpha = true; break; }
    const hsize = alpha ? 108 : 40;
    const stride = alpha ? width * 4 : Math.ceil((width * 3) / 4) * 4;
    const dataAt = 14 + hsize;
    const out = Buffer.alloc(dataAt + stride * height);
    out.write('BM', 0, 'latin1');
    out.writeUInt32LE(out.length, 2);
    out.writeUInt32LE(dataAt, 10);
    out.writeUInt32LE(hsize, 14);
    out.writeInt32LE(width, 18);
    out.writeInt32LE(height, 22);           // positive: bottom-up rows, what every reader expects
    out.writeUInt16LE(1, 26);
    out.writeUInt16LE(alpha ? 32 : 24, 28);
    out.writeUInt32LE(alpha ? 3 : 0, 30);   // BI_BITFIELDS | BI_RGB
    out.writeUInt32LE(stride * height, 34);
    out.writeInt32LE(2835, 38);             // 72 dpi
    out.writeInt32LE(2835, 42);
    if (alpha) {
        out.writeUInt32LE(0x00ff0000, 54); out.writeUInt32LE(0x0000ff00, 58);
        out.writeUInt32LE(0x000000ff, 62); out.writeUInt32LE(0xff000000, 66);
        out.writeUInt32LE(0x73524742, 70);  // LCS_sRGB
    }
    for (let y = 0; y < height; y++) {
        const src = (height - 1 - y) * width * 4;
        let o = dataAt + y * stride;
        for (let x = 0; x < width; x++) {
            const s = src + x * 4;
            out[o++] = rgba[s + 2]; out[o++] = rgba[s + 1]; out[o++] = rgba[s];
            if (alpha) out[o++] = rgba[s + 3];
        }
    }
    return out;
}

/** A sharp pipeline → BMP bytes (+ its width and height). */
async function toBmp(pipeline) {
    const { data, info } = await pipeline.toColourspace('srgb').ensureAlpha().raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
    return { buffer: encodeBmp(data, info.width, info.height), width: info.width, height: info.height };
}

module.exports = { open, sniff, decodeBmp, decodeIco, encodeBmp, toBmp, heif, ImageError, MAX_PIXELS, HEIC_SETTING_UP };
