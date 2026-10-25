/* Reading codes for the Barcode & QR tools (codes.html): the ZXing reader (zxing-wasm, served from /vendor on this
   host, loaded on first use) and the browser's own BarcodeDetector where it has one. Both answer the same shape:
   [{ text, format, label, box: [[x, y] × 4] }]. window.OVCodesRead. */
(function (root) {
    'use strict';

    // The page sets these from its <script data-*> (the versioned /vendor URLs).
    const cfg = { zxing: '', zxingWasm: '' };
    let zxingReady = null;

    // ZXing's format names → what people call them.
    const LABELS = {
        QRCode: 'QR Code', MicroQRCode: 'Micro QR', RMQRCode: 'rMQR', DataMatrix: 'Data Matrix', Aztec: 'Aztec', AztecRune: 'Aztec Rune', PDF417: 'PDF417', CompactPDF417: 'Compact PDF417',
        MicroPDF417: 'MicroPDF417', MaxiCode: 'MaxiCode', EAN13: 'EAN-13', EAN8: 'EAN-8', EAN5: 'EAN-5', EAN2: 'EAN-2', ISBN: 'ISBN', UPCA: 'UPC-A', UPCE: 'UPC-E', Code128: 'Code 128',
        Code39: 'Code 39', Code39Ext: 'Code 39 Extended', Code32: 'Code 32', PZN: 'PZN', Code93: 'Code 93', ITF: 'ITF', ITF14: 'ITF-14', Codabar: 'Codabar', DataBar: 'GS1 DataBar',
        DataBarOmni: 'GS1 DataBar', DataBarStk: 'GS1 DataBar Stacked', DataBarStkOmni: 'GS1 DataBar Stacked Omni', DataBarLtd: 'GS1 DataBar Limited', DataBarExp: 'GS1 DataBar Expanded',
        DataBarExpStk: 'GS1 DataBar Expanded Stacked', DXFilmEdge: 'DX Film Edge', Telepen: 'Telepen',
        // BarcodeDetector's names
        qr_code: 'QR Code', micro_qr_code: 'Micro QR', data_matrix: 'Data Matrix', aztec: 'Aztec', pdf417: 'PDF417', ean_13: 'EAN-13', ean_8: 'EAN-8', upc_a: 'UPC-A', upc_e: 'UPC-E',
        code_128: 'Code 128', code_39: 'Code 39', code_93: 'Code 93', itf: 'ITF', codabar: 'Codabar', databar: 'GS1 DataBar', databar_expanded: 'GS1 DataBar Expanded',
    };
    const label = (f) => LABELS[f] || String(f || '').replace(/_/g, ' ');

    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = src; s.async = true;
            s.onload = resolve; s.onerror = () => reject(new Error('The barcode reader did not load. Check your connection and try again.'));
            document.head.appendChild(s);
        });
    }

    /** Load ZXing once: its script, then its WebAssembly from this host (never a CDN). */
    function zxing() {
        if (!zxingReady) {
            zxingReady = (async () => {
                if (!root.ZXingWASM) await loadScript(cfg.zxing);
                await root.ZXingWASM.prepareZXingModule({
                    overrides: { locateFile: (path, prefix) => (path.endsWith('.wasm') ? cfg.zxingWasm : prefix + path) },
                    fireImmediately: true,
                });
                return root.ZXingWASM;
            })();
            zxingReady.catch(() => { zxingReady = null; });
        }
        return zxingReady;
    }

    const boxOf = (p) => (p ? [[p.topLeft.x, p.topLeft.y], [p.topRight.x, p.topRight.y], [p.bottomRight.x, p.bottomRight.y], [p.bottomLeft.x, p.bottomLeft.y]] : null);

    /** Every code in an ImageData, a Blob or an image file, with ZXing. o: { tryHarder, max } */
    async function readZxing(input, o = {}) {
        const Z = await zxing();
        const res = await Z.readBarcodes(input, { tryHarder: o.tryHarder !== false, tryRotate: true, tryInvert: true, tryDownscale: true, maxNumberOfSymbols: o.max || 16, ...(o.formats ? { formats: o.formats } : {}) });
        return res.filter((r) => r.isValid).map((r) => ({ text: r.text, format: r.format, label: label(r.format), box: boxOf(r.position), engine: 'zxing', ecLevel: r.ecLevel || '', version: r.version || '', symbologyIdentifier: r.symbologyIdentifier || '' }));
    }

    let detector = null;
    /** The browser's BarcodeDetector, when it has one with formats (Chrome on Android and macOS, Safari 17+). */
    async function native() {
        if (detector !== null) return detector;
        detector = false;
        try {
            if ('BarcodeDetector' in root) {
                const formats = await root.BarcodeDetector.getSupportedFormats();
                if (formats && formats.length) detector = new root.BarcodeDetector({ formats });
            }
        } catch { detector = false; }
        return detector;
    }

    /** A video frame or a canvas, read by the native detector → same shape as readZxing. */
    async function readNative(source) {
        const d = await native();
        if (!d) return null;
        const found = await d.detect(source);
        return found.map((r) => ({ text: r.rawValue, format: r.format, label: label(r.format), box: (r.cornerPoints || []).map((p) => [p.x, p.y]), engine: 'native' }));
    }

    root.OVCodesRead = { cfg, zxing, readZxing, native, readNative, label };
})(typeof self !== 'undefined' ? self : this);
