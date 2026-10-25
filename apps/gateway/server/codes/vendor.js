'use strict';
// The barcode tools' browser libraries, served from this app's own node_modules (pinned to exact versions in
// package.json, never a CDN): /vendor/bwip-js@<v>/bwip-js.min.js draws every symbology, and
// /vendor/zxing-wasm@<v>/reader.js with its zxing_reader.wasm reads them (the page's locateFile points there).
// A version in the path means a new pin is a new URL, so every file is cached for a year.
const fs = require('fs');
const path = require('path');
const express = require('express');

const MODULES = path.join(__dirname, '..', '..', 'node_modules');
const versionOf = (name) => JSON.parse(fs.readFileSync(path.join(MODULES, name, 'package.json'), 'utf8')).version;

/** { '/vendor/bwip-js@4.11.4/bwip-js.min.js': { file, type } … } and the URLs the page uses. */
function files() {
    const bwip = versionOf('bwip-js');
    const zxing = versionOf('zxing-wasm');
    const js = 'application/javascript; charset=utf-8';
    return {
        urls: { bwip: `/vendor/bwip-js@${bwip}/bwip-js.min.js`, zxing: `/vendor/zxing-wasm@${zxing}/reader.js`, zxingWasm: `/vendor/zxing-wasm@${zxing}/zxing_reader.wasm` },
        map: {
            [`/vendor/bwip-js@${bwip}/bwip-js.min.js`]: { file: path.join(MODULES, 'bwip-js', 'dist', 'bwip-js-min.js'), type: js },
            [`/vendor/zxing-wasm@${zxing}/reader.js`]: { file: path.join(MODULES, 'zxing-wasm', 'dist', 'iife', 'reader', 'index.js'), type: js },
            [`/vendor/zxing-wasm@${zxing}/zxing_reader.wasm`]: { file: path.join(MODULES, 'zxing-wasm', 'dist', 'reader', 'zxing_reader.wasm'), type: 'application/wasm' },
        },
    };
}

function router() {
    const { map } = files();
    const r = express.Router();
    r.get(Object.keys(map), (req, res) => {
        const f = map[req.path];
        res.set({ 'Content-Type': f.type, 'Cache-Control': 'public, max-age=31536000, immutable', 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' });
        res.sendFile(f.file);
    });
    return r;
}

module.exports = { router, files };
