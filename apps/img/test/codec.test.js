'use strict';
// The formats sharp cannot do on its own (server/tools/codec.js): BMP output is a real BMP (it used to
// be a PNG named .bmp), BMP and ICO uploads are read, ICO output decodes the upload once, and HEIC
// either decodes through libheif's CLI or answers 503 tools.unavailable, never a broken result.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const codec = require('../server/tools/codec');
const convert = require('../server/tools/convert');
const resize = require('../server/tools/resize');
const crop = require('../server/tools/crop');
const { startApp } = require('../../_shared/test/spawn');

const HEIC = fs.readFileSync(path.join(__dirname, 'fixtures', 'gradient.heic'));

async function rgba(input) {
    return sharp(input).ensureAlpha().raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
}

/** A hand-built BMP (file header + BITMAPINFOHEADER + palette + pixel rows as given). */
function bmp({ width, height, bpp, compression = 0, palette = [], rows }) {
    const pal = Buffer.concat(palette.map(([r, g, b]) => Buffer.from([b, g, r, 0])));
    const pixels = Buffer.concat(rows);
    const head = Buffer.alloc(54);
    head.write('BM', 0, 'latin1');
    head.writeUInt32LE(54 + pal.length + pixels.length, 2);
    head.writeUInt32LE(54 + pal.length, 10);
    head.writeUInt32LE(40, 14);
    head.writeInt32LE(width, 18); head.writeInt32LE(height, 22);
    head.writeUInt16LE(1, 26); head.writeUInt16LE(bpp, 28);
    head.writeUInt32LE(compression, 30); head.writeUInt32LE(pixels.length, 34);
    head.writeUInt32LE(palette.length, 46);
    return Buffer.concat([head, pal, pixels]);
}

(async () => {
    // ── BMP output: the real thing ───────────────────────────
    const opaque = await sharp({ create: { width: 7, height: 5, channels: 3, background: { r: 200, g: 30, b: 90 } } }).png().toBuffer();
    let r = await convert(opaque, { format: 'bmp' });
    assert.strictEqual(r.mime, 'image/bmp');
    assert.strictEqual(r.ext, 'bmp');
    assert.strictEqual(r.buffer.toString('latin1', 0, 2), 'BM', 'BMP magic');
    assert.strictEqual(r.buffer.readUInt32LE(2), r.buffer.length, 'file size field');
    assert.strictEqual(r.buffer.readUInt32LE(14), 40, 'BITMAPINFOHEADER');
    assert.strictEqual(r.buffer.readUInt16LE(28), 24, 'opaque pictures are 24-bit');
    assert.strictEqual(r.buffer.length, 54 + 5 * 24, 'rows padded to 4 bytes (7 px × 3 = 21 → 24)');
    let back = await rgba(await (await codec.open(r.buffer)).sharp().png().toBuffer());
    assert.deepStrictEqual([back.info.width, back.info.height], [7, 5]);
    assert.deepStrictEqual([...back.data.subarray(0, 4)], [200, 30, 90, 255], 'pixels survive the round trip');

    const clear = await sharp({ create: { width: 3, height: 2, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 0.5 } } }).png().toBuffer();
    r = await convert(clear, { format: 'bmp' });
    assert.strictEqual(r.buffer.readUInt16LE(28), 32, 'transparency → 32-bit');
    assert.strictEqual(r.buffer.readUInt32LE(14), 108, 'BITMAPV4HEADER');
    assert.strictEqual(r.buffer.readUInt32LE(30), 3, 'BI_BITFIELDS');
    assert.strictEqual(r.buffer.readUInt32LE(66), 0xff000000, 'alpha mask');
    back = await rgba(await (await codec.open(r.buffer)).sharp().png().toBuffer());
    assert.deepStrictEqual([...back.data.subarray(0, 4)], [10, 20, 30, 128], 'alpha survives');

    // Resize and crop keep a BMP a BMP.
    const rz = await resize(r.buffer, { width: 2, fit: 'fill', height: 1 });
    assert.deepStrictEqual([rz.mime, rz.buffer.toString('latin1', 0, 2), rz.dimensions.resized.width, rz.buffer.readUInt16LE(28)], ['image/bmp', 'BM', 2, 32]);
    const cr = await crop(r.buffer, { aspect: '1:1' });
    assert.deepStrictEqual([cr.mime, cr.crop.width, cr.crop.height], ['image/bmp', 2, 2]);

    // ── BMP input: palettes, RLE, bitfields, top-down ────────
    // 1-bit, 2×2: black/white checker, bottom-up rows padded to 4 bytes.
    let d = codec.decodeBmp(bmp({ width: 2, height: 2, bpp: 1, palette: [[0, 0, 0], [255, 255, 255]], rows: [Buffer.from([0b01000000, 0, 0, 0]), Buffer.from([0b10000000, 0, 0, 0])] }));
    assert.deepStrictEqual([...d.data], [255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255], '1-bit palette, bottom-up');
    // RLE8, 3×2: row 0 (bottom) = 3× index 1, row 1 = absolute run [0,1,0] (padded), end of bitmap.
    d = codec.decodeBmp(bmp({ width: 3, height: 2, bpp: 8, compression: 1, palette: [[0, 0, 255], [255, 0, 0]], rows: [Buffer.from([3, 1, 0, 0, 0, 3, 0, 1, 0, 0, 0, 1])] }));
    assert.deepStrictEqual([...d.data.subarray(0, 4)], [0, 0, 255, 255], 'RLE8 top row from the absolute run');
    assert.deepStrictEqual([...d.data.subarray(12, 16)], [255, 0, 0, 255], 'RLE8 bottom row from the encoded run');
    // 24-bit top-down (negative height).
    const td = bmp({ width: 1, height: -2, bpp: 24, rows: [Buffer.from([0, 0, 255, 0]), Buffer.from([255, 0, 0, 0])] });
    d = codec.decodeBmp(td);
    assert.deepStrictEqual([...d.data], [255, 0, 0, 255, 0, 0, 255, 255], 'top-down rows in file order');
    // A BMP converts to anything sharp writes.
    const png = await convert(td, { format: 'png' });
    assert.strictEqual((await sharp(png.buffer).metadata()).height, 2);
    assert.throws(() => codec.decodeBmp(Buffer.from('BM' + 'x'.repeat(40))), /not supported|truncated/);

    // ── ICO: output decodes the upload once; input reads PNG and BMP entries ──
    const big = await sharp({ create: { width: 300, height: 200, channels: 4, background: { r: 0, g: 128, b: 255, alpha: 1 } } }).png().toBuffer();
    const realOpen = codec.open;
    let decodes = 0, pipelines = 0;
    codec.open = async (b) => { decodes++; const img = await realOpen(b); return { ...img, sharp: () => { pipelines++; return img.sharp(); } }; };
    const ico = await convert(big, { format: 'ico' });
    codec.open = realOpen;
    assert.strictEqual(decodes, 1, 'the upload is decoded once');
    assert.strictEqual(pipelines, 1, 'one pipeline over the upload (the smaller sizes come from the 256 px pixels)');
    assert.strictEqual(ico.buffer.readUInt16LE(2), 1, 'ICO type');
    assert.strictEqual(ico.buffer.readUInt16LE(4), 6, 'six sizes');
    const sizes = []; for (let i = 0; i < 6; i++) sizes.push(ico.buffer[6 + i * 16] || 256);
    assert.deepStrictEqual(sizes, [16, 32, 48, 64, 128, 256]);
    const fromIco = await convert(ico.buffer, { format: 'png' });
    assert.strictEqual((await sharp(fromIco.buffer).metadata()).width, 256, 'the largest entry of an .ico is read');
    // An ICO whose entry is a DIB with an AND mask (classic icons): 1×1, 24-bit, masked out.
    const dib = Buffer.alloc(40 + 4 + 4);
    dib.writeUInt32LE(40, 0); dib.writeInt32LE(1, 4); dib.writeInt32LE(2, 8); dib.writeUInt16LE(1, 12); dib.writeUInt16LE(24, 14);
    dib.set([0, 0, 255, 0], 40); dib.set([0x80, 0, 0, 0], 44);
    const dir = Buffer.alloc(22); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(1, 4); dir[6] = 1; dir[7] = 1; dir.writeUInt16LE(24, 12); dir.writeUInt32LE(dib.length, 14); dir.writeUInt32LE(22, 18);
    d = codec.decodeIco(Buffer.concat([dir, dib]));
    assert.deepStrictEqual([...d.data], [255, 0, 0, 0], 'red pixel, transparent by the AND mask');

    // ── HEIC ─────────────────────────────────────────────────
    assert.strictEqual(codec.sniff(HEIC), 'heic');
    const avifBrand = Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypavifmif1avifmiaf'), Buffer.alloc(8)]);
    assert.strictEqual(codec.sniff(avifBrand), null, 'AVIF stays with sharp');
    if (codec.heif.available()) {
        const jpg = await convert(HEIC, { format: 'jpg' });
        assert.strictEqual((await sharp(jpg.buffer).metadata()).format, 'jpeg', 'HEIC decodes through libheif');
        console.log(`  HEIC decoded with ${codec.heif.get().path}`);
    } else {
        await assert.rejects(convert(HEIC, { format: 'jpg' }), (e) => e.status === 503 && e.code === 'tools.unavailable');
        console.log('  HEIC decoder not installed here: checked the 503 path only');
    }

    // ── As a real process: BMP over the API, HEIC without a decoder is a 503 problem ──
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-img-codec-'));
    const app = await startApp('img', {
        DATA_DIR: data, UPLOADS_DIR: path.join(data, 'uploads'), OUTPUT_DIR: path.join(data, 'output'),
        HEIF_DEC_PATH: '/nonexistent/heif-dec',
    });
    try {
        let fd = new FormData();
        fd.append('tool', 'convert'); fd.append('format', 'bmp');
        fd.append('file', new Blob([opaque], { type: 'image/png' }), 'x.png');
        let res = await fetch(`${app.base}/api/process/direct`, { method: 'POST', body: fd });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.headers.get('content-type'), 'image/bmp');
        assert.strictEqual(Buffer.from(await res.arrayBuffer()).toString('latin1', 0, 2), 'BM');

        fd = new FormData();
        fd.append('tool', 'convert'); fd.append('format', 'jpg');
        fd.append('file', new Blob([HEIC], { type: 'image/heic' }), 'photo.heic');
        res = await fetch(`${app.base}/api/process`, { method: 'POST', body: fd });
        assert.strictEqual(res.status, 503);
        assert.strictEqual(res.headers.get('content-type'), 'application/problem+json');
        const p = await res.json();
        assert.strictEqual(p.code, 'tools.unavailable');
        assert.match(p.error, /being set up/);

        const ctx = await (await fetch(`${app.base}/api/context`, { headers: { 'X-OV-Tool': 'heic' } })).json();
        assert.strictEqual(ctx.inputs.heic, false, 'the HEIC page is told the decoder is missing');
        const ready = await (await fetch(`${app.base}/api/ready`)).json();
        assert.ok(ready.degraded.includes('heif_decoder'), 'readiness shows it as degraded, not down');
    } finally {
        await app.kill();
        fs.rmSync(data, { recursive: true, force: true });
    }
    console.log('img codec (BMP out/in, ICO once, HEIC or 503): all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
