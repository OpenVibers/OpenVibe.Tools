'use strict';

// ═══════════════════════════════════════════════════════════════
// Audio.OpenVibe — Multer Upload Middleware
// Disk storage (audio files can be large) with size + mime validation.
// ═══════════════════════════════════════════════════════════════

const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const config = require('../config');

const ALLOWED_MIMES = new Set(config.upload.allowedMimes);

// Use disk storage for audio — memory storage is risky for 100MB files
const uploadsDir = path.resolve(config.uploadsDir);
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
        const id = crypto.randomBytes(16).toString('hex');
        const ext = path.extname(file.originalname) || '.bin';
        cb(null, `${id}${ext}`);
    },
});

const upload = multer({
    storage,
    limits: {
        fileSize: config.upload.maxFileSize,
        files: 5, // Allow up to 5 for merge tool
    },
    fileFilter(_req, file, cb) {
        // Be lenient — some browsers send application/octet-stream for audio
        if (ALLOWED_MIMES.has(file.mimetype) || file.mimetype === 'application/octet-stream') {
            cb(null, true);
        } else {
            cb(new Error(`Unsupported file type: ${file.mimetype}. Upload an audio or video file.`));
        }
    },
});

/**
 * Single file upload on 'file' field.
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
 * Multiple file upload on 'files' field (for merge).
 */
function uploadMultiple(req, res, next) {
    upload.array('files', 5)(req, res, (err) => {
        if (err) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(413).json({ error: `Files too large. Maximum ${Math.round(config.upload.maxFileSize / 1024 / 1024)}MB each.` });
            }
            return res.status(400).json({ error: err.message });
        }
        if (!req.files || req.files.length < 2) {
            return res.status(400).json({ error: 'Upload at least 2 files to merge.' });
        }
        next();
    });
}

module.exports = { uploadSingle, uploadMultiple };
