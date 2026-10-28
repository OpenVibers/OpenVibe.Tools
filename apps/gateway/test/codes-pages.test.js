'use strict';
// The Barcode & QR tools end to end, without a browser:
//   • every catalogue code tool has a view in app.js, its own <title>, description and canonical from server/seo, and
//     its family breadcrumb (Barcode & QR Tools)
//   • codes.html loads the vendor files at the URLs server/codes/vendor.js serves (the pinned versions)
//   • GET /api/codes/<symbology>.svg|png draws, caches for a year, refuses what cannot be drawn, and lists symbologies
//   • what bwip-js draws reads back with the ZXing reader the scanner uses (zxing-wasm, from this app's node_modules)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const PUB = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUB, 'codes.html'), 'utf8');
const app = fs.readFileSync(path.join(PUB, 'js', 'codes', 'app.js'), 'utf8');
const { CATALOG } = require('../server/seo/catalog');
const { renderTool } = require('../server/seo/render');
const vendor = require('../server/codes/vendor').files();
const bwipjs = require('bwip-js');

(async () => {
    // ── Pages ──
    const ids = [...CATALOG.values()].filter((r) => r.family === 'codes').map((r) => r.sub);
    assert.strictEqual(ids.length, 15, 'the hub and 14 tools');
    for (const id of ids) {
        assert.match(app, new RegExp(`^\\s{8}${id}: \\{ view: '`, 'm'), `${id} has a view in app.js`);
        const page = renderTool(path.join(PUB, 'codes.html'), id, null);
        const rec = CATALOG.get(id);
        assert.ok(page.includes(`<title>${rec.title.replace(/&/g, '&amp;')} | OpenVibe</title>`), `${id}: its own title`);
        assert.ok(page.includes(`<meta name="ov-tool" content="${id}">`), `${id}: the page knows which tool it is`);
        assert.ok(page.includes('"name":"Barcode & QR Tools","item":"https://barcodes.openvibe.tools"'), `${id}: breadcrumb to the family hub`);
        assert.ok(page.includes('id="about-this-tool"'), `${id}: the crawlable about block`);
        if (page.includes('id="ov-footer"')) assert.ok(page.indexOf('id="about-this-tool"') < page.indexOf('id="ov-footer"'), `${id}: the about block is above the footer, not after it`);
    }
    assert.ok(renderTool(path.join(PUB, 'codes.html'), 'qr', 'qr-code-generator.openvibe.tools').includes('<link rel="canonical" href="https://qr-code-generator.openvibe.tools">'), 'canonical from the registry');
    // Every generator page tells bots and scripts about the image API.
    assert.ok(CATALOG.get('qr').faq.some(([q, a]) => /script|AI agent/.test(q) && a.includes('/api/codes/qrcode.svg')), 'the API answer in the FAQ');

    // ── Vendor files: the page asks for exactly what the server serves ──
    for (const url of [vendor.urls.bwip, vendor.urls.zxing]) assert.ok(html.includes(`src="${url}"`) || html.includes(`data-zxing="${url}"`), `codes.html loads ${url}`);
    assert.ok(html.includes(`data-zxing-wasm="${vendor.urls.zxingWasm}"`), 'the reader finds its WebAssembly on this host');
    for (const f of Object.values(vendor.map)) assert.ok(fs.statSync(f.file).size > 10000, `${f.file} exists`);

    // ── The image API ──
    const srv = http.createServer(express().use(require('../server/codes/image').router()));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    try {
        const svg = await fetch(`${base}/api/codes/qr.svg?text=hello`);
        assert.strictEqual(svg.status, 200);
        assert.match(svg.headers.get('content-type'), /^image\/svg\+xml/);
        assert.match(svg.headers.get('cache-control'), /max-age=31536000, immutable/);
        assert.strictEqual(svg.headers.get('access-control-allow-origin'), '*');
        assert.match(svg.headers.get('content-security-policy'), /default-src 'none'/);
        assert.match(await svg.text(), /^<svg /);
        const png = await fetch(`${base}/api/codes/ean13.png?text=400638133393`);
        assert.strictEqual(png.status, 200);
        const bytes = Buffer.from(await png.arrayBuffer());
        assert.strictEqual(bytes.subarray(1, 4).toString(), 'PNG');
        assert.strictEqual((await fetch(`${base}/api/codes/wifi.svg?ssid=Cafe&password=x`)).status, 200);
        assert.strictEqual((await fetch(`${base}/api/codes/auto.svg?text=0306406152`)).status, 200);
        const bad = await fetch(`${base}/api/codes/ean13.svg?text=letters`);
        assert.strictEqual(bad.status, 422);
        assert.match(await bad.text(), /EAN-13/);
        assert.strictEqual((await fetch(`${base}/api/codes/not-a-code.svg?text=a`)).status, 422);
        assert.strictEqual((await fetch(`${base}/api/codes/qrcode.svg`)).status, 422, 'text is required');
        const list = await (await fetch(`${base}/api/codes`)).json();
        assert.ok(list.symbologies.length > 100 && list.symbologies.some((s) => s.id === 'datamatrix'));
    } finally { srv.close(); }

    // ── Round trip: drawn by bwip-js, read by ZXing ──
    const Z = require('zxing-wasm/reader');
    Z.prepareZXingModule({ overrides: { wasmBinary: fs.readFileSync(vendor.map[vendor.urls.zxingWasm].file) } });
    for (const [bcid, text, want] of [
        ['qrcode', 'https://openvibe.tools', 'https://openvibe.tools'], ['ean13', '4006381333931', '4006381333931'], ['upca', '036000291452', '036000291452'],
        ['code128', 'OV-2026-0042', 'OV-2026-0042'], ['datamatrix', 'Data Matrix', 'Data Matrix'], ['gs1datamatrix', '(01)09506000134352(10)ABC', '(01)09506000134352(10)ABC'],
        ['pdf417', 'PDF417 here', 'PDF417 here'], ['azteccode', 'TICKET 4471', 'TICKET 4471'], ['itf14', '09506000134352', '09506000134352'], ['code39', 'ABC-123', 'ABC-123'],
    ]) {
        const buf = await bwipjs.toBuffer({ bcid, text, scale: 3, paddingwidth: 10, paddingheight: 10, backgroundcolor: 'ffffff', includetext: true });
        const found = await Z.readBarcodes(new Uint8Array(buf), { tryHarder: true });
        const norm = (s) => String(s).replace(/^0+(?=\d{12})/, '');
        assert.ok(found.some((f) => f.text === want || norm(f.text) === norm(want)), `${bcid}: read back ${JSON.stringify(found.map((f) => f.text))}`);
    }

    console.log(`codes pages: ${ids.length} pages, image API and 10 round trips: all checks passed`);
})().catch((err) => { console.error(err); process.exit(1); });
