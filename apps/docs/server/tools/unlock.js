'use strict';

// ═══════════════════════════════════════════════════════════════
// Docs.OpenVibe — Unlock PDF Tool
// Removes password protection from a PDF whose password you know (qpdf --decrypt). pdf-lib cannot
// decrypt, so the old version re-saved still-encrypted content. Without qpdf on the server the
// tool answers 503 tools.unavailable.
// ═══════════════════════════════════════════════════════════════

const fsp = require('fs/promises');
const path = require('path');
const { qpdf, run, withTempDir, stdinArgs, qpdfPages, checkPages, refuse } = require('./pdf');

/**
 * @param {Buffer} buffer - PDF buffer
 * @param {Object} options - { password: the current (user or owner) password }
 * @returns {{ buffer: Buffer, ext: string, mime: string, pageCount: number }}
 */
async function unlock(buffer, options = {}) {
    const password = String(options.password || '');
    const bin = qpdf.path({ tool: 'unlock' });

    return withTempDir(async (dir) => {
        const input = path.join(dir, 'in.pdf');
        const output = path.join(dir, 'out.pdf');
        await fsp.writeFile(input, buffer);

        const enc = await run(bin, ['--is-encrypted', input], { timeoutMs: 30_000 });
        if (enc.code === 2 && !/error|not a PDF|can't find/i.test(enc.stderr)) {
            const count = await qpdfPages(bin, dir, input);
            if (count.error) throw refuse('This file could not be read as a PDF.');
            checkPages(count.pages);
            return { buffer, ext: 'pdf', mime: 'application/pdf', pageCount: count.pages, note: 'This PDF was not password-protected; it is unchanged.' };
        }
        if (enc.code !== 0) throw refuse('This file could not be read as a PDF.');

        const count = await qpdfPages(bin, dir, input, password);
        if (count.error) {
            if (/invalid password/i.test(count.error)) throw refuse(password ? 'The password is incorrect.' : 'This PDF needs its password to be unlocked.', 422, 'tools.pdf.wrong_password');
            throw refuse('This file could not be read as a PDF.');
        }
        checkPages(count.pages);

        const r = await run(bin, ['@-', input, output], { stdin: stdinArgs([`--password=${password}`, '--decrypt']) });
        if (r.code !== 0 && r.code !== 3) throw refuse('The PDF could not be unlocked.');
        return { buffer: await fsp.readFile(output), ext: 'pdf', mime: 'application/pdf', pageCount: count.pages };
    });
}

module.exports = unlock;
