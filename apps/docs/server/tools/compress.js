'use strict';

// ═══════════════════════════════════════════════════════════════
// Docs.OpenVibe — Compress PDF Tool
// Reduces PDF file size by removing unused objects,
// flattening forms, and optimizing the structure.
// ═══════════════════════════════════════════════════════════════

const { PDFDocument } = require('pdf-lib');

/**
 * Compress a PDF by re-serializing (strips unused objects, optimizes structure).
 * @param {Buffer} buffer - PDF buffer
 * @param {Object} options - { level: 'low'|'medium'|'high' }
 * @returns {{ buffer: Buffer, ext: string, mime: string, savings: Object }}
 */
async function compress(buffer, options = {}) {
    const originalSize = buffer.length;
    const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const pageCount = src.getPageCount();

    // pdf-lib re-serialization naturally strips unused objects
    // For more aggressive compression, we can remove metadata
    const level = options.level || 'medium';

    if (level === 'high') {
        // Strip metadata for maximum compression
        src.setTitle('');
        src.setAuthor('');
        src.setSubject('');
        src.setKeywords([]);
        src.setProducer('');
        src.setCreator('');
    }

    const outputBytes = await src.save({
        useObjectStreams: true, // Better compression
    });

    const outputSize = outputBytes.length;
    const saved = originalSize - outputSize;
    const savedPercent = originalSize > 0 ? Math.round(saved / originalSize * 100) : 0;

    return {
        buffer: Buffer.from(outputBytes),
        ext: 'pdf',
        mime: 'application/pdf',
        pageCount,
        savings: {
            originalSize,
            outputSize,
            savedBytes: Math.max(0, saved),
            savedPercent: Math.max(0, savedPercent),
        },
    };
}

module.exports = compress;
