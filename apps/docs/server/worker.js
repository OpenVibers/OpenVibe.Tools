'use strict';
// ═══════════════════════════════════════════════════════════════
// Docs.OpenVibe — what a worker thread of the pool runs (apps/_shared/jobs/pool.js).
//
// pdf-lib work (merge, split, compress, rotate, reorder, watermark, metadata, and img2pdf with sharp)
// happens here, off the event loop: the synchronous endpoints and the docs.process job both send it
// through the pool (process.js runTool), so they share its concurrency cap, its heap limit and its
// terminate-on-timeout. The tools that shell out to qpdf or poppler (protect, unlock, pdf2img) keep
// running on the main thread: their work is in a child process with its own timeout already.
// ═══════════════════════════════════════════════════════════════

const { getTool } = require('./tools');

module.exports = {
    /** { tool, input: Buffer | Buffer[], options } → the tool's result ({ buffer, ext, mime, … }). */
    async process({ tool, input, options }) {
        const t = getTool(tool);
        if (!t) throw Object.assign(new Error(`Unknown tool: ${tool}`), { status: 400, code: 'tools.job.invalid' });
        const buffers = Array.isArray(input) ? input.map(b => Buffer.from(b.buffer, b.byteOffset, b.byteLength)) : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
        return t.handler(buffers, options || {});
    },
};
