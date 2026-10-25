'use strict';
// ═══════════════════════════════════════════════════════════════
// Barcode & QR tools — every code as an image URL, for <img> tags, Markdown, scripts and AI agents:
//
//   GET /api/codes/<symbology>.svg?text=…     (or .png)       any bwip-js symbology: qrcode, ean13, code128, datamatrix…
//   GET /api/codes/qr.png?text=…&ecc=H                          qr = qrcode
//   GET /api/codes/auto.svg?text=…                              the symbology recommend() picks (a GTIN in its retail code…)
//   GET /api/codes/wifi.svg?ssid=…&password=…&security=WPA       a Wi-Fi QR code; vcard.svg?first=…&phone=… a contact card
//
// Options: scale (1-12, PNG px per module), height (mm, barcodes), hrt=0 (no human-readable line), color and
// background (rrggbb, background=transparent), quiet (modules), rotate (N R I L), ecc (QR L M Q H), eclevel, addon.
// No account: the answer depends only on the URL, so it is cached for a year (Cloudflare serves repeats) and anyone may
// embed it (CORS *). Per address 300 a minute. Text bwip-js cannot encode answers 422 with its reason as plain text.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const rateLimit = require('express-rate-limit');
const bwipjs = require('bwip-js');
const S = require('../../public/js/codes/smart.js');
const { draw, SYMBOLS } = require('./engines');

const MAX_TEXT = 2000;
const MAX_PIXELS = 16e6;   // a PNG at most 4000 × 4000
const hexOf = (v) => (/^#?[0-9a-f]{6}$/i.test(String(v || '')) ? String(v).replace(/^#/, '') : null);
const int = (v, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : undefined; };

/** The request → { bcid, text, opts } for engines.draw, or { error }. */
function parse(name, q) {
    let bcid = name === 'qr' ? 'qrcode' : name;
    let text = typeof q.text === 'string' ? q.text : '';
    if (bcid === 'wifi') { bcid = 'qrcode'; text = S.qrPayload('wifi', { ssid: q.ssid, password: q.password, security: q.security, hidden: q.hidden === '1' || q.hidden === 'true' }); if (!q.ssid) return { error: 'wifi needs ssid=' }; }
    else if (bcid === 'vcard') { bcid = 'qrcode'; text = S.qrPayload('contact', q); if (!q.first && !q.last && !q.org) return { error: 'vcard needs first=, last= or org=' }; }
    else if (bcid === 'auto') { const r = S.recommend(text); bcid = r.symbology; text = r.encode || r.fixed || text; }
    if (!text) return { error: 'text= is required' };
    if (text.length > MAX_TEXT) return { error: `text= is limited to ${MAX_TEXT} characters` };
    if (!SYMBOLS.has(bcid)) return { error: `Unknown symbology "${name}". The list: https://openvibe.tools/api/codes` };
    const bg = q.background === 'transparent' ? null : hexOf(q.background);
    return {
        bcid, text,
        opts: {
            color: hexOf(q.color) || undefined, background: bg || undefined, transparent: q.background === 'transparent',
            quiet: int(q.quiet, 0, 40), rotate: /^[NRIL]$/.test(q.rotate || '') ? q.rotate : 'N',
            height_mm: q.height ? Math.min(100, Math.max(2, Number(q.height) || 15)) : undefined,
            include_text: !(q.text_line === '0' || q.hrt === '0' || q.showtext === '0'),
            eclevel: q.ecc && /^[LMQH]$/.test(q.ecc) ? q.ecc : (q.eclevel !== undefined ? (/^\d{1,2}$/.test(q.eclevel) ? Number(q.eclevel) : String(q.eclevel).slice(0, 2)) : undefined),
            addon: /^(\d{2}|\d{5})$/.test(q.addon || '') ? q.addon : undefined,
            scale: int(q.scale, 1, 12) || 4,
        },
    };
}

function router() {
    const r = express.Router();
    r.use('/api/codes', rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false }));
    // The symbologies, for people and programs choosing one.
    r.get('/api/codes', (_req, res) => {
        res.set({ 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' }).json({
            usage: 'GET /api/codes/<symbology>.svg?text=… or .png; see https://barcodes.openvibe.tools/ and https://openvibe.tools/developers',
            aliases: { qr: 'qrcode', auto: 'the symbology that fits the text', wifi: 'Wi-Fi QR (ssid, password, security, hidden)', vcard: 'contact QR (first, last, phone, email, org, title, url, address)' },
            symbologies: [...SYMBOLS.values()].map((s) => ({ id: s.bcid, name: s.desc, example: `/api/codes/${s.bcid}.svg?text=${encodeURIComponent(s.text)}` })),
        });
    });
    r.get('/api/codes/:name.:ext(svg|png)', async (req, res) => {
        const p = parse(String(req.params.name).toLowerCase(), req.query);
        const fail = (status, msg) => res.status(status).set({ 'Cache-Control': 'public, max-age=60', 'Access-Control-Allow-Origin': '*' }).type('text/plain').send(msg);
        if (p.error) return fail(422, p.error);
        try {
            if (req.params.ext === 'svg') {
                const out = draw(p.bcid, p.text, { ...p.opts, background: p.opts.transparent ? undefined : p.opts.background });
                let svg = out.svg;
                if (p.opts.transparent) svg = svg.replace(/<rect width="100%" height="100%" fill="#[0-9a-f]{6}" \/>\n?/i, '');
                res.set({ 'Content-Type': 'image/svg+xml; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
                return send(res, svg);
            }
            // PNG: the same drawing at `scale` pixels per module, inside the size limit.
            const twoD = /qrcode|datamatrix|aztec|pdf417|maxicode|dotcode|hanxin|codeone|ultracode/.test(p.bcid);
            const opts = {
                bcid: p.bcid, text: p.text, scale: p.opts.scale, rotate: p.opts.rotate,
                barcolor: p.opts.color || '000000', ...(p.opts.transparent ? {} : { backgroundcolor: p.opts.background || 'ffffff' }),
                paddingwidth: p.opts.quiet ?? (twoD ? 4 : 10), paddingheight: p.opts.quiet ?? 4,
                ...(p.opts.eclevel !== undefined ? { eclevel: p.opts.eclevel } : {}), ...(p.opts.addon ? { addon: p.opts.addon } : {}),
            };
            if (!twoD) {
                if (p.opts.height_mm) opts.height = p.opts.height_mm;
                const retail = /^(ean13|upca|upce|ean8|isbn|ismn|issn)$/.test(p.bcid);
                if (p.opts.include_text && !/pharmacode|postnet|planet|royalmail|auspost|kix|japanpost|onecode|flattermarken|mailmark|daft/.test(p.bcid)) Object.assign(opts, retail ? { includetext: true, guardwhitespace: true } : { includetext: true, textxalign: 'center', textyoffset: 3 });
            }
            const raw = bwipjs.raw(opts)[0];
            const w = ((raw.pixx || raw.sbs?.reduce?.((a, b) => a + b, 0) || 100) + 40) * p.opts.scale;
            const h = ((raw.pixy || 60) + 40) * p.opts.scale;
            if (w * h > MAX_PIXELS) return fail(422, 'That code at that scale is larger than 4000 × 4000 px: use a smaller scale or .svg');
            const png = await bwipjs.toBuffer(opts);
            res.set('Content-Type', 'image/png');
            return send(res, png);
        } catch (err) {
            return fail(422, String((err && err.message) || err).replace(/^bwip(?:p|-js)\.[\w-]+#?\d*:\s*/, ''));
        }
    });
    return r;
}

function send(res, body) {
    res.set({ 'Cache-Control': 'public, max-age=31536000, immutable', 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin', 'X-Content-Type-Options': 'nosniff' });
    return res.send(body);
}

module.exports = { router, parse };
