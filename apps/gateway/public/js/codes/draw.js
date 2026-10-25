/* Drawing for the Barcode & QR tools (codes.html), with no DOM: a styled QR code as SVG from bwip-js's module
   matrix (module shapes, eye shapes, colours, a gradient and a logo), a PNG's print resolution (pHYs), CRC-32 and a
   store-only ZIP for bulk downloads. The browser loads it as window.OVCodesDraw; the tests require() it. */
(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.OVCodesDraw = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const r2 = (n) => Math.round(n * 100) / 100;

    /** bwip-js raw() output → { n, dark(x, y) } for a square matrix (QR, Micro QR). */
    function matrixOf(raw) {
        const m = Array.isArray(raw) ? raw[0] : raw;
        const n = m.pixx;
        return { n, h: m.pixy, dark: (x, y) => x >= 0 && y >= 0 && x < n && y < m.pixy && m.pixs[y * n + x] === 1 };
    }

    /** The three 7×7 finder patterns of a QR code, as their top-left corners. */
    const finders = (n) => [[0, 0], [n - 7, 0], [0, n - 7]];
    const inFinder = (n, x, y) => finders(n).some(([fx, fy]) => x >= fx && x < fx + 7 && y >= fy && y < fy + 7);

    /** A rectangle with each corner's radius (tl, tr, br, bl) as an SVG path. */
    function roundRect(x, y, w, h, [tl, tr, br, bl]) {
        return `M${r2(x + tl)} ${r2(y)}H${r2(x + w - tr)}${tr ? `A${tr} ${tr} 0 0 1 ${r2(x + w)} ${r2(y + tr)}` : ''}V${r2(y + h - br)}${br ? `A${br} ${br} 0 0 1 ${r2(x + w - br)} ${r2(y + h)}` : ''}H${r2(x + bl)}${bl ? `A${bl} ${bl} 0 0 1 ${r2(x)} ${r2(y + h - bl)}` : ''}V${r2(y + tl)}${tl ? `A${tl} ${tl} 0 0 1 ${r2(x + tl)} ${r2(y)}` : ''}Z`;
    }

    /** One eye (finder pattern) at (x, y) in the chosen shape: the 7×7 ring and the 3×3 pupil, as path data. */
    function eye(x, y, shape) {
        // The ring is the outer square with the inner one cut out (fill-rule evenodd).
        const ring = (ro, ri) => roundRect(x, y, 7, 7, ro) + roundRect(x + 1, y + 1, 5, 5, ri);
        switch (shape) {
            case 'circle': return {
                ring: `M${x + 3.5} ${y}a3.5 3.5 0 1 0 0.001 0ZM${x + 3.5} ${y + 1}a2.5 2.5 0 1 1 -0.001 0Z`,
                pupil: `M${x + 3.5} ${y + 2}a1.5 1.5 0 1 0 0.001 0Z`,
            };
            case 'rounded': return { ring: ring([2.2, 2.2, 2.2, 2.2], [1.4, 1.4, 1.4, 1.4]), pupil: roundRect(x + 2, y + 2, 3, 3, [0.9, 0.9, 0.9, 0.9]) };
            case 'leaf': return { ring: ring([3, 0, 3, 0], [2, 0, 2, 0]), pupil: roundRect(x + 2, y + 2, 3, 3, [1.4, 0, 1.4, 0]) };
            default: return { ring: ring([0, 0, 0, 0], [0, 0, 0, 0]), pupil: roundRect(x + 2, y + 2, 3, 3, [0, 0, 0, 0]) };
        }
    }

    /** The data modules (everything but the eyes) in one of the styles, as path data in module units. */
    function modules(mx, style, skip) {
        const out = [];
        const { n, h, dark } = mx;
        for (let y = 0; y < h; y++) {
            if (style === 'square') {
                // Runs of dark modules on a row as one rectangle each: fewer, crisper shapes.
                for (let x = 0; x < n; x++) {
                    if (!dark(x, y) || skip(x, y)) continue;
                    let e = x;
                    while (e + 1 < n && dark(e + 1, y) && !skip(e + 1, y)) e++;
                    out.push(`M${x} ${y}h${e - x + 1}v1h${-(e - x + 1)}Z`);
                    x = e;
                }
                continue;
            }
            for (let x = 0; x < n; x++) {
                if (!dark(x, y) || skip(x, y)) continue;
                if (style === 'dots') out.push(`M${x + 0.5} ${y + 0.08}a0.42 0.42 0 1 0 0.001 0Z`);
                else if (style === 'rounded') out.push(roundRect(x + 0.06, y + 0.06, 0.88, 0.88, [0.3, 0.3, 0.3, 0.3]));
                else {
                    // fluid: a corner is round only where neither neighbour on that corner is dark, so modules flow into each other.
                    const d = (dx, dy) => dark(x + dx, y + dy) && !skip(x + dx, y + dy);
                    const R = 0.5;
                    out.push(roundRect(x, y, 1, 1, [!d(-1, 0) && !d(0, -1) ? R : 0, !d(1, 0) && !d(0, -1) ? R : 0, !d(1, 0) && !d(0, 1) ? R : 0, !d(-1, 0) && !d(0, 1) ? R : 0]));
                }
            }
        }
        return out.join('');
    }

    /**
     * A styled QR code as an SVG document. `raw` is bwip-js raw({ bcid: 'qrcode', … }); `o`:
     *   style      square | rounded | dots | fluid           eyes     square | rounded | circle | leaf
     *   color      modules (#rrggbb)                        eyeColor eyes (defaults to color)
     *   gradient   null | { to: '#rrggbb', angle: 0-360 }   background '#rrggbb' or 'transparent'
     *   quiet      quiet zone in modules (4)                logo     { href (data URL), size: share of the width 0.1-0.3 }
     *   caption    text under the code, in a frame          size     the SVG's width/height in px (viewBox stays in modules)
     * → { svg, modules: n, logoBox }
     */
    function qrSvg(raw, o = {}) {
        const mx = matrixOf(raw);
        const n = mx.n;
        const q = o.quiet ?? 4;
        const style = o.style || 'square';
        const eyes = o.eyes || 'square';
        const color = o.color || '#000000';
        const eyeColor = o.eyeColor || color;
        const bg = o.background || '#ffffff';
        const W = n + 2 * q;
        const capH = o.caption ? Math.max(4, Math.round(W * 0.14)) : 0;
        const H = W + capH;
        // A logo clears a square in the middle (whole modules, odd count so it stays centred).
        let logoBox = null;
        if (o.logo && o.logo.href) {
            let k = Math.round(n * Math.min(0.3, Math.max(0.1, o.logo.size || 0.22)));
            if (k % 2 !== n % 2) k += 1;
            const s = (n - k) / 2;
            logoBox = { x: s, y: s, size: k };
        }
        const skip = (x, y) => inFinder(n, x, y) || (logoBox && x >= logoBox.x - 0.5 && x < logoBox.x + logoBox.size + 0.5 && y >= logoBox.y - 0.5 && y < logoBox.y + logoBox.size + 0.5);
        const fill = o.gradient && o.gradient.to ? 'url(#ovg)' : esc(color);
        const parts = [];
        parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"${o.size ? ` width="${o.size}" height="${Math.round((o.size * H) / W)}"` : ''} shape-rendering="${style === 'square' ? 'crispEdges' : 'geometricPrecision'}">`);
        if (o.gradient && o.gradient.to) {
            const a = ((o.gradient.angle ?? 45) * Math.PI) / 180;
            const [x1, y1, x2, y2] = [0.5 - Math.cos(a) / 2, 0.5 - Math.sin(a) / 2, 0.5 + Math.cos(a) / 2, 0.5 + Math.sin(a) / 2].map(r2);
            parts.push(`<defs><linearGradient id="ovg" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"><stop offset="0" stop-color="${esc(color)}"/><stop offset="1" stop-color="${esc(o.gradient.to)}"/></linearGradient></defs>`);
        }
        if (bg !== 'transparent') parts.push(`<rect width="${W}" height="${H}" fill="${esc(bg)}"${o.caption ? ' rx="2"' : ''}/>`);
        parts.push(`<g transform="translate(${q} ${q})">`);
        parts.push(`<path fill="${fill}" d="${modules(mx, style, skip)}"/>`);
        const eyePaths = finders(n).map(([x, y]) => eye(x, y, eyes));
        parts.push(`<path fill="${o.gradient && o.gradient.to && !o.eyeColor ? fill : esc(eyeColor)}" fill-rule="evenodd" d="${eyePaths.map((e) => e.ring).join('')}"/>`);
        parts.push(`<path fill="${o.gradient && o.gradient.to && !o.eyeColor ? fill : esc(eyeColor)}" d="${eyePaths.map((e) => e.pupil).join('')}"/>`);
        if (logoBox) {
            const pad = 0.35;
            parts.push(`<image href="${esc(o.logo.href)}" x="${r2(logoBox.x + pad)}" y="${r2(logoBox.y + pad)}" width="${r2(logoBox.size - 2 * pad)}" height="${r2(logoBox.size - 2 * pad)}" preserveAspectRatio="xMidYMid meet"/>`);
        }
        parts.push('</g>');
        if (o.caption) {
            const fs = Math.max(2.4, capH * 0.5);
            parts.push(`<text x="${W / 2}" y="${r2(W + capH * 0.42)}" text-anchor="middle" dominant-baseline="middle" font-family="Inter, system-ui, -apple-system, 'Segoe UI', sans-serif" font-weight="700" font-size="${r2(fs)}" fill="${fill}">${esc(String(o.caption).slice(0, 40))}</text>`);
        }
        parts.push('</svg>');
        return { svg: parts.join(''), modules: n, logoBox, width: W, height: H };
    }

    // ── CRC-32, PNG resolution, ZIP ─────────────────────────────────────────────────────────────────────────────────
    const CRC = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; } return t; })();
    function crc32(bytes, start = 0, end = bytes.length) {
        let c = 0xffffffff;
        for (let i = start; i < end; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
        return (c ^ 0xffffffff) >>> 0;
    }

    /** A PNG with a pHYs chunk saying its resolution, so it prints at the size it was made for. */
    function pngWithDpi(png, dpi) {
        const src = png instanceof Uint8Array ? png : new Uint8Array(png);
        if (!dpi || src.length < 33) return src;
        const ppm = Math.round(dpi / 0.0254);
        const chunk = new Uint8Array(21);
        const dv = new DataView(chunk.buffer);
        dv.setUint32(0, 9);
        chunk.set([0x70, 0x48, 0x59, 0x73], 4);              // pHYs
        dv.setUint32(8, ppm); dv.setUint32(12, ppm); chunk[16] = 1;
        dv.setUint32(17, crc32(chunk, 4, 17));
        // After IHDR (8-byte signature + 25-byte IHDR chunk), dropping any pHYs already there.
        const out = [src.subarray(0, 33), chunk];
        let o = 33;
        while (o + 8 <= src.length) {
            const len = new DataView(src.buffer, src.byteOffset + o, 4).getUint32(0);
            const type = String.fromCharCode(src[o + 4], src[o + 5], src[o + 6], src[o + 7]);
            if (type !== 'pHYs') out.push(src.subarray(o, o + 12 + len));
            o += 12 + len;
        }
        const total = out.reduce((s, p) => s + p.length, 0);
        const res = new Uint8Array(total);
        let p = 0;
        for (const part of out) { res.set(part, p); p += part.length; }
        return res;
    }

    /** files: [{ name, data: Uint8Array | string }] → a ZIP (stored, no compression: PNG and SVG barely shrink). */
    function zip(files) {
        const enc = new TextEncoder();
        const locals = [];
        const centrals = [];
        let offset = 0;
        const seen = new Map();
        for (const f of files) {
            let name = String(f.name).replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').slice(0, 120) || 'code';
            // Two values with the same file name: the second becomes name-2.png.
            const k = name.toLowerCase();
            if (seen.has(k)) { const i = seen.get(k) + 1; seen.set(k, i); name = name.replace(/(\.[a-z0-9]+)?$/i, `-${i}$1`); } else seen.set(k, 1);
            const nameBytes = enc.encode(name);
            const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
            const crc = crc32(data);
            const head = new Uint8Array(30 + nameBytes.length);
            const hv = new DataView(head.buffer);
            hv.setUint32(0, 0x04034b50, true); hv.setUint16(4, 20, true); hv.setUint16(6, 0x0800, true); hv.setUint16(8, 0, true);
            hv.setUint16(10, 0, true); hv.setUint16(12, 0x21, true); hv.setUint32(14, crc, true); hv.setUint32(18, data.length, true); hv.setUint32(22, data.length, true);
            hv.setUint16(26, nameBytes.length, true); head.set(nameBytes, 30);
            const cen = new Uint8Array(46 + nameBytes.length);
            const cv = new DataView(cen.buffer);
            cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
            cv.setUint16(12, 0, true); cv.setUint16(14, 0x21, true); cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
            cv.setUint16(28, nameBytes.length, true); cv.setUint32(42, offset, true); cen.set(nameBytes, 46);
            locals.push(head, data);
            centrals.push(cen);
            offset += head.length + data.length;
        }
        const cenSize = centrals.reduce((s, c) => s + c.length, 0);
        const end = new Uint8Array(22);
        const ev = new DataView(end.buffer);
        ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true); ev.setUint32(12, cenSize, true); ev.setUint32(16, offset, true);
        const parts = [...locals, ...centrals, end];
        const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
        let p = 0;
        for (const part of parts) { out.set(part, p); p += part.length; }
        return out;
    }

    /** Millimetres ↔ pixels at a resolution. */
    const mmToPx = (mm, dpi) => Math.round((mm / 25.4) * dpi);
    const pxToMm = (px, dpi) => (px / dpi) * 25.4;

    return { matrixOf, qrSvg, crc32, pngWithDpi, zip, mmToPx, pxToMm, roundRect };
});
