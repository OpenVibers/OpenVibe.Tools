/* The intelligence of the Barcode & QR tools (codes.html), with no DOM: what a piece of text is, which symbology fits it,
   check digits for GTIN / ISBN / SSCC / GLN, GS1 element strings, and the payloads a QR code carries (Wi-Fi, contact
   cards, events, mail, SMS, places). The browser loads it as window.OVCodesSmart; the tests require() it. */
(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.OVCodesSmart = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // ── Check digits ─────────────────────────────────────────────────────────────────────────────────────────────────
    /** The GS1 mod-10 check digit for the digits before it (GTIN-8/12/13/14, SSCC, GLN). */
    function gs1CheckDigit(body) {
        const d = String(body).replace(/\D/g, '');
        let sum = 0;
        for (let i = d.length - 1, w = 3; i >= 0; i--, w = 4 - w) sum += Number(d[i]) * w;
        return String((10 - (sum % 10)) % 10);
    }
    const gs1Valid = (code) => /^\d{2,18}$/.test(code) && gs1CheckDigit(code.slice(0, -1)) === code.slice(-1);
    /** ISBN-10's mod-11 check character (0-9 or X). */
    function isbn10Check(body) {
        const d = String(body).replace(/\D/g, '').slice(0, 9);
        let sum = 0;
        for (let i = 0; i < 9; i++) sum += Number(d[i]) * (10 - i);
        const c = (11 - (sum % 11)) % 11;
        return c === 10 ? 'X' : String(c);
    }
    const isbn10To13 = (isbn10) => { const b = `978${isbn10.slice(0, 9)}`; return b + gs1CheckDigit(b); };
    const isbn13To10 = (isbn13) => (/^978\d{10}$/.test(isbn13) ? isbn13.slice(3, 12) + isbn10Check(isbn13.slice(3, 12)) : null);
    /** UPC-E (8 digits, number system 0 or 1) expanded to its UPC-A. */
    function upceToUpca(upce) {
        if (!/^[01]\d{7}$/.test(upce)) return null;
        const [ns, m, c] = [upce[0], upce.slice(1, 7), upce[7]];
        const l = m[5];
        let body;
        if ('012'.includes(l)) body = `${m.slice(0, 2)}${l}0000${m.slice(2, 5)}`;
        else if (l === '3') body = `${m.slice(0, 3)}00000${m.slice(3, 5)}`;
        else if (l === '4') body = `${m.slice(0, 4)}00000${m[4]}`;
        else body = `${m.slice(0, 5)}0000${l}`;
        return `${ns}${body}${c}`;
    }

    // ── What a number is ─────────────────────────────────────────────────────────────────────────────────────────────
    const NOTES = {
        gtin8: 'GTIN-8: small packs, printed as EAN-8.', upce: 'UPC-E: the zero-suppressed form of a UPC-A, for small packs.',
        upca: 'UPC-A (GTIN-12): retail in North America.', ean13: 'EAN-13 (GTIN-13): retail worldwide.',
        isbn13: 'ISBN-13: a book number, printed as an EAN-13.', isbn10: 'ISBN-10: printed as its ISBN-13 (978 prefix) in an EAN-13.',
        issn: 'ISSN in an EAN-13 (977 prefix): a magazine or journal.', gtin14: 'GTIN-14: a case of a product, printed as ITF-14 on cartons.',
        sscc: 'SSCC: a shipping container or pallet, printed in GS1-128 as (00).',
    };
    /**
     * A GS1 number in any of its forms → { kind, valid, digits, expected, fixed, symbology, encode, note }: kind gtin8 |
     * upce | upca | ean13 | isbn13 | isbn10 | issn | gtin14 | sscc; `expected` is the right check digit, `fixed` the
     * number carrying it, `symbology` + `encode` what to hand bwip-js. With { complete: true } a body one digit short of
     * a GTIN or SSCC gets its check digit (`missing: true`). null when it is not a GS1 number.
     */
    function identifyNumber(input, opts = {}) {
        const raw = String(input || '').trim().replace(/^ISBN(?:-1[03])?:?\s*/i, '');
        const compact = raw.replace(/[\s-]/g, '');
        if (/^\d{9}[\dX]$/i.test(compact)) {
            const expected = isbn10Check(compact.slice(0, 9));
            const valid = compact[9].toUpperCase() === expected;
            // Ten digits that are not a valid ISBN are just a number (a phone number, an order number).
            if (valid || /X$/i.test(compact)) {
                const fixed = compact.slice(0, 9) + expected;
                const isbn13 = isbn10To13(fixed);
                return { kind: 'isbn10', valid, digits: compact.toUpperCase(), expected, fixed, isbn13, symbology: 'ean13', encode: isbn13, note: NOTES.isbn10 };
            }
            return null;
        }
        if (!/^\d+$/.test(compact)) return null;
        const n = compact.length;
        const by = { 8: 'gtin8', 12: 'upca', 13: 'ean13', 14: 'gtin14', 18: 'sscc' };
        if (by[n]) {
            const expected = gs1CheckDigit(compact.slice(0, -1));
            const valid = expected === compact.slice(-1);
            const fixed = compact.slice(0, -1) + expected;
            let kind = n === 13 && /^97[89]/.test(compact) ? 'isbn13' : n === 13 && /^977/.test(compact) ? 'issn' : by[n];
            // Eight digits from 0 or 1 may be a UPC-E: its check digit is its UPC-A's.
            const upca = n === 8 && /^[01]/.test(compact) ? upceToUpca(compact) : null;
            const asUpce = upca && gs1Valid(upca);
            if (asUpce && !valid) kind = 'upce';
            const symbology = { gtin8: 'ean8', upce: 'upce', upca: 'upca', ean13: 'ean13', isbn13: /^97[89]-\d+-\d+-\d+-\d$/.test(raw) && raw.length === 17 ? 'isbn' : 'ean13', issn: 'ean13', gtin14: 'itf14', sscc: 'gs1-128' }[kind];
            const encode = kind === 'sscc' ? `(00)${fixed}` : symbology === 'isbn' ? raw : kind === 'upce' ? compact : fixed;
            return {
                kind, valid: kind === 'upce' ? true : valid, digits: compact, expected: kind === 'upce' ? compact[7] : expected, fixed: kind === 'upce' ? compact : fixed,
                symbology, encode, note: NOTES[kind],
                ...(kind === 'isbn13' ? { isbn10: isbn13To10(compact) } : {}), ...(asUpce ? { upca } : {}),
            };
        }
        if (opts.complete && [7, 11, 17].includes(n)) {
            const fixed = compact + gs1CheckDigit(compact);
            const id = identifyNumber(fixed);
            if (id) return { ...id, valid: false, missing: true, digits: compact, note: `${id.note} Check digit ${fixed.slice(-1)} added.` };
        }
        return null;
    }

    // ── GS1 element strings ──────────────────────────────────────────────────────────────────────────────────────────
    // The Application Identifiers people meet on labels: { title, fixed length | max length, numeric }.
    const AI = {
        '00': { t: 'SSCC (serial shipping container)', n: 18, num: true }, '01': { t: 'GTIN', n: 14, num: true }, '02': { t: 'GTIN of contained items', n: 14, num: true },
        '10': { t: 'Batch or lot', max: 20 }, '11': { t: 'Production date (YYMMDD)', n: 6, num: true, date: true }, '12': { t: 'Due date (YYMMDD)', n: 6, num: true, date: true },
        '13': { t: 'Packaging date (YYMMDD)', n: 6, num: true, date: true }, '15': { t: 'Best before (YYMMDD)', n: 6, num: true, date: true }, '16': { t: 'Sell by (YYMMDD)', n: 6, num: true, date: true },
        '17': { t: 'Expiry (YYMMDD)', n: 6, num: true, date: true }, '20': { t: 'Variant', n: 2, num: true }, '21': { t: 'Serial number', max: 20 }, '22': { t: 'Consumer product variant', max: 20 },
        '30': { t: 'Count of items', max: 8, num: true }, '37': { t: 'Count of trade items', max: 8, num: true },
        '240': { t: 'Additional product id', max: 30 }, '241': { t: 'Customer part number', max: 30 }, '250': { t: 'Secondary serial', max: 30 },
        '400': { t: 'Customer purchase order', max: 30 }, '401': { t: 'Consignment number', max: 30 }, '402': { t: 'Shipment id', n: 17, num: true },
        '410': { t: 'Ship to (GLN)', n: 13, num: true }, '414': { t: 'Physical location (GLN)', n: 13, num: true }, '420': { t: 'Ship to postal code', max: 20 },
        '422': { t: 'Country of origin (ISO 3166)', n: 3, num: true }, '3103': { t: 'Net weight, kg (3 decimals)', n: 6, num: true, dec: 3 }, '3102': { t: 'Net weight, kg (2 decimals)', n: 6, num: true, dec: 2 },
        '3922': { t: 'Price to pay (2 decimals)', max: 15, num: true, dec: 2 }, '8004': { t: 'GIAI (asset id)', max: 30 }, '8005': { t: 'Price per unit', n: 6, num: true },
        '8200': { t: 'Product URL', max: 70 }, '90': { t: 'Company internal', max: 30 },
    };
    const aiOf = (s, i) => { for (const len of [4, 3, 2]) { const k = s.slice(i, i + len); if (AI[k]) return k; } return null; };
    /**
     * "(01)09506000134352(17)251231(10)ABC" or the raw form with GS (\x1d) or "|" separators →
     * { ok, parts: [{ ai, title, value, valid?, display }], error? }.
     */
    function parseGs1(input) {
        const s = String(input || '').trim();
        const parts = [];
        if (/^\(\d{2,4}\)/.test(s)) {
            const re = /\((\d{2,4})\)([^(]*)/g; let m;
            while ((m = re.exec(s))) parts.push({ ai: m[1], value: m[2] });
        } else {
            const raw = s.replace(/^\]C1|^\]d2|^\]Q3/, '');
            let i = 0;
            while (i < raw.length) {
                const ai = aiOf(raw, i);
                if (!ai) return { ok: false, parts, error: `No Application Identifier at "${raw.slice(i, i + 6)}"` };
                i += ai.length;
                const def = AI[ai];
                let end;
                if (def.n) end = i + def.n;
                else { const gs = raw.slice(i).search(/[\x1d|]/); end = gs < 0 ? raw.length : i + gs; }
                parts.push({ ai, value: raw.slice(i, end) });
                i = end;
                if (raw[i] === '\x1d' || raw[i] === '|') i++;
            }
        }
        if (!parts.length) return { ok: false, parts, error: 'No Application Identifiers found' };
        let ok = true;
        for (const p of parts) {
            const def = AI[p.ai];
            p.title = def ? def.t : 'Unknown Application Identifier';
            const errs = [];
            if (!def) errs.push('unknown');
            else {
                if (def.n && p.value.length !== def.n) errs.push(`needs ${def.n} characters`);
                if (def.max && p.value.length > def.max) errs.push(`at most ${def.max} characters`);
                if (def.num && !/^\d*$/.test(p.value)) errs.push('digits only');
                if ((p.ai === '01' || p.ai === '02' || p.ai === '00' || p.ai === '410' || p.ai === '414') && /^\d+$/.test(p.value) && !gs1Valid(p.value)) errs.push(`check digit should be ${gs1CheckDigit(p.value.slice(0, -1))}`);
                if (def.date && /^\d{6}$/.test(p.value)) {
                    const [yy, mm, dd] = [p.value.slice(0, 2), p.value.slice(2, 4), p.value.slice(4, 6)];
                    if (+mm < 1 || +mm > 12 || +dd > 31) errs.push('not a date');
                    else p.display = `20${yy}-${mm}-${dd === '00' ? 'end of month' : dd}`;
                }
                if (def.dec && /^\d+$/.test(p.value)) p.display = (Number(p.value) / 10 ** def.dec).toFixed(def.dec);
            }
            p.valid = !errs.length;
            if (errs.length) { p.error = errs.join(', '); ok = false; }
        }
        return { ok, parts };
    }
    /** Parts back into the bracketed form bwip-js takes for gs1-128, gs1datamatrix and gs1qrcode. */
    const gs1Text = (parts) => parts.map((p) => `(${p.ai})${p.value}`).join('');

    // ── QR payloads ──────────────────────────────────────────────────────────────────────────────────────────────────
    const escWifi = (s) => String(s || '').replace(/([\\;,:"])/g, '\\$1');
    const escV = (s) => String(s || '').replace(/([\\;,])/g, '\\$1').replace(/\r?\n/g, '\\n');
    const pad = (n) => String(n).padStart(2, '0');
    const icsDate = (v) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? '' : `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`; };
    /** The text a QR code carries for a content type and its fields. */
    function qrPayload(type, f = {}) {
        switch (type) {
            case 'url': { const u = String(f.url || '').trim(); return u && !/^[a-z][a-z0-9+.-]*:/i.test(u) ? `https://${u}` : u; }
            case 'wifi': return `WIFI:T:${f.security === 'nopass' ? 'nopass' : f.security || 'WPA'};S:${escWifi(f.ssid)};${f.security === 'nopass' ? '' : `P:${escWifi(f.password)};`}${f.hidden ? 'H:true;' : ''};`;
            case 'contact': return ['BEGIN:VCARD', 'VERSION:3.0', `N:${escV(f.last)};${escV(f.first)};;;`, `FN:${escV([f.first, f.last].filter(Boolean).join(' '))}`, f.org && `ORG:${escV(f.org)}`, f.title && `TITLE:${escV(f.title)}`,
                f.phone && `TEL;TYPE=CELL:${escV(f.phone)}`, f.email && `EMAIL:${escV(f.email)}`, f.url && `URL:${escV(f.url)}`, f.address && `ADR;TYPE=WORK:;;${escV(f.address)};;;;`, 'END:VCARD'].filter(Boolean).join('\n');
            case 'email': { const q = [f.subject && `subject=${encodeURIComponent(f.subject)}`, f.body && `body=${encodeURIComponent(f.body)}`].filter(Boolean).join('&'); return `mailto:${String(f.to || '').trim()}${q ? `?${q}` : ''}`; }
            case 'sms': return `SMSTO:${String(f.phone || '').replace(/[^\d+]/g, '')}:${f.message || ''}`;
            case 'phone': return `tel:${String(f.phone || '').replace(/[^\d+]/g, '')}`;
            case 'geo': return `geo:${Number(f.lat) || 0},${Number(f.lng) || 0}${f.label ? `?q=${encodeURIComponent(f.label)}` : ''}`;
            case 'event': return ['BEGIN:VEVENT', `SUMMARY:${escV(f.title)}`, f.start && `DTSTART:${icsDate(f.start)}`, f.end && `DTEND:${icsDate(f.end)}`, f.location && `LOCATION:${escV(f.location)}`, f.notes && `DESCRIPTION:${escV(f.notes)}`, 'END:VEVENT'].filter(Boolean).join('\n');
            default: return String(f.text || '');
        }
    }

    const RETAIL = /^(EAN|UPC|ITF|ISBN|GTIN|DataBar)/i;
    /**
     * What a scanned code's text is, with the details worth showing: { type, title, fields, href? }. `format` is the
     * scanner's name for the symbology (EAN-13, Code128, QRCode…): digits read from a Code 128 are not a product.
     */
    function describePayload(text, format) {
        const t = String(text || '');
        const kv = (body) => { const out = {}; const re = /([A-Z]+):((?:\\.|[^;])*);/g; let m; while ((m = re.exec(body))) out[m[1]] = m[2].replace(/\\(.)/g, '$1'); return out; };
        if (/^WIFI:/i.test(t)) { const w = kv(t.slice(5)); return { type: 'wifi', title: 'Wi-Fi network', fields: [['Network', w.S || ''], ['Password', w.P || '(none)'], ['Security', w.T || 'WPA'], ...(w.H === 'true' ? [['Hidden', 'yes']] : [])] }; }
        if (/^BEGIN:VCARD/i.test(t)) {
            const line = (k) => { const m = new RegExp(`^${k}[^:\\n]*:(.*)$`, 'mi').exec(t); return m ? m[1].replace(/\\([,;\\])/g, '$1').replace(/\\n/g, ' ') : ''; };
            return { type: 'contact', title: 'Contact card', fields: [['Name', line('FN')], ['Phone', line('TEL')], ['Email', line('EMAIL')], ['Organisation', line('ORG')], ['Website', line('URL')]].filter((f) => f[1]) };
        }
        if (/^BEGIN:VEVENT/i.test(t)) { const line = (k) => { const m = new RegExp(`^${k}[^:\\n]*:(.*)$`, 'mi').exec(t); return m ? m[1] : ''; }; return { type: 'event', title: 'Calendar event', fields: [['Title', line('SUMMARY')], ['Starts', line('DTSTART')], ['Ends', line('DTEND')], ['Where', line('LOCATION')]].filter((f) => f[1]) }; }
        if (/^mailto:/i.test(t)) return { type: 'email', title: 'Email', fields: [['To', decodeURIComponent(t.slice(7).split('?')[0])]], href: t };
        if (/^(SMSTO|smsto|sms):/.test(t)) { const [, num, msg] = t.split(':'); return { type: 'sms', title: 'Text message', fields: [['To', num || ''], ['Message', msg || '']] }; }
        if (/^tel:/i.test(t)) return { type: 'phone', title: 'Phone number', fields: [['Number', t.slice(4)]], href: t };
        if (/^geo:/i.test(t)) { const [lat, lng] = t.slice(4).split(/[,?]/); return { type: 'geo', title: 'Place', fields: [['Latitude', lat], ['Longitude', lng]], href: `https://www.openstreetmap.org/?mlat=${encodeURIComponent(lat)}&mlon=${encodeURIComponent(lng)}#map=16/${encodeURIComponent(lat)}/${encodeURIComponent(lng)}` }; }
        if (/^https?:\/\/\S+$/i.test(t)) { let host = ''; try { host = new URL(t).host; } catch { host = ''; } return { type: 'url', title: 'Link', fields: [['Site', host]], href: t }; }
        const num = !format || RETAIL.test(format) ? identifyNumber(t) : null;
        if (num && num.valid) return { type: 'product', title: { isbn10: 'Book (ISBN-10)', isbn13: 'Book (ISBN)', issn: 'Magazine (ISSN)', sscc: 'Shipping container (SSCC)', gtin14: 'Product case (GTIN-14)' }[num.kind] || 'Product number', fields: [['Number', num.digits], ['Check digit', num.valid ? 'correct' : `wrong (should be ${num.expected})`]] };
        if (/^\(\d{2,4}\)/.test(t) || /^\]C1|^\]d2/.test(t)) { const g = parseGs1(t); if (g.parts.length) return { type: 'gs1', title: 'GS1 data', fields: g.parts.map((p) => [`(${p.ai}) ${p.title}`, p.display || p.value]) }; }
        return { type: 'text', title: 'Text', fields: [] };
    }

    // ── Which code for a piece of text ───────────────────────────────────────────────────────────────────────────────
    /**
     * Free text → { symbology, why, fixed?, warnings[] }: the barcode that fits it best, with the reason (a valid
     * GTIN goes in its retail barcode, a GS1 string in GS1-128, digits in Code 128 or ITF, long or Unicode text in a 2D
     * code), any correction (a wrong check digit) and warnings.
     */
    function recommend(text) {
        const t = String(text || '');
        const warnings = [];
        if (!t.trim()) return { symbology: 'qrcode', why: 'Type something to encode.', warnings };
        const num = identifyNumber(t);
        // A valid GTIN, or 12-13 digits (a retail number with a typo in its check digit); other digit runs are just numbers.
        if (num && (num.valid || ['upca', 'ean13', 'isbn13', 'issn'].includes(num.kind))) {
            if (!num.valid) warnings.push(`The check digit is ${num.digits.slice(-1)}; for this number it should be ${num.expected}.`);
            return { symbology: num.symbology, encode: num.valid ? num.encode : undefined, why: num.note, fixed: num.valid ? undefined : num.fixed, kind: num.kind, warnings };
        }
        if (/^\(\d{2,4}\)/.test(t)) {
            const g = parseGs1(t);
            g.parts.filter((p) => p.error).forEach((p) => warnings.push(`(${p.ai}) ${p.title}: ${p.error}.`));
            return { symbology: t.length > 48 ? 'gs1datamatrix' : 'gs1-128', why: t.length > 48 ? 'A long GS1 element string fits best in GS1 DataMatrix.' : 'GS1 element strings (AIs in brackets) go in GS1-128 on cartons, or GS1 DataMatrix when space is tight.', warnings };
        }
        // eslint-disable-next-line no-control-regex
        const ascii = /^[\x20-\x7e]*$/.test(t);
        if (/^https?:\/\//i.test(t) || t.length > 60 || !ascii || /\n/.test(t)) {
            return { symbology: 'qrcode', why: !ascii ? 'Accents, emoji and other scripts need a 2D code: QR handles them as UTF-8.' : /^https?:\/\//i.test(t) ? 'A link is best as a QR code: every phone camera opens it.' : 'Long text fits a 2D code; QR is the one every phone reads.', warnings };
        }
        if (/^\d+$/.test(t)) return t.length % 2 === 0 && t.length >= 6 ? { symbology: 'interleaved2of5', why: 'An even number of digits packs tightly in Interleaved 2 of 5 (Code 128 works too).', warnings } : { symbology: 'code128', why: 'Digits: Code 128 is compact and read by every scanner.', warnings };
        if (/^[0-9A-Z \-.$/+%]+$/.test(t)) return { symbology: 'code39', why: 'Upper-case letters, digits and - . $ / + %: Code 39 is the classic for parts and badges (Code 128 is denser).', warnings };
        return { symbology: 'code128', why: 'Mixed text up to 60 characters: Code 128 is the dense, universal 1D choice.', warnings };
    }

    /** How big to print a code: a 1D/2D code's width in mm for a scanning distance in cm (rule of thumb 10:1 for QR). */
    const qrSizeFor = (distanceCm) => Math.max(10, Math.round((distanceCm * 10) / 10));
    /** WCAG-style contrast between two hex colours (1-21): scanners want dark on light and at least ~4:1. */
    function contrast(a, b) {
        const lum = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(h).trim()); if (!m) return 0; return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0); };
        const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
        return (x + 0.05) / (y + 0.05);
    }

    return { gs1CheckDigit, gs1Valid, isbn10Check, isbn10To13, isbn13To10, upceToUpca, identifyNumber, parseGs1, gs1Text, AI, qrPayload, describePayload, recommend, qrSizeFor, contrast };
});
