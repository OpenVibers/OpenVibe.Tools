'use strict';
// ═══════════════════════════════════════════════════════════════
// Barcode & QR tools — server engines for the tools API (ADR-027).
//
// The pages (public/codes.html) draw and read codes in the browser. These are the same drawings, from the
// same bwip-js and the same public/js/codes/smart.js, so a code tool whose descriptor says api: true can be
// run by POST /api/v1/tools/:id/run and answers an SVG. Engines run in the gateway's worker pool
// (server/run/engine-worker.js). Input is already checked against the tool's schema; text bwip-js cannot
// encode (a letter in an EAN-13, an ISBN with the wrong number of digits) throws, and the run fails with
// bwip-js's reason.
// ═══════════════════════════════════════════════════════════════

const bwipjs = require('bwip-js');
const S = require('../../public/js/codes/smart.js');

// Every symbology bwip-js draws, by its id: { bcid, desc, text (a sample), opts }.
const SYMBOLS = new Map(bwipjs.symbolList.map((s) => [s.bcid, s]));
const TWO_D = /qrcode|datamatrix|aztec|pdf417|maxicode|dotcode|hanxin|codeone|ultracode|codablockf|code16k|code49|mailmark|d3aqr|rune/;
const hex = (c, dflt) => String(c || dflt).replace(/^#/, '').toLowerCase();

/** bwip-js's errors read "bwipp.ean13badLength#2394: EAN-13 must be 12 or 13 digits": keep the sentence. */
function failure(err) {
    const msg = String((err && err.message) || err).replace(/^bwip(?:p|-js)\.[\w-]+#?\d*:\s*/, '');
    return Object.assign(new Error(msg), { status: 422 });
}

/**
 * One code as SVG → { svg, symbology, text, width, height }. `o`: height_mm (1D bar height), include_text,
 * rotate (N R I L), color and background (#rrggbb), quiet (quiet zone in modules), plus the few symbology
 * options the API passes through (eclevel, columns, rows, version, format, addon).
 */
function draw(bcid, text, o = {}) {
    if (!SYMBOLS.has(bcid)) throw Object.assign(new Error(`Unknown symbology "${bcid}"`), { status: 422 });
    const twoD = TWO_D.test(bcid);
    const opts = {
        bcid, text, scale: 4,
        barcolor: hex(o.color, '000000'), backgroundcolor: hex(o.background, 'ffffff'),
        rotate: o.rotate || 'N',
        paddingwidth: o.quiet ?? (twoD ? 4 : 10), paddingheight: o.quiet ?? 4,
    };
    if (!twoD) {
        if (o.height_mm) opts.height = o.height_mm;
        // Retail symbologies lay out their own digits (the first one outside the bars, then the groups); others centre a line.
        const retail = /^(ean13|upca|upce|ean8|isbn|ismn|issn)$/.test(bcid);
        if (o.include_text !== false && !/pharmacode|postnet|planet|royalmail|auspost|kix|japanpost|onecode|flattermarken|mailmark|daft/.test(bcid)) { opts.includetext = true; if (!retail) { opts.textxalign = 'center'; opts.textyoffset = 3; } }
        if (retail) opts.guardwhitespace = true;
    }
    for (const k of ['eclevel', 'columns', 'rows', 'version', 'format', 'addon', 'extratext']) if (o[k] !== undefined && o[k] !== '') opts[k] = o[k];
    let svg;
    try { svg = bwipjs.toSVG(opts); } catch (err) { throw failure(err); }
    const vb = /viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(svg);
    return { svg, symbology: bcid, text, width: vb ? Number(vb[1]) : null, height: vb ? Number(vb[2]) : null };
}

/** The general barcode tool: a chosen symbology, or the one recommend() picks for the text. */
function barcode(input) {
    const rec = S.recommend(input.text);
    const bcid = input.symbology || rec.symbology;
    const text = input.symbology ? input.text : (rec.encode || input.text);
    const out = draw(bcid, text, input);
    return { data: { ...out, ...(input.symbology ? {} : { recommended: { why: rec.why, warnings: rec.warnings, ...(rec.fixed ? { fixed: rec.fixed } : {}) } }) } };
}

/** A fixed symbology for the single-purpose pages (code128, ean13, upc, pdf417, aztec, isbn). */
const fixed = (bcid, prep = (t) => t) => (input) => ({ data: draw(bcid, prep(input.text, input), input) });

/** GTIN-style input: the check digit added when one digit short (12 digits → EAN-13), verified otherwise. */
const gtin = (len) => (t) => {
    const d = String(t).replace(/[\s-]/g, '');
    if (/^\d+$/.test(d) && d.length === len - 1) return d + S.gs1CheckDigit(d);
    return d;
};

const qrDraw = (payload, input) => draw(input.gs1 ? 'gs1qrcode' : 'qrcode', payload, { ...input, eclevel: input.ecc || 'M', rotate: 'N' });

const ENGINES = {
    barcode,
    qr: (input) => ({ data: { ...qrDraw(input.text, input), payload: input.text } }),
    wifiqr: (input) => { const payload = S.qrPayload('wifi', input); return { data: { ...qrDraw(payload, input), payload } }; },
    vcardqr: (input) => { const payload = S.qrPayload('contact', input); return { data: { ...qrDraw(payload, input), payload } }; },
    datamatrix: (input) => ({ data: draw(input.gs1 ? (input.shape === 'rectangle' ? 'gs1datamatrixrectangular' : 'gs1datamatrix') : 'datamatrix', input.text, { ...input, format: input.gs1 ? undefined : (input.shape === 'rectangle' ? 'rectangle' : 'square') }) }),
    code128: fixed('code128'),
    ean13: fixed('ean13', (t, i) => gtin(13)(t) + (i.addon ? ` ${i.addon}` : '')),
    upc: fixed('upca', (t, i) => { const d = String(t).replace(/[\s-]/g, ''); return (d.length === 8 ? d : gtin(12)(d)) + (i.addon ? ` ${i.addon}` : ''); }),
    pdf417: fixed('pdf417'),
    aztec: fixed('azteccode'),
    isbn: (input) => {
        const id = S.identifyNumber(input.text);
        if (!id || !['isbn10', 'isbn13'].includes(id.kind)) throw Object.assign(new Error('Not an ISBN: give 10 or 13 digits (an ISBN-13 starts with 978 or 979).'), { status: 422 });
        if (!id.valid) throw Object.assign(new Error(`The check digit should be ${id.expected}.`), { status: 422 });
        const thirteen = id.kind === 'isbn10' ? id.isbn13 : id.digits;
        const addon = input.addon ? ` ${input.addon}` : '';
        // Hyphens as printed on the copyright page go in the ISBN line above the bars (bwip-js's isbn symbol);
        // without them the line reads the bare number: hyphen positions depend on ISBN range tables.
        const typed = String(input.text).trim().replace(/^ISBN(?:-1[03])?:?\s*/i, '');
        const hyphenated = /^97[89]-\d+-\d+-\d+-\d$/.test(typed) && typed.length === 17 ? typed : null;
        const out = hyphenated ? draw('isbn', hyphenated + addon, input) : draw('ean13', thirteen + addon, { ...input, extratext: `ISBN ${thirteen}` });
        return { data: { ...out, isbn13: thirteen, isbn10: id.kind === 'isbn10' ? id.fixed : S.isbn13To10(thirteen) } };
    },
    // A number or a GS1 element string, explained.
    gs1: ({ text }) => {
        const number = S.identifyNumber(text, { complete: true });
        const element = /^\(\d{2,4}\)|^\]C1|^\]d2|^\]Q3|^0\d{15}/.test(String(text).trim()) ? S.parseGs1(text) : null;
        return { data: { number, gs1: element } };
    },
};

module.exports = { ENGINES, SYMBOLS, draw };
