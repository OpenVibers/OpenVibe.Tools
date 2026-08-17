'use strict';

// ═══════════════════════════════════════════════════════════════
// Docs.OpenVibe — PDF Metadata Tool
// View and edit PDF metadata (title, author, subject, etc.).
// ═══════════════════════════════════════════════════════════════

const { PDFDocument } = require('pdf-lib');

/**
 * Get or update PDF metadata.
 * @param {Buffer} buffer - PDF buffer
 * @param {Object} options - { title, author, subject, keywords, mode: 'view'|'edit' }
 * @returns {{ buffer?: Buffer, ext: string, mime: string, metadata: Object }}
 */
async function metadata(buffer, options = {}) {
    const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const pageCount = src.getPageCount();

    // Get current metadata
    const current = {
        title: src.getTitle() || '',
        author: src.getAuthor() || '',
        subject: src.getSubject() || '',
        creator: src.getCreator() || '',
        producer: src.getProducer() || '',
        creationDate: src.getCreationDate()?.toISOString() || '',
        modificationDate: src.getModificationDate()?.toISOString() || '',
        pageCount,
    };

    if (options.mode === 'view' || (!options.title && !options.author && !options.subject && !options.keywords)) {
        // View mode — return metadata without modifying
        return {
            ext: 'pdf',
            mime: 'application/pdf',
            metadata: current,
            pageCount,
            viewOnly: true,
        };
    }

    // Edit mode — update metadata fields
    if (options.title !== undefined) src.setTitle(options.title);
    if (options.author !== undefined) src.setAuthor(options.author);
    if (options.subject !== undefined) src.setSubject(options.subject);
    if (options.keywords !== undefined) {
        const kw = Array.isArray(options.keywords)
            ? options.keywords
            : String(options.keywords).split(',').map(s => s.trim());
        src.setKeywords(kw);
    }
    if (options.creator !== undefined) src.setCreator(options.creator);

    src.setModificationDate(new Date());

    const outputBytes = await src.save();

    return {
        buffer: Buffer.from(outputBytes),
        ext: 'pdf',
        mime: 'application/pdf',
        metadata: {
            ...current,
            title: options.title ?? current.title,
            author: options.author ?? current.author,
            subject: options.subject ?? current.subject,
            modificationDate: new Date().toISOString(),
        },
        pageCount,
    };
}

module.exports = metadata;
