'use strict';

// ═══════════════════════════════════════════════════════════════
// Docs.OpenVibe — PDF to Images Tool
// Renders PDF pages to PNG or JPEG with poppler (pdftoppm; pdfinfo counts the pages). One page
// comes back as an image, several as a ZIP of images. It used to draw a placeholder card with the
// page number. Without poppler-utils on the server the tool answers 503 tools.unavailable.
//
// How many pages one conversion may render depends on the resolution (PDF2IMG_MAX_PAGES, default
// 50 at up to 150 dpi; 20 up to 300 dpi; 5 above), so one request cannot produce gigabytes.
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pdftoppm, pdfinfo, run, withTempDir, checkPages, refuse, zip } = require('./pdf');

const MAX_PAGES = Math.max(1, parseInt(process.env.PDF2IMG_MAX_PAGES, 10) || 50);
const maxPagesAt = (dpi) => (dpi <= 150 ? MAX_PAGES : dpi <= 300 ? Math.max(1, Math.floor(MAX_PAGES * 0.4)) : Math.max(1, Math.floor(MAX_PAGES * 0.1)));

/**
 * @param {Buffer} buffer - PDF buffer
 * @param {Object} options - { format: 'png'|'jpg', dpi: 72–600, pages: 'all' | '1,3,5-7' }
 * @returns {{ buffer, ext, mime, pageCount, totalPages, pages }}
 */
async function pdf2img(buffer, options = {}) {
    const format = /^jpe?g$/i.test(String(options.format || options.defaultFormat || 'png')) ? 'jpg' : 'png';
    const dpi = Math.min(600, Math.max(72, parseInt(options.dpi, 10) || 150));
    const render = pdftoppm.path({ tool: 'pdf2img' });
    const info = pdfinfo.path({ tool: 'pdf2img' });

    return withTempDir(async (dir) => {
        const input = path.join(dir, 'in.pdf');
        await fsp.writeFile(input, buffer);

        const meta = await run(info, [input], { timeoutMs: 60_000 });
        if (meta.code !== 0) {
            if (/incorrect password|encrypted/i.test(meta.stderr)) throw refuse('This PDF is password-protected. Unlock it first.');
            throw refuse('This file could not be read as a PDF.');
        }
        const totalPages = parseInt((/^Pages:\s+(\d+)/m.exec(meta.stdout) || [])[1], 10);
        if (!totalPages) throw refuse('This PDF has no pages.');
        checkPages(totalPages);

        const wanted = parsePageList(options.pages, totalPages);
        if (!wanted.length) throw refuse(`No such pages: the PDF has ${totalPages}.`, 400);
        const limit = maxPagesAt(dpi);
        if (wanted.length > limit) {
            throw refuse(`At ${dpi} dpi at most ${limit} pages can be converted at once (you chose ${wanted.length}). Pick fewer pages or a lower resolution.`, 413, 'tools.pdf.too_many_pages');
        }

        // pdftoppm renders a contiguous range per run: one run per range of the selection.
        const out = path.join(dir, 'out');
        await fsp.mkdir(out);
        for (const [first, last] of toRanges(wanted)) {
            const r = await run(render, [
                format === 'jpg' ? '-jpeg' : '-png', ...(format === 'jpg' ? ['-jpegopt', 'quality=90'] : []),
                '-r', String(dpi), '-f', String(first), '-l', String(last),
                input, path.join(out, 'page'),
            ], { timeoutMs: 5 * 60_000 });
            if (r.code !== 0) throw refuse('The pages could not be rendered.');
        }
        const ext = format;
        const files = fs.readdirSync(out)
            .map(f => ({ f, n: parseInt((/-(\d+)\.(png|jpg)$/.exec(f) || [])[1], 10) }))
            .filter(x => Number.isFinite(x.n)).sort((a, b) => a.n - b.n);
        if (!files.length) throw refuse('The pages could not be rendered.');

        const mime = format === 'jpg' ? 'image/jpeg' : 'image/png';
        const pages = files.map(x => x.n);
        if (files.length === 1) {
            return { buffer: await fsp.readFile(path.join(out, files[0].f)), ext, mime, pageCount: 1, totalPages, pages };
        }
        const width = String(totalPages).length;
        const entries = [];
        for (const x of files) entries.push({ name: `page-${String(x.n).padStart(width, '0')}.${ext}`, data: await fsp.readFile(path.join(out, x.f)) });
        return {
            buffer: zip(entries), ext: 'zip', mime: 'application/zip',
            pageCount: files.length, totalPages, pages,
            note: `${files.length} pages as ${ext.toUpperCase()} images in one ZIP file.`,
        };
    });
}

/** '1,3,5-7' → [1,3,5,6,7] (sorted, unique, within 1…total); empty/'all' → every page. */
function parsePageList(input, totalPages) {
    if (!input || String(input).trim().toLowerCase() === 'all') {
        return Array.from({ length: totalPages }, (_, i) => i + 1);
    }
    const result = new Set();
    for (const part of String(input).split(',').map(s => s.trim()).filter(Boolean)) {
        const m = /^(\d+)\s*-\s*(\d+)$/.exec(part);
        if (m) {
            const start = Math.max(1, Number(m[1])), end = Math.min(totalPages, Number(m[2]));
            for (let i = start; i <= end; i++) result.add(i);
        } else if (/^\d+$/.test(part)) {
            const p = Number(part);
            if (p >= 1 && p <= totalPages) result.add(p);
        } else {
            throw refuse(`Not a page or range: ${part}`, 400);
        }
    }
    return [...result].sort((a, b) => a - b);
}

/** [1,2,3,5,7,8] → [[1,3],[5,5],[7,8]] */
function toRanges(pages) {
    const out = [];
    for (const p of pages) {
        const last = out[out.length - 1];
        if (last && p === last[1] + 1) last[1] = p; else out.push([p, p]);
    }
    return out;
}

pdf2img.parsePageList = parsePageList;
pdf2img.maxPagesAt = maxPagesAt;

module.exports = pdf2img;
