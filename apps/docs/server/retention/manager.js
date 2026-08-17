'use strict';

// ═══════════════════════════════════════════════════════════════
// Docs.OpenVibe — Ephemeral Retention Manager
// Stores processed files with TTL-based auto-expiry.
// In-memory index + filesystem storage.
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

// In-memory file registry: id → { filename, mime, ext, size, expiresAt, createdAt }
const fileIndex = new Map();

function ensureDirs() {
    for (const dir of [config.uploadsDir, config.outputDir]) {
        const resolved = path.resolve(dir);
        if (!fs.existsSync(resolved)) fs.mkdirSync(resolved, { recursive: true });
    }
}

/**
 * Save a processed output buffer to disk.
 * @param {Buffer} buffer - Output file data
 * @param {string} ext - File extension (e.g. 'pdf', 'jpg')
 * @param {string} mime - MIME type
 * @param {boolean} isAuthed - Whether user is authenticated (affects TTL)
 * @param {string} [originalName] - Original filename for reference
 * @returns {{ id: string, filename: string, downloadUrl: string, expiresAt: number, size: number }}
 */
function saveOutput(buffer, ext, mime, isAuthed = false, originalName = '') {
    ensureDirs();

    const id = crypto.randomBytes(16).toString('hex');
    const filename = `${id}.${ext}`;
    const filePath = path.resolve(config.outputDir, filename);
    const ttl = isAuthed ? config.retention.authedTTL : config.retention.anonTTL;
    const expiresAt = Date.now() + ttl;

    fs.writeFileSync(filePath, buffer);

    const entry = {
        id,
        filename,
        filePath,
        mime,
        ext,
        size: buffer.length,
        originalName,
        expiresAt,
        createdAt: Date.now(),
        isAuthed,
    };
    fileIndex.set(id, entry);

    return {
        id,
        filename,
        downloadUrl: `/api/download/${id}`,
        expiresAt,
        expiresIn: ttl,
        size: buffer.length,
    };
}

/**
 * Get file entry by ID (returns null if expired or not found).
 */
function getFile(id) {
    const entry = fileIndex.get(id);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        removeFile(id);
        return null;
    }
    return entry;
}

/**
 * Remove a file from disk and index.
 */
function removeFile(id) {
    const entry = fileIndex.get(id);
    if (entry) {
        try { fs.unlinkSync(entry.filePath); } catch { /* already gone */ }
        fileIndex.delete(id);
    }
}

/**
 * Run cleanup — remove all expired files.
 * @returns {number} Number of files cleaned
 */
function cleanup() {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, entry] of fileIndex) {
        if (now > entry.expiresAt) {
            try { fs.unlinkSync(entry.filePath); } catch { /* ok */ }
            fileIndex.delete(id);
            cleaned++;
        }
    }

    // Also clean stale temp uploads
    try {
        const uploadsDir = path.resolve(config.uploadsDir);
        if (fs.existsSync(uploadsDir)) {
            for (const file of fs.readdirSync(uploadsDir)) {
                const fp = path.join(uploadsDir, file);
                const stat = fs.statSync(fp);
                if (now - stat.mtimeMs > config.retention.tempMaxAge) {
                    fs.unlinkSync(fp);
                    cleaned++;
                }
            }
        }
    } catch { /* non-critical */ }

    return cleaned;
}

/**
 * Get stats about current file storage.
 */
function getStats() {
    let totalSize = 0;
    for (const entry of fileIndex.values()) totalSize += entry.size;
    return {
        fileCount: fileIndex.size,
        totalSize,
        totalSizeMB: Math.round(totalSize / 1024 / 1024 * 100) / 100,
    };
}

/**
 * Start periodic cleanup interval.
 */
let cleanupTimer = null;
function startCleanup() {
    if (cleanupTimer) return;
    cleanupTimer = setInterval(() => {
        const cleaned = cleanup();
        if (cleaned > 0) console.log(`[Retention] Cleaned ${cleaned} expired files`);
    }, config.retention.cleanupInterval);
    cleanupTimer.unref();
}

function stopCleanup() {
    if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
    }
}

module.exports = { saveOutput, getFile, removeFile, cleanup, getStats, startCleanup, stopCleanup };
