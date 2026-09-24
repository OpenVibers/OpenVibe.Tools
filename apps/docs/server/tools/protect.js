'use strict';

// ═══════════════════════════════════════════════════════════════
// Docs.OpenVibe — Protect PDF Tool
// Encrypts a PDF with AES-256 (qpdf; PDF 2.0 security handler R6), so it opens only with the
// password. Printing and copying text can be refused. It used to re-save the file unencrypted.
// Without qpdf on the server the tool answers 503 tools.unavailable.
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const { qpdf, run, withTempDir, stdinArgs, qpdfPages, checkPages, refuse } = require('./pdf');

const MAX_PASSWORD_BYTES = 127;   // AES-256 (R6) passwords are UTF-8, at most 127 bytes

const yes = (v, dflt) => (v == null || v === '' ? dflt : !/^(false|0|no|off|none)$/i.test(String(v)));

/**
 * @param {Buffer} buffer - PDF buffer
 * @param {Object} options - { password|userPassword, ownerPassword?, allowPrint?, allowCopy? }
 * @returns {{ buffer: Buffer, ext: string, mime: string, pageCount: number, encryption: object }}
 */
async function protect(buffer, options = {}) {
    const userPassword = String(options.userPassword || options.password || '');
    if (!userPassword) throw refuse('A password is required to protect the PDF.', 400);
    if (Buffer.byteLength(userPassword) > MAX_PASSWORD_BYTES) throw refuse(`The password is longer than ${MAX_PASSWORD_BYTES} bytes.`, 400);
    // Without an owner password of their own, a random one: the restrictions cannot be lifted
    // with an empty owner password, and nobody else knows it.
    const ownerPassword = String(options.ownerPassword || crypto.randomBytes(24).toString('base64url'));
    if (Buffer.byteLength(ownerPassword) > MAX_PASSWORD_BYTES) throw refuse(`The owner password is longer than ${MAX_PASSWORD_BYTES} bytes.`, 400);
    const allowPrint = yes(options.allowPrint, true);
    const allowCopy = yes(options.allowCopy, true);
    const bin = qpdf.path({ tool: 'protect' });

    return withTempDir(async (dir) => {
        const input = path.join(dir, 'in.pdf');
        const output = path.join(dir, 'out.pdf');
        await fsp.writeFile(input, buffer);

        const count = await qpdfPages(bin, dir, input);
        if (count.error) {
            if (/password/i.test(count.error)) throw refuse('This PDF is already password-protected. Unlock it first, then protect it again.');
            throw refuse('This file could not be read as a PDF.');
        }
        checkPages(count.pages);

        const stdin = stdinArgs([
            '--encrypt', `--user-password=${userPassword}`, `--owner-password=${ownerPassword}`, '--bits=256',
            `--print=${allowPrint ? 'full' : 'none'}`, `--extract=${allowCopy ? 'y' : 'n'}`, '--',
        ]);
        const r = await run(bin, ['@-', input, output], { stdin });
        // 0 = done, 3 = done with warnings (qpdf repaired something on the way).
        if (r.code !== 0 && r.code !== 3) throw refuse(`The PDF could not be encrypted (${(r.stderr || '').split('\n')[0].replace(/^qpdf:\s*/, '').replace(dir, '').slice(0, 160)})`);

        return {
            buffer: await fsp.readFile(output),
            ext: 'pdf',
            mime: 'application/pdf',
            pageCount: count.pages,
            encryption: { method: 'AES-256', printing: allowPrint, copying: allowCopy },
            note: 'Encrypted with AES-256. Keep the password safe: it cannot be recovered.',
        };
    });
}

module.exports = protect;
