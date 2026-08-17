'use strict';

// ═══════════════════════════════════════════════════════════════
// Img.OpenVibe — Multer Upload Middleware
// Memory storage with file size + mime validation.
// ═══════════════════════════════════════════════════════════════

const multer = require('multer');
const config = require('../config');

const ALLOWED_MIMES = new Set(config.upload.allowedMimes);

const storage = multer.memoryStorage();

const upload = multer({
    storage,
    limits: {
        fileSize: config.upload.maxFileSize,
        files: 1,
    },
    fileFilter(_req, file, cb) {
        if (ALLOWED_MIMES.has(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error(`Unsupported file type: ${file.mimetype}. Accepted: ${config.upload.allowedMimes.join(', ')}`));
        }
    },
});

/**
 * Express middleware for single file upload on 'file' field.
 * Attaches req.file with { buffer, originalname, mimetype, size }.
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

module.exports = { uploadSingle };
