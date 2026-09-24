'use strict';

// ═══════════════════════════════════════════════════════════════
// Docs.OpenVibe — Multer Upload Middleware
// Disk storage (up to 50 files of 100 MB for a merge must never sit in memory while they arrive) with
// size + declared-type validation; the guard then checks the bytes (apps/_shared/guard/sniff.js).
// Files land in config.uploadsDir with a random name; the routes read them and delete them, and the
// retention sweep removes anything older than retention.tempMaxAge. Job submits move them into the job.
// ═══════════════════════════════════════════════════════════════

const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const config = require('../config');

const ALLOWED_MIMES = new Set(config.upload.allowedMimes);

const uploadsDir = path.resolve(config.uploadsDir);
fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
        const ext = (path.extname(file.originalname || '').toLowerCase().match(/^\.[a-z0-9]{1,8}$/) || ['.bin'])[0];
        cb(null, `${crypto.randomBytes(16).toString('hex')}${ext}`);
    },
});

const upload = multer({
    storage,
    limits: {
        fileSize: config.upload.maxFileSize,
        files: 50, // Allow up to 50 files for merge
    },
    fileFilter(_req, file, cb) {
        // A part without a type of its own (application/octet-stream: API clients, openvibe-sdk) is let
        // through: the guard checks the bytes of every upload against the tool's accepted types.
        if (ALLOWED_MIMES.has(file.mimetype) || file.mimetype === 'application/octet-stream') {
            cb(null, true);
        } else {
            cb(new Error(`Unsupported file type: ${file.mimetype}. Accepted: ${config.upload.allowedMimes.join(', ')}`));
        }
    },
});

/**
 * Single file upload on 'file' field.
 * Attaches req.file with { path, originalname, mimetype, size }.
 */
function uploadSingle(req, res, next) {
    upload.single('file')(req, res, (err) => {
        if (err) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(413).json({ error: `File too large. Maximum ${Math.round(config.upload.maxFileSize / 1024 / 1024)}MB.` });
            }
            return res.status(400).json({ error: err.message });
        }
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded. Send a file in the "file" field.' });
        }
        next();
    });
}

/**
 * Multiple file upload on 'files' field (for merge, img2pdf, etc.).
 * Attaches req.files as an array of { path, originalname, mimetype, size }.
 */
function uploadMultiple(req, res, next) {
    upload.array('files', 50)(req, res, (err) => {
        if (err) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(413).json({ error: `File too large. Maximum ${Math.round(config.upload.maxFileSize / 1024 / 1024)}MB per file.` });
            }
            if (err.code === 'LIMIT_FILE_COUNT') {
                return res.status(400).json({ error: 'Too many files. Maximum 50 files per request.' });
            }
            return res.status(400).json({ error: err.message });
        }
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'No files uploaded. Send files in the "files" field.' });
        }
        next();
    });
}

/**
 * One file in 'file' or several in 'files' (the job endpoint takes either shape).
 * Attaches req.files as { file?: [...], files?: [...] }.
 */
function uploadAny(req, res, next) {
    upload.fields([{ name: 'file', maxCount: 1 }, { name: 'files', maxCount: 50 }])(req, res, (err) => {
        if (err) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(413).json({ error: `File too large. Maximum ${Math.round(config.upload.maxFileSize / 1024 / 1024)}MB per file.` });
            }
            if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
                return res.status(400).json({ error: 'Send one file in "file" or up to 50 in "files".' });
            }
            return res.status(400).json({ error: err.message });
        }
        const n = req.files ? Object.values(req.files).flat().length : 0;
        if (!n) return res.status(400).json({ error: 'No files uploaded. Send a file in the "file" field.' });
        next();
    });
}

module.exports = { uploadSingle, uploadMultiple, uploadAny };
