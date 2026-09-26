'use strict';
// ═══════════════════════════════════════════════════════════════
// Uploads for the satellites (roadmap WS-L task 3: one runtime, no per-app copies).
//
//   const { uploadSingle, uploadMultiple, uploadAny } = createUploads({ multer: require('multer'), config, storage: 'disk', maxFiles: 50 });
//
//   multer            the app's own (apps/_shared has no node_modules; its modules take packages as arguments)
//
//   storage 'memory'  req.file.buffer: small files only (images)
//   storage 'disk'    files land in config.uploadsDir with a random name and a sanitised extension, so
//                     large or many files never sit in memory while they arrive; the routes read and
//                     delete them, the retention sweep removes leftovers, job submits move them
//   maxFiles          per request, for uploadMultiple / uploadAny ('files' field)
//   rejectHint        the end of the unsupported-type message (default: the accepted types)
//
// The declared type must be one of config.upload.allowedMimes, or application/octet-stream (API
// clients, openvibe-sdk): the guard checks the bytes of every upload against the tool's accepted
// types (guard/sniff.js). Answers are the { error } JSON the apps' pages already read.
// ═══════════════════════════════════════════════════════════════

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

function createUploads({ multer, config, storage = 'memory', maxFiles = 1, rejectHint = null } = {}) {
    if (typeof multer !== 'function') throw new TypeError('createUploads needs multer (the app\'s require(\'multer\'))');
    if (!config || !config.upload) throw new TypeError('createUploads needs the app config (upload.maxFileSize, upload.allowedMimes)');
    const allowed = new Set(config.upload.allowedMimes || []);
    const maxMb = Math.round(config.upload.maxFileSize / 1024 / 1024);
    let store;
    if (storage === 'disk') {
        const dir = path.resolve(config.uploadsDir || 'data/uploads');
        fs.mkdirSync(dir, { recursive: true });
        store = multer.diskStorage({
            destination: (_req, _file, cb) => cb(null, dir),
            filename: (_req, file, cb) => {
                const ext = (path.extname(file.originalname || '').toLowerCase().match(/^\.[a-z0-9]{1,8}$/) || ['.bin'])[0];
                cb(null, `${crypto.randomBytes(16).toString('hex')}${ext}`);
            },
        });
    } else {
        store = multer.memoryStorage();
    }
    const upload = multer({
        storage: store,
        limits: { fileSize: config.upload.maxFileSize, files: Math.max(1, maxFiles) },
        fileFilter(_req, file, cb) {
            if (allowed.has(file.mimetype) || file.mimetype === 'application/octet-stream') return cb(null, true);
            cb(new Error(`Unsupported file type: ${file.mimetype}. ${rejectHint || `Accepted: ${[...allowed].join(', ')}`}`));
        },
    });
    const tooLarge = (per) => `File too large. Maximum ${maxMb}MB${per ? ' per file' : ''}.`;

    /** One file in 'file' → req.file ({ buffer } in memory, { path } on disk, plus originalname, mimetype, size). */
    function uploadSingle(req, res, next) {
        upload.single('file')(req, res, (err) => {
            if (err) return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? tooLarge(false) : err.message });
            if (!req.file) return res.status(400).json({ error: 'No file uploaded. Send a file in the "file" field.' });
            next();
        });
    }

    /** Up to maxFiles in 'files' → req.files (an array). */
    function uploadMultiple(req, res, next) {
        upload.array('files', maxFiles)(req, res, (err) => {
            if (err) {
                if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: tooLarge(true) });
                if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).json({ error: `Too many files. Maximum ${maxFiles} files per request.` });
                return res.status(400).json({ error: err.message });
            }
            if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded. Send files in the "files" field.' });
            next();
        });
    }

    /** One file in 'file' or up to maxFiles in 'files' (the job endpoint takes either) → req.files { file?, files? }. */
    function uploadAny(req, res, next) {
        upload.fields([{ name: 'file', maxCount: 1 }, { name: 'files', maxCount: maxFiles }])(req, res, (err) => {
            if (err) {
                if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: tooLarge(true) });
                if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).json({ error: `Send one file in "file" or up to ${maxFiles} in "files".` });
                return res.status(400).json({ error: err.message });
            }
            const n = req.files ? Object.values(req.files).flat().length : 0;
            if (!n) return res.status(400).json({ error: 'No files uploaded. Send a file in the "file" field.' });
            next();
        });
    }

    return { uploadSingle, uploadMultiple, uploadAny };
}

module.exports = { createUploads };
