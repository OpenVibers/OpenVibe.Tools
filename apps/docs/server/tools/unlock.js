'use strict';

// ═══════════════════════════════════════════════════════════════
// Docs.OpenVibe — Unlock PDF Tool
// Attempts to remove password protection from a PDF.
// ═══════════════════════════════════════════════════════════════

const { PDFDocument } = require('pdf-lib');

/**
 * Remove password from a PDF.
 * @param {Buffer} buffer - PDF buffer
 * @param {Object} options - { password: string (current password) }
 * @returns {{ buffer: Buffer, ext: string, mime: string }}
 */
async function unlock(buffer, options = {}) {
    // Attempt to load with the provided password
    // pdf-lib's ignoreEncryption flag allows reading without a password
    // for PDFs with owner-only restrictions
    try {
        const src = await PDFDocument.load(buffer, {
            ignoreEncryption: true,
            password: options.password || undefined,
        });

        const pageCount = src.getPageCount();

        // Re-serialize without encryption
        const outputBytes = await src.save();

        return {
            buffer: Buffer.from(outputBytes),
            ext: 'pdf',
            mime: 'application/pdf',
            pageCount,
        };
    } catch (err) {
        if (err.message.includes('password') || err.message.includes('encrypted')) {
            throw new Error('Could not unlock the PDF. The password may be incorrect or the encryption is too strong.');
        }
        throw err;
    }
}

module.exports = unlock;
