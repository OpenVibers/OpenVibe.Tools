'use strict';
// ═══════════════════════════════════════════════════════════════
// Img.OpenVibe — what a worker thread of the pool runs (apps/_shared/jobs/pool.js).
//
// Every image operation (sharp, and the JavaScript BMP/ICO codecs) happens here, off the event loop:
// the synchronous endpoints and the img.process job both send it through the pool (process.js
// runProcess), so they share its concurrency cap, its heap limit and terminate-on-timeout or cancel.
// ═══════════════════════════════════════════════════════════════

const { processBuffer } = require('./process');

module.exports = {
    /** { tool, buffer, options } → { buffer, ext, mime, … } */
    async process({ tool, buffer, options }) {
        return processBuffer(Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength), tool, options || {});
    },
};
