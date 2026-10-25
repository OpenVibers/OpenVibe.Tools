'use strict';
// The Barcode & QR tools' logic (public/js/codes/smart.js), which runs in the browser and needs no DOM: check digits,
// what a number is, GS1 element strings, QR payloads and how a scanned text is described, and the symbology it
// recommends. Every barcode it recommends is then drawn by bwip-js, so a recommendation is never one bwip-js refuses.
const assert = require('assert');
const bwipjs = require('bwip-js');
const S = require('../public/js/codes/smart.js');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`ok - ${name}`); };

t('GS1 check digits', () => {
    assert.strictEqual(S.gs1CheckDigit('400638133393'), '1');            // EAN-13 4006381333931
    assert.strictEqual(S.gs1CheckDigit('03600029145'), '2');             // UPC-A 036000291452
    assert.strictEqual(S.gs1CheckDigit('9638507'), '4');                 // EAN-8 96385074
    assert.strictEqual(S.gs1CheckDigit('10614141123456789'), '7');       // SSCC 106141411234567897
    assert.ok(S.gs1Valid('4006381333931'));
    assert.ok(!S.gs1Valid('4006381333932'));
});

t('ISBN conversions', () => {
    assert.strictEqual(S.isbn10Check('030640615'), '2');
    assert.strictEqual(S.isbn10Check('080442957'), 'X');
    assert.strictEqual(S.isbn10To13('0306406152'), '9780306406157');
    assert.strictEqual(S.isbn13To10('9780306406157'), '0306406152');
    assert.strictEqual(S.isbn13To10('9791234567896'), null);             // 979 has no ISBN-10
});

t('UPC-E expands to its UPC-A', () => {
    assert.strictEqual(S.upceToUpca('01234565'), '012345000065');
    assert.strictEqual(S.upceToUpca('04252614'), '042100005264');
    assert.strictEqual(S.upceToUpca('21234565'), null);
});

t('identifyNumber names every GS1 form', () => {
    const k = (x, o) => (S.identifyNumber(x, o) || {}).kind;
    assert.strictEqual(k('4006381333931'), 'ean13');
    assert.strictEqual(k('036000291452'), 'upca');
    assert.strictEqual(k('96385074'), 'gtin8');
    assert.strictEqual(k('04252614'), 'upce');                            // not a valid EAN-8, a valid UPC-E
    assert.strictEqual(k('09506000134352'), 'gtin14');
    assert.strictEqual(k('106141411234567897'), 'sscc');
    assert.strictEqual(k('978-0-306-40615-7'), 'isbn13');
    assert.strictEqual(k('ISBN 0-306-40615-2'), 'isbn10');
    assert.strictEqual(k('9770317847001'), 'issn');
    assert.strictEqual(k('hello'), undefined);
    assert.strictEqual(k('5551234567'), undefined);                       // ten digits, not a valid ISBN: a number
    assert.strictEqual(k('0360002914'), undefined);
    const bad = S.identifyNumber('4006381333932');
    assert.strictEqual(bad.valid, false);
    assert.strictEqual(bad.expected, '1');
    assert.strictEqual(bad.fixed, '4006381333931');
    const isbn = S.identifyNumber('0306406152');
    assert.strictEqual(isbn.encode, '9780306406157');
    assert.strictEqual(S.identifyNumber('978-0-306-40615-7').symbology, 'isbn');   // hyphens as printed: the ISBN symbol
    assert.strictEqual(S.identifyNumber('9780306406157').symbology, 'ean13');
    assert.strictEqual(S.identifyNumber('106141411234567897').encode, '(00)106141411234567897');
    assert.strictEqual(S.identifyNumber('03600029145'), null);            // 11 digits: only with complete
    const done = S.identifyNumber('03600029145', { complete: true });
    assert.deepStrictEqual([done.kind, done.missing, done.fixed], ['upca', true, '036000291452']);
});

t('GS1 element strings, bracketed and raw', () => {
    const g = S.parseGs1('(01)09506000134352(17)251231(10)ABC123');
    assert.ok(g.ok);
    assert.deepStrictEqual(g.parts.map((p) => p.ai), ['01', '17', '10']);
    assert.strictEqual(g.parts[1].display, '2025-12-31');
    const raw = S.parseGs1('0109506000134352172512311' + '0ABC123\x1d21XYZ');
    assert.ok(raw.ok, JSON.stringify(raw));
    assert.deepStrictEqual(raw.parts.map((p) => [p.ai, p.value]), [['01', '09506000134352'], ['17', '251231'], ['10', 'ABC123'], ['21', 'XYZ']]);
    const sym = S.parseGs1(']d201095060001343521725123110ABC|21XYZ');
    assert.ok(sym.ok);
    assert.strictEqual(sym.parts.length, 4);
    const wrong = S.parseGs1('(01)09506000134353(17)251331');
    assert.ok(!wrong.ok);
    assert.match(wrong.parts[0].error, /check digit should be 2/);
    assert.match(wrong.parts[1].error, /not a date/);
    assert.strictEqual(S.parseGs1('(3103)001250').parts[0].display, '1.250');
    assert.strictEqual(S.gs1Text(g.parts), '(01)09506000134352(17)251231(10)ABC123');
    assert.ok(!S.parseGs1('hello').ok);
});

t('QR payloads', () => {
    assert.strictEqual(S.qrPayload('url', { url: 'openvibe.tools' }), 'https://openvibe.tools');
    assert.strictEqual(S.qrPayload('url', { url: 'mailto:x@y.z' }), 'mailto:x@y.z');
    assert.strictEqual(S.qrPayload('wifi', { ssid: 'Cafe;Net', password: 'p:w"d', security: 'WPA' }), 'WIFI:T:WPA;S:Cafe\\;Net;P:p\\:w\\"d;;');
    assert.strictEqual(S.qrPayload('wifi', { ssid: 'Open', security: 'nopass', hidden: true }), 'WIFI:T:nopass;S:Open;H:true;;');
    const card = S.qrPayload('contact', { first: 'Ada', last: 'Lovelace', org: 'Engines, Ltd', phone: '+44 1', email: 'ada@example.com' });
    assert.match(card, /^BEGIN:VCARD\nVERSION:3\.0\nN:Lovelace;Ada;;;\nFN:Ada Lovelace\nORG:Engines\\, Ltd\n/);
    assert.match(card, /END:VCARD$/);
    assert.strictEqual(S.qrPayload('email', { to: 'a@b.c', subject: 'Hi there' }), 'mailto:a@b.c?subject=Hi%20there');
    assert.strictEqual(S.qrPayload('sms', { phone: '+1 (555) 010-9999', message: 'yo' }), 'SMSTO:+15550109999:yo');
    assert.strictEqual(S.qrPayload('geo', { lat: 51.5, lng: -0.12, label: 'Here' }), 'geo:51.5,-0.12?q=Here');
    const ev = S.qrPayload('event', { title: 'Launch', start: '2026-11-01T18:00:00Z', end: '2026-11-01T19:00:00Z' });
    assert.match(ev, /DTSTART:20261101T180000Z\nDTEND:20261101T190000Z/);
    assert.strictEqual(S.qrPayload('text', { text: 'plain' }), 'plain');
});

t('describePayload reads what a scan found', () => {
    const w = S.describePayload('WIFI:T:WPA;S:Cafe\\;Net;P:secret;;');
    assert.strictEqual(w.type, 'wifi');
    assert.deepStrictEqual(w.fields[0], ['Network', 'Cafe;Net']);
    assert.strictEqual(S.describePayload('https://openvibe.tools/x').fields[0][1], 'openvibe.tools');
    assert.strictEqual(S.describePayload('BEGIN:VCARD\nFN:Ada Lovelace\nTEL:+44\nEND:VCARD').fields[0][1], 'Ada Lovelace');
    assert.strictEqual(S.describePayload('4006381333931', 'EAN-13').type, 'product');
    assert.strictEqual(S.describePayload('96385074', 'Code128').type, 'text');   // digits in a Code 128: not a product
    assert.strictEqual(S.describePayload('9780306406157').title, 'Book (ISBN)');
    assert.strictEqual(S.describePayload('(01)09506000134352(10)A1').type, 'gs1');
    assert.match(S.describePayload('geo:51.5,-0.12').href, /^https:\/\/www\.openstreetmap\.org\//);
    assert.strictEqual(S.describePayload('javascript:alert(1)').type, 'text');    // never a link
    assert.strictEqual(S.describePayload('javascript:alert(1)').href, undefined);
});

t('recommend picks a symbology that fits', () => {
    const r = (x) => S.recommend(x).symbology;
    assert.strictEqual(r('4006381333931'), 'ean13');
    assert.strictEqual(r('036000291452'), 'upca');
    assert.strictEqual(r('09506000134352'), 'itf14');
    assert.strictEqual(r('0306406152'), 'ean13');
    assert.strictEqual(r('(01)09506000134352(10)ABC'), 'gs1-128');
    assert.strictEqual(r('https://openvibe.tools'), 'qrcode');
    assert.strictEqual(r('héllo'), 'qrcode');
    assert.strictEqual(r('ABC-123'), 'code39');
    assert.strictEqual(r('Order #42'), 'code128');
    assert.strictEqual(r('12345'), 'code128');
    assert.strictEqual(r('123456'), 'interleaved2of5');
    const typo = S.recommend('4006381333932');
    assert.strictEqual(typo.fixed, '4006381333931');
    assert.match(typo.warnings[0], /should be 1/);
    assert.strictEqual(S.recommend('0306406152').encode, '9780306406157');
});

t('every recommendation is a code bwip-js draws', () => {
    for (const x of ['4006381333931', '036000291452', '96385074', '04252614', '09506000134352', '106141411234567897', '978-0-306-40615-7', '0306406152', '9770317847001',
        '(01)09506000134352(10)ABC', 'https://openvibe.tools', 'héllo ☃', 'ABC-123', 'Order #42', '12345', '123456']) {
        const rec = S.recommend(x);
        const text = rec.encode || rec.fixed || x;
        assert.doesNotThrow(() => bwipjs.toSVG({ bcid: rec.symbology, text }), `${x} → ${rec.symbology}`);
    }
});

t('contrast', () => {
    assert.ok(Math.abs(S.contrast('#000000', '#ffffff') - 21) < 0.01);
    assert.ok(S.contrast('#777777', '#888888') < 1.5);
});

console.log(`codes-smart: ${n} tests passed`);
