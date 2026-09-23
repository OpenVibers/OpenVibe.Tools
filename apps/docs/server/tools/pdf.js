'use strict';

// ═══════════════════════════════════════════════════════════════
// Docs.OpenVibe — what the PDF tools share:
//   • the page limit (PDF_MAX_PAGES, default 500) every operation checks before it does the work
//   • the command-line tools pdf-lib cannot replace: qpdf (real AES-256 encryption and decryption)
//     and poppler's pdftoppm/pdfinfo (rendering pages). Each is found at boot; an operation whose
//     tool is missing answers 503 tools.unavailable ("this tool is being set up")
//   • run(): a CLI in a private temporary directory, arguments as an array (never a shell), a
//     timeout, and secrets passed in a 0600 argument file instead of the process list
//   • zip(): a stored (uncompressed) ZIP for results with several files (pages, split parts)
// ═══════════════════════════════════════════════════════════════

const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { PDFDocument } = require('pdf-lib');
const { createBinary } = require('../../../_shared/binaries');

const MAX_PAGES = Math.max(1, parseInt(process.env.PDF_MAX_PAGES, 10) || 500);

function refuse(message, status = 422, code) {
    return Object.assign(new Error(message), { status, expose: true, ...(code && { code }) });
}

/** Throws 413 tools.pdf.too_many_pages when a document is over the page limit. */
function checkPages(n, what = 'This PDF') {
    if (n > MAX_PAGES) throw refuse(`${what} has ${n} pages; the limit is ${MAX_PAGES} pages.`, 413, 'tools.pdf.too_many_pages');
    return n;
}

/** pdf-lib's load with the page limit applied. */
async function loadPdf(buffer, opts = {}) {
    let doc;
    try { doc = await PDFDocument.load(buffer, { ignoreEncryption: true, ...opts }); } catch (err) {
        throw refuse(`This file could not be read as a PDF (${String(err.message || err).slice(0, 120)})`);
    }
    checkPages(doc.getPageCount(), opts.what);
    return doc;
}

// ── Command-line tools ───────────────────────────────────────

const qpdf = createBinary({ name: 'qpdf', candidates: ['qpdf'], envVar: 'QPDF_PATH' });
const pdftoppm = createBinary({ name: 'pdftoppm', candidates: ['pdftoppm'], envVar: 'PDFTOPPM_PATH' });
const pdfinfo = createBinary({ name: 'pdfinfo', candidates: ['pdfinfo'], envVar: 'PDFINFO_PATH' });

/**
 * Run a command-line tool. Never through a shell; `secretArgs` go into an argument file (qpdf's
 * @file) readable only by this user, so passwords are not visible in the process list.
 * → { code, stdout, stderr }
 */
function run(bin, args, { timeoutMs = 120_000, cwd, maxOutput = 64 * 1024 } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '', timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
        child.stdout.on('data', d => { if (stdout.length < maxOutput) stdout += d; });
        child.stderr.on('data', d => { if (stderr.length < maxOutput) stderr += d; });
        child.on('error', (err) => { clearTimeout(timer); reject(err); });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (timedOut) return reject(refuse(`The document took longer than ${Math.round(timeoutMs / 1000)} s to process`, 504, 'tools.job.timeout'));
            resolve({ code, stdout, stderr });
        });
    });
}

/** A private working directory (0700), removed afterwards whatever happens. */
async function withTempDir(fn) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ov-docs-'));
    try { return await fn(dir); } finally { fs.rm(dir, { recursive: true, force: true }, () => {}); }
}

/** One argument per line for qpdf's @file (a line break inside an argument cannot be represented). */
async function writeArgFile(dir, args) {
    for (const a of args) if (/[\r\n\0]/.test(a)) throw refuse('Passwords cannot contain line breaks');
    const file = path.join(dir, 'args');
    await fsp.writeFile(file, args.join('\n') + '\n', { mode: 0o600 });
    return file;
}

/** qpdf's page count (with a password for encrypted files). */
async function qpdfPages(bin, dir, input, password) {
    const args = password != null ? [`@${await writeArgFile(dir, [`--password=${password}`])}`] : [];
    const r = await run(bin, [...args, '--show-npages', input], { timeoutMs: 60_000 });
    if (r.code !== 0 && r.code !== 3) return { error: r.stderr || r.stdout };
    return { pages: parseInt(r.stdout.trim(), 10) };
}

// ── ZIP (stored) ─────────────────────────────────────────────

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) {
    if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

/** [{ name, data }] → a ZIP archive (method 0: PDFs, PNGs and JPEGs are already compressed). */
function zip(entries) {
    const now = new Date();
    const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const locals = [], centrals = [];
    let offset = 0;
    for (const e of entries) {
        const name = Buffer.from(e.name, 'utf8');
        const crc = crc32(e.data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(0, 8); local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12);
        local.writeUInt32LE(crc, 14); local.writeUInt32LE(e.data.length, 18); local.writeUInt32LE(e.data.length, 22);
        local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(0, 10); central.writeUInt16LE(time, 12); central.writeUInt16LE(date, 14);
        central.writeUInt32LE(crc, 16); central.writeUInt32LE(e.data.length, 20); central.writeUInt32LE(e.data.length, 24);
        central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
        locals.push(local, name, e.data);
        centrals.push(central, name);
        offset += local.length + name.length + e.data.length;
    }
    const cd = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
    if (offset > 0xfffffff0 || entries.length > 0xffff) throw refuse('The result is too large to package');
    return Buffer.concat([...locals, cd, end]);
}

module.exports = { MAX_PAGES, checkPages, loadPdf, refuse, qpdf, pdftoppm, pdfinfo, run, withTempDir, writeArgFile, qpdfPages, zip, crc32 };
