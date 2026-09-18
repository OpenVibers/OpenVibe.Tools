'use strict';

// ═══════════════════════════════════════════════════════════════
// YT.OpenVibe — yt-dlp Wrapper
// Spawns yt-dlp as child process for video info + download.
// Supports video (mp4/webm/mkv) and audio-only (mp3/m4a/opus).
// ═══════════════════════════════════════════════════════════════

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const config = require('./config');

// ── Download tracking ────────────────────────────────────────
const activeDownloads = new Map(); // id → { process, status, progress, filePath, ... }
const fileIndex = new Map();       // id → { filePath, mime, ext, size, expiresAt }
let currentConcurrent = 0;

// Ensure downloads dir
function ensureDir() {
    const dir = path.resolve(config.downloadsDir);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── URL Validation ───────────────────────────────────────────
const ALLOWED_DOMAINS = [
    /^(www\.)?youtube\.com$/,
    /^youtu\.be$/,
    /^m\.youtube\.com$/,
    /^music\.youtube\.com$/,
];

function isValidUrl(url) {
    try {
        const parsed = new URL(url);
        return ALLOWED_DOMAINS.some(re => re.test(parsed.hostname));
    } catch {
        return false;
    }
}

function sanitizeUrl(url) {
    // Strip tracking params but keep v= and list= and t=
    try {
        const parsed = new URL(url);
        const clean = new URL(parsed.origin + parsed.pathname);
        for (const key of ['v', 'list', 't', 'index']) {
            if (parsed.searchParams.has(key)) {
                clean.searchParams.set(key, parsed.searchParams.get(key));
            }
        }
        return clean.toString();
    } catch {
        return url;
    }
}

// ── Quality Presets ──────────────────────────────────────────
const QUALITY_PRESETS = {
    'best':      { video: 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best', ext: 'mp4' },
    '1080p':     { video: 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]', ext: 'mp4' },
    '720p':      { video: 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]', ext: 'mp4' },
    '480p':      { video: 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480][ext=mp4]', ext: 'mp4' },
    '360p':      { video: 'bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[height<=360][ext=mp4]', ext: 'mp4' },
    'mp4':       { video: 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best', ext: 'mp4' },
    'webm':      { video: 'bestvideo[ext=webm]+bestaudio[ext=webm]/best[ext=webm]', ext: 'webm' },
    'mp3':       { audio: true, video: 'bestaudio/best', ext: 'mp3', postprocess: ['--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0'] },
    'm4a':       { audio: true, video: 'bestaudio[ext=m4a]/bestaudio', ext: 'm4a', postprocess: ['--extract-audio', '--audio-format', 'm4a'] },
    'opus':      { audio: true, video: 'bestaudio', ext: 'opus', postprocess: ['--extract-audio', '--audio-format', 'opus'] },
    'flac':      { audio: true, video: 'bestaudio', ext: 'flac', postprocess: ['--extract-audio', '--audio-format', 'flac'] },
    'audio':     { audio: true, video: 'bestaudio/best', ext: 'mp3', postprocess: ['--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0'] },
};

// ── Get Video Info ───────────────────────────────────────────
/**
 * Fetch video metadata using yt-dlp --dump-json.
 * @param {string} url - YouTube URL
 * @returns {Promise<Object>} Video metadata
 */
function getInfo(url) {
    return new Promise((resolve, reject) => {
        if (!isValidUrl(url)) return reject(new Error('Only YouTube URLs are supported'));

        const cleanUrl = sanitizeUrl(url);
        const args = [
            '--dump-json',
            '--no-warnings',
            '--no-playlist',
            '--skip-download',
            cleanUrl,
        ];

        const proc = spawn(config.ytdlpPath, args, { timeout: 30000 });
        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', d => stdout += d);
        proc.stderr.on('data', d => stderr += d);

        proc.on('close', (code) => {
            if (code !== 0) {
                const errMsg = stderr.trim().split('\n').pop() || `yt-dlp exited with code ${code}`;
                return reject(new Error(errMsg));
            }
            try {
                const info = JSON.parse(stdout);
                resolve({
                    id: info.id,
                    title: info.title,
                    description: (info.description || '').slice(0, 500),
                    thumbnail: info.thumbnail,
                    duration: info.duration,
                    durationString: info.duration_string,
                    uploader: info.uploader,
                    uploaderUrl: info.uploader_url,
                    viewCount: info.view_count,
                    uploadDate: info.upload_date,
                    formats: getAvailableFormats(info),
                });
            } catch (e) {
                reject(new Error('Failed to parse video info'));
            }
        });

        proc.on('error', (err) => reject(new Error(`yt-dlp not found: ${err.message}. Install with: pip install yt-dlp`)));
    });
}

function getAvailableFormats(info) {
    const hasVideo = info.formats?.some(f => f.vcodec && f.vcodec !== 'none');
    const hasAudio = info.formats?.some(f => f.acodec && f.acodec !== 'none');

    const formats = [];
    if (hasVideo) {
        formats.push(
            { id: 'best', label: 'Best Quality (MP4)', type: 'video' },
            { id: '1080p', label: '1080p (MP4)', type: 'video' },
            { id: '720p', label: '720p (MP4)', type: 'video' },
            { id: '480p', label: '480p (MP4)', type: 'video' },
            { id: '360p', label: '360p (MP4)', type: 'video' },
        );
    }
    if (hasAudio) {
        formats.push(
            { id: 'mp3', label: 'MP3 Audio', type: 'audio' },
            { id: 'm4a', label: 'M4A Audio', type: 'audio' },
            { id: 'opus', label: 'Opus Audio', type: 'audio' },
            { id: 'flac', label: 'FLAC Audio (Lossless)', type: 'audio' },
        );
    }
    return formats;
}

/** yt-dlp's last stderr line → something the person can act on (the raw line is logged). */
function friendlyDownloadError(line) {
    const t = String(line || '');
    if (/Sign in to confirm|not a bot|cookies/i.test(t)) return 'YouTube is asking this server to prove it is not a bot — try again in a few minutes';
    if (/Private video|members-only|login required/i.test(t)) return 'This video is private or members-only';
    if (/Video unavailable|has been removed|not available/i.test(t)) return 'This video is unavailable';
    if (/age|confirm your age/i.test(t)) return 'Age-restricted videos cannot be downloaded';
    if (/ffmpeg|ffprobe|Postprocessing/i.test(t)) return `Conversion failed on the server (${t.slice(0, 120)})`;
    if (/Requested format is not available/i.test(t)) return 'That quality is not available for this video — try another';
    if (/HTTP Error 4\d\d/i.test(t)) return `YouTube refused the request (${t.match(/HTTP Error \d+/)[0]})`;
    return t.replace(/^ERROR:\s*/i, '').slice(0, 160) || 'Download failed';
}

// ── Download Video ───────────────────────────────────────────
/**
 * Start a download and return a tracking ID.
 * @param {string} url - YouTube URL
 * @param {string} quality - Quality preset key
 * @returns {Promise<{ id: string }>}
 */
function startDownload(url, quality = 'best') {
    return new Promise((resolve, reject) => {
        if (!isValidUrl(url)) return reject(new Error('Only YouTube URLs are supported'));
        if (currentConcurrent >= config.download.maxConcurrent) {
            return reject(new Error('Server busy — too many concurrent downloads. Try again shortly.'));
        }

        const preset = QUALITY_PRESETS[quality] || QUALITY_PRESETS['best'];
        const cleanUrl = sanitizeUrl(url);
        const id = crypto.randomBytes(12).toString('hex');

        ensureDir();
        const outputTemplate = path.resolve(config.downloadsDir, `${id}.%(ext)s`);

        const args = [
            '-f', preset.video,
            '--merge-output-format', preset.audio ? '' : (preset.ext || 'mp4'),
            '-o', outputTemplate,
            '--no-playlist',
            '--no-warnings',
            '--newline',  // progress on new lines for parsing
            '--progress-template', '%(progress._percent_str)s %(progress._speed_str)s %(progress._eta_str)s',
            ...(preset.postprocess || []),
            cleanUrl,
        ].filter(Boolean);

        // Remove empty merge-output-format for audio
        const cleanArgs = [];
        for (let i = 0; i < args.length; i++) {
            if (args[i] === '--merge-output-format' && args[i + 1] === '') { i++; continue; }
            cleanArgs.push(args[i]);
        }

        const entry = {
            id,
            status: 'downloading',
            progress: 0,
            speed: '',
            eta: '',
            error: null,
            filePath: null,
            quality,
            startedAt: Date.now(),
        };
        activeDownloads.set(id, entry);
        currentConcurrent++;

        const proc = spawn(config.ytdlpPath, cleanArgs, { timeout: config.download.timeout });
        entry.process = proc;

        proc.stdout.on('data', (data) => {
            const lines = data.toString().split('\n');
            for (const line of lines) {
                // Parse progress: "  45.2% 5.23MiB/s 00:12"
                const match = line.match(/([\d.]+)%\s+([\S]+)\s+([\S]+)/);
                if (match) {
                    entry.progress = parseFloat(match[1]);
                    entry.speed = match[2];
                    entry.eta = match[3];
                }
            }
        });

        let stderrTail = '';
        proc.stderr.on('data', (data) => {
            const text = data.toString();
            stderrTail = (stderrTail + text).slice(-2000);
            // Some progress info goes to stderr too
            const match = text.match(/([\d.]+)%/);
            if (match) entry.progress = parseFloat(match[1]);
        });

        proc.on('close', (code) => {
            currentConcurrent--;
            if (code !== 0) {
                const last = stderrTail.split('\n').map(l => l.trim()).filter(l => l && !/^\[download\]/.test(l)).pop() || `yt-dlp exited with code ${code}`;
                console.error(`[Download] ${id} (${quality}) failed: ${last}`);
                entry.status = 'error';
                entry.error = friendlyDownloadError(last);
                return;
            }

            // Find the output file (yt-dlp may change extension)
            const dir = path.resolve(config.downloadsDir);
            const files = fs.readdirSync(dir).filter(f => f.startsWith(id));
            if (files.length === 0) {
                entry.status = 'error';
                entry.error = 'Output file not found';
                return;
            }

            const outFile = files[0];
            const ext = path.extname(outFile).slice(1);
            const filePath = path.join(dir, outFile);
            const stat = fs.statSync(filePath);

            entry.status = 'done';
            entry.progress = 100;
            entry.filePath = filePath;
            entry.fileSize = stat.size;
            entry.ext = ext;

            // Register in file index for download serving
            const mimeMap = {
                mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska',
                mp3: 'audio/mpeg', m4a: 'audio/mp4', opus: 'audio/opus',
                flac: 'audio/flac', ogg: 'audio/ogg', wav: 'audio/wav',
            };

            fileIndex.set(id, {
                filePath,
                mime: mimeMap[ext] || 'application/octet-stream',
                ext,
                size: stat.size,
                expiresAt: Date.now() + config.retention.fileTTL,
            });
        });

        proc.on('error', (err) => {
            currentConcurrent--;
            entry.status = 'error';
            entry.error = `yt-dlp error: ${err.message}`;
        });

        resolve({ id });
    });
}

// ── Download Status ──────────────────────────────────────────
function getStatus(id) {
    const dl = activeDownloads.get(id);
    if (!dl) return null;
    return {
        id: dl.id,
        status: dl.status,
        progress: Math.round(dl.progress * 10) / 10,
        speed: dl.speed,
        eta: dl.eta,
        error: dl.error,
        quality: dl.quality,
        download: dl.status === 'done' ? { url: `/api/download/${id}`, size: dl.fileSize, ext: dl.ext } : null,
    };
}

// ── File Serving ─────────────────────────────────────────────
function getFile(id) {
    const entry = fileIndex.get(id);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        removeFile(id);
        return null;
    }
    return entry;
}

function removeFile(id) {
    const entry = fileIndex.get(id);
    if (entry) {
        try { fs.unlinkSync(entry.filePath); } catch { /* ok */ }
        fileIndex.delete(id);
    }
    activeDownloads.delete(id);
}

// ── Cleanup ──────────────────────────────────────────────────
let cleanupTimer = null;

function cleanup() {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, entry] of fileIndex) {
        if (now > entry.expiresAt) {
            try { fs.unlinkSync(entry.filePath); } catch { /* ok */ }
            fileIndex.delete(id);
            activeDownloads.delete(id);
            cleaned++;
        }
    }

    // Clean stale active downloads (stuck for > 15 min with no file)
    for (const [id, dl] of activeDownloads) {
        if (dl.status === 'downloading' && now - dl.startedAt > 15 * 60 * 1000) {
            try { dl.process?.kill('SIGTERM'); } catch { /* ok */ }
            dl.status = 'error';
            dl.error = 'Download timed out';
            currentConcurrent = Math.max(0, currentConcurrent - 1);
        }
    }

    return cleaned;
}

function startCleanup() {
    if (cleanupTimer) return;
    cleanupTimer = setInterval(() => {
        const cleaned = cleanup();
        if (cleaned > 0) console.log(`[Retention] Cleaned ${cleaned} expired downloads`);
    }, config.retention.cleanupInterval);
    cleanupTimer.unref();
}

function stopCleanup() {
    if (cleanupTimer) { clearInterval(cleanupTimer); cleanupTimer = null; }
}

function getStats() {
    let totalSize = 0;
    for (const entry of fileIndex.values()) totalSize += entry.size;
    return {
        activeDownloads: currentConcurrent,
        cachedFiles: fileIndex.size,
        totalSize,
        totalSizeMB: Math.round(totalSize / 1024 / 1024 * 100) / 100,
    };
}

module.exports = {
    getInfo, startDownload, getStatus, getFile, removeFile,
    cleanup, startCleanup, stopCleanup, getStats, isValidUrl,
};
