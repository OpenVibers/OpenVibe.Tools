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
/**
 * Optional network identity for yt-dlp, set in the unit's environment (never in the repo):
 *   YT_PROXY         e.g. socks5://127.0.0.1:1080 — used when YouTube refuses this server's address
 *   YT_COOKIES_FILE  path to a Netscape cookies.txt readable by the service user
 */
function identityArgs() {
    const out = [];
    const proxy = String(process.env.YT_PROXY || '').trim();
    if (/^(https?|socks[45]h?):\/\/[^\s]+$/i.test(proxy)) out.push('--proxy', proxy);
    const cookies = String(process.env.YT_COOKIES_FILE || '').trim();
    if (cookies && fs.existsSync(cookies)) out.push('--cookies', cookies);
    return out;
}

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

/** The YouTube video id of a link (watch?v=, youtu.be/, /shorts/, /live/, /embed/), or null. */
function videoId(url) {
    try {
        const u = new URL(url);
        let id = u.hostname === 'youtu.be' ? u.pathname.slice(1).split('/')[0] : u.searchParams.get('v');
        if (!id) { const m = /^\/(?:shorts|live|embed|v)\/([^/?#]+)/.exec(u.pathname); if (m) id = m[1]; }
        return id && /^[\w-]{6,20}$/.test(id) ? id : null;
    } catch { return null; }
}

const sizeLabel = () => (config.download.maxFilesize >= 1024 ? `${Math.round(config.download.maxFilesize / 102.4) / 10} GB` : `${config.download.maxFilesize} MB`);
const fmtHours = (s) => (s % 3600 === 0 ? `${s / 3600} hour${s === 3600 ? '' : 's'}` : `${Math.round(s / 60)} minutes`);

/** Why this video cannot be downloaded here (null when it can). */
function limitReason(duration, isLive) {
    const max = config.download.maxDuration;
    if (isLive) return 'This is a live stream that has not ended; it can be saved once it is over.';
    if (Number.isFinite(duration) && duration > max) return `This video is ${fmtHours(Math.round(duration))} long; downloads are limited to ${fmtHours(max)}.`;
    return null;
}

// ── Info: at most N yt-dlp runs at once, answers cached per video id ─────
const infoCache = new Map();      // id → { info, expires }
const infoInflight = new Map();   // id → Promise
let infoRunning = 0;
const infoQueue = [];

function acquireInfoSlot() {
    if (infoRunning < config.info.maxConcurrent) { infoRunning++; return Promise.resolve(); }
    if (infoQueue.length >= config.info.maxQueued) return Promise.reject(Object.assign(new Error('The server is busy looking up other videos. Try again in a moment.'), { status: 503 }));
    return new Promise(resolve => infoQueue.push(resolve));
}
function releaseInfoSlot() {
    const next = infoQueue.shift();
    if (next) next(); else infoRunning = Math.max(0, infoRunning - 1);
}

function cachedInfo(id) {
    const hit = id && infoCache.get(id);
    if (!hit) return null;
    if (hit.expires <= Date.now()) { infoCache.delete(id); return null; }
    return hit.info;
}

/** getInfo with the concurrency cap, the per-id cache and one run per id at a time. */
function getInfoLimited(url, { run = getInfo } = {}) {
    const id = videoId(url);
    const hit = cachedInfo(id);
    if (hit) return Promise.resolve(hit);
    if (id && infoInflight.has(id)) return infoInflight.get(id);
    const p = (async () => {
        await acquireInfoSlot();
        try {
            const info = await run(url);
            if (id) {
                infoCache.set(id, { info, expires: Date.now() + config.info.cacheTtlMs });
                while (infoCache.size > config.info.cacheMax) infoCache.delete(infoCache.keys().next().value);
            }
            return info;
        } finally {
            releaseInfoSlot();
            if (id) infoInflight.delete(id);
        }
    })();
    if (id) infoInflight.set(id, p);
    return p;
}

function infoStats() { return { running: infoRunning, queued: infoQueue.length, cached: infoCache.size }; }

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
            ...identityArgs(),
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
                rememberTitle(cleanUrl, info.title);
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
                    isLive: !!info.is_live,
                    formats: getAvailableFormats(info),
                    downloadable: !limitReason(info.duration, info.is_live),
                    ...(limitReason(info.duration, info.is_live) && { reason: limitReason(info.duration, info.is_live) }),
                    limits: { maxDuration: config.download.maxDuration, maxFilesizeMB: config.download.maxFilesize },
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
    if (/Sign in to confirm|not a bot|cookies/i.test(t)) return 'YouTube is refusing downloads from this server right now. This is on YouTube\'s side; please try again later.';
    if (/Private video|members-only|login required/i.test(t)) return 'This video is private or members-only';
    if (/Video unavailable|has been removed|not available/i.test(t)) return 'This video is unavailable';
    if (/\bage[- ]restrict|confirm your age/i.test(t)) return 'Age-restricted videos cannot be downloaded';
    if (/ffmpeg|ffprobe|Postprocessing/i.test(t)) return `Conversion failed on the server (${t.slice(0, 120)})`;
    if (/Requested format is not available/i.test(t)) return 'That quality is not available for this video — try another';
    if (/HTTP Error 4\d\d/i.test(t)) return `YouTube refused the request (${t.match(/HTTP Error \d+/)[0]})`;
    return t.replace(/^ERROR:\s*/i, '').slice(0, 160) || 'Download failed';
}

// ── File names ───────────────────────────────────────────────
/**
 * A video title as a file name people recognise: no path separators, control characters or
 * characters Windows refuses, collapsed whitespace, no trailing dots, bounded length.
 */
function sanitizeTitle(title) {
    let t = String(title == null ? '' : title).normalize('NFC');
    t = t.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ');
    t = t.replace(/\s+/g, ' ').trim();
    t = t.replace(/^[.\s]+|[.\s]+$/g, '');
    if (t.length > 120) t = t.slice(0, 120).trim();
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(t)) t = `${t}_`;
    return t;
}

function downloadFilename(title, ext) {
    const base = sanitizeTitle(title) || 'youtube-video';
    return `${base}.${ext || 'mp4'}`;
}

/** Content-Disposition with an ASCII fallback and the real name as RFC 5987 filename*. */
function contentDisposition(filename) {
    const ascii = String(filename).normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '').replace(/\s+/g, ' ').trim();
    const ext = path.extname(String(filename));
    const fallback = ascii && ascii !== ext ? ascii : `youtube-video${ext}`;
    const encoded = encodeURIComponent(filename).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

// Titles seen by getInfo, so a download started right after can be named without asking again.
const titleCache = new Map(); // clean url → title
function rememberTitle(cleanUrl, title) {
    if (!title) return;
    if (titleCache.size > 500) titleCache.delete(titleCache.keys().next().value);
    titleCache.set(cleanUrl, title);
}

// ── Progress parsing ─────────────────────────────────────────
const cleanField = (v) => {
    const t = String(v || '').trim();
    return /^(n\/?a|unknown|none|unknown b\/s)?$/i.test(t) ? '' : t;
};

/**
 * Fold one yt-dlp stdout line into the entry. Lines are ours (see the --print / --progress-template
 * arguments): OVM|sizes|approxSizes|titleJSON, OVP|percent|speed|eta, OVX|pp, OVF|filepath.
 *
 * A merged video is two transfers (video, then audio) and yt-dlp reports each 0 → 100 %, so the
 * raw number runs backwards halfway through. Parts are weighted by their byte sizes when yt-dlp
 * knows them (85/15 otherwise) and the overall figure never decreases.
 */
function applyLine(entry, line) {
    if (line.startsWith('OVD|')) {
        // pre_process: the video's length and live state, before the match filter and any download.
        const [, dur, live] = line.split('|');
        entry.probed = true;
        const d = parseFloat(dur);
        if (Number.isFinite(d)) entry.duration = d;
        if (live === 'True') entry.isLive = true;
        const why = limitReason(entry.duration, entry.isLive);
        if (why && !entry.limitError) entry.limitError = why;
        return;
    }
    if (line.startsWith('OVP|')) {
        const [, pctRaw, speed, eta, bytesRaw] = line.split('|');
        const bytes = parseFloat(bytesRaw);
        if (Number.isFinite(bytes) && bytes > config.download.maxFilesize * 1024 * 1024 && !entry.limitError) {
            entry.limitError = `This download is larger than ${sizeLabel()}, the limit here.`;
        }
        const pct = parseFloat(pctRaw);
        if (!Number.isFinite(pct)) return;
        if (entry._lastPct != null && pct < entry._lastPct - 40 && entry._part < entry._weights.length - 1) entry._part++;
        entry._lastPct = pct;
        const before = entry._weights.slice(0, entry._part).reduce((a, b) => a + b, 0);
        const overall = (before + entry._weights[entry._part] * (pct / 100)) * 100;
        // 100 is reserved for "the file is ready"; until then the bar stops just short.
        entry.progress = Math.max(entry.progress || 0, Math.min(overall, 99.5));
        entry.speed = cleanField(speed);
        entry.eta = cleanField(eta);
        if (entry.phase !== 'processing') entry.phase = 'downloading';
    } else if (line.startsWith('OVM|')) {
        const first = line.indexOf('|', 4);
        const second = first < 0 ? -1 : line.indexOf('|', first + 1);
        if (second < 0) return;
        const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };
        const sizes = parse(line.slice(4, first));
        const approx = parse(line.slice(first + 1, second));
        const title = parse(line.slice(second + 1));
        if (typeof title === 'string' && title && !entry.title) entry.title = title;
        const pick = [sizes, approx].find(a => Array.isArray(a) && a.length > 1 && a.every(n => Number.isFinite(n) && n > 0));
        if (pick) {
            const total = pick.reduce((a, b) => a + b, 0);
            entry._weights = pick.map(n => n / total);
            entry.totalBytes = total;
        } else if (Array.isArray(sizes) && sizes.length <= 1) {
            entry._weights = [1];
        }
    } else if (line.startsWith('OVX|')) {
        entry.phase = 'processing';
        entry.speed = '';
        entry.eta = '';
    }
}

// ── Download Video ───────────────────────────────────────────
function releaseSlot(entry) {
    if (entry._slotReleased) return;
    entry._slotReleased = true;
    currentConcurrent = Math.max(0, currentConcurrent - 1);
}

function removePartials(id) {
    const dir = path.resolve(config.downloadsDir);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const f of names) {
        if (f.startsWith(id)) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* ok */ } }
    }
}

/**
 * Start a download and return a tracking ID.
 * @param {string} url - YouTube URL
 * @param {string} quality - Quality preset key
 * @param {{ title?: string }} [opts] - title the client already shows (yt-dlp's own wins when it reports one)
 * @returns {Promise<{ id: string }>}
 */
function startDownload(url, quality = 'best', opts = {}) {
    return new Promise((resolve, reject) => {
        if (!isValidUrl(url)) return reject(new Error('Only YouTube URLs are supported'));
        if (currentConcurrent >= config.download.maxConcurrent) {
            return reject(new Error('Server busy — too many concurrent downloads. Try again shortly.'));
        }

        if (!QUALITY_PRESETS[quality]) quality = 'best';
        const preset = QUALITY_PRESETS[quality];
        const cleanUrl = sanitizeUrl(url);
        const id = crypto.randomBytes(12).toString('hex');

        ensureDir();
        const outputTemplate = path.resolve(config.downloadsDir, `${id}.%(ext)s`);

        // Audio presets must not get --merge-output-format at all: the old '' placeholder was
        // dropped by filter(Boolean) before the cleanup loop ran, so yt-dlp received
        // `--merge-output-format -o` and every audio download died with
        // "invalid merge output format "-o" given".
        //
        // --print makes yt-dlp quiet, so everything on stdout is one of our own tagged lines;
        // --no-simulate keeps it downloading and --progress keeps the progress lines coming.
        const cleanArgs = [
            '-f', preset.video,
            ...(preset.audio ? [] : ['--merge-output-format', preset.ext || 'mp4']),
            '-o', outputTemplate,
            '--no-playlist',
            ...identityArgs(),
            '--no-warnings',
            '--no-simulate',
            '--progress',
            '--newline',  // progress on new lines for parsing
            // Limits: a video longer than maxDuration (or a live stream without a length) does not
            // pass the filter, a part larger than maxFilesize is not downloaded; OVD reports the
            // length before either happens so the error can say why.
            '--match-filter', `duration<=${config.download.maxDuration} & !is_live`,
            '--max-filesize', `${config.download.maxFilesize}M`,
            '--print', 'pre_process:OVD|%(duration)s|%(is_live)s',
            '--print', 'before_dl:OVM|%(requested_formats.:.filesize)j|%(requested_formats.:.filesize_approx)j|%(title)j',
            '--print', 'post_process:OVX|pp',
            '--progress-template', 'download:OVP|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress.downloaded_bytes)s',
            ...(preset.postprocess || []),
            cleanUrl,
        ];

        const clientTitle = sanitizeTitle(opts.title).slice(0, 200);
        const entry = {
            id,
            status: 'downloading',
            phase: 'starting',          // starting → downloading → processing
            progress: null,             // null until yt-dlp reports a figure (indeterminate)
            speed: '',
            eta: '',
            error: null,
            cancelled: false,
            filePath: null,
            quality,
            title: titleCache.get(cleanUrl) || clientTitle || '',
            startedAt: Date.now(),
            finishedAt: null,
            _weights: preset.audio ? [1] : [0.85, 0.15],
            _part: 0,
            _lastPct: null,
        };
        activeDownloads.set(id, entry);
        currentConcurrent++;

        const proc = spawn(config.ytdlpPath, cleanArgs, { timeout: config.download.timeout });
        entry.process = proc;

        let stdoutRest = '';
        proc.stdout.on('data', (data) => {
            const lines = (stdoutRest + data.toString()).split('\n');
            stdoutRest = lines.pop();
            for (const line of lines) applyLine(entry, line.trim());
            // Over a limit: stop now rather than after the whole file arrived.
            if (entry.limitError && entry.status === 'downloading') {
                entry.status = 'error';
                entry.error = entry.limitError;
                entry.finishedAt = Date.now();
                try { proc.kill('SIGTERM'); } catch { /* gone */ }
                setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 3000).unref();
            }
        });

        let stderrTail = '';
        proc.stderr.on('data', (data) => {
            stderrTail = (stderrTail + data.toString()).slice(-2000);
        });

        proc.on('close', (code, signal) => {
            releaseSlot(entry);
            entry.process = null;
            entry.finishedAt = Date.now();
            if (entry.status !== 'downloading') { removePartials(id); return; } // cancelled or timed out
            if (stdoutRest) applyLine(entry, stdoutRest.trim());

            if (code !== 0) {
                const last = stderrTail.split('\n').map(l => l.trim()).filter(l => l && !/^\[download\]/.test(l)).pop()
                    || (signal ? 'The download took too long and was stopped' : `yt-dlp exited with code ${code}`);
                console.error(`[Download] ${id} (${quality}) failed: ${last}`);
                entry.status = 'error';
                entry.error = friendlyDownloadError(last);
                if (/Sign in to confirm|not a bot/i.test(String(last))) noteUpstream('blocked');
                removePartials(id);
                return;
            }

            // Find the output file (yt-dlp may change extension)
            const dir = path.resolve(config.downloadsDir);
            const files = fs.readdirSync(dir).filter(f => f.startsWith(id) && !/\.(part|ytdl|temp)$/i.test(f));
            if (files.length === 0) {
                // yt-dlp exits 0 when --match-filter or --max-filesize skipped the video.
                entry.status = 'error';
                entry.error = entry.limitError
                    || (entry.probed && !Number.isFinite(entry.duration) ? 'This video has no known length (a live or upcoming stream); it can be saved once it has ended.' : null)
                    || `This video is over the limits here: at most ${fmtHours(config.download.maxDuration)} long and ${sizeLabel()} per file.`;
                removePartials(id);
                return;
            }

            const outFile = files[0];
            const ext = path.extname(outFile).slice(1);
            const filePath = path.join(dir, outFile);
            const stat = fs.statSync(filePath);

            entry.status = 'done';
            entry.phase = 'done';
            entry.progress = 100;
            entry.speed = '';
            entry.eta = '';
            entry.filePath = filePath;
            entry.fileSize = stat.size;
            entry.ext = ext;
            entry.filename = downloadFilename(entry.title, ext);

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
                filename: entry.filename,
                expiresAt: Date.now() + config.retention.fileTTL,
            });
        });

        proc.on('error', (err) => {
            releaseSlot(entry);
            entry.finishedAt = Date.now();
            if (entry.status !== 'downloading') return;
            entry.status = 'error';
            entry.error = err.code === 'ENOENT' ? 'The downloader is not installed on this server' : `yt-dlp error: ${err.message}`;
        });

        resolve({ id });
    });
}

// ── Cancel ───────────────────────────────────────────────────
/**
 * Stop a running download (kills yt-dlp and removes what it wrote) or discard a finished one.
 * @returns {null | { id, cancelled: boolean, removed: boolean }} null when the id is unknown
 */
function cancelDownload(id) {
    const dl = activeDownloads.get(id);
    if (!dl) return null;

    if (dl.status === 'downloading') {
        dl.status = 'error';
        dl.cancelled = true;
        dl.error = 'Download cancelled';
        dl.finishedAt = Date.now();
        const proc = dl.process;
        if (proc) {
            try { proc.kill('SIGTERM'); } catch { /* already gone */ }
            // ffmpeg children can ignore a polite stop; make sure nothing keeps writing.
            const hard = setTimeout(() => { try { if (dl.process) proc.kill('SIGKILL'); } catch { /* ok */ } }, 3000);
            hard.unref();
        } else {
            releaseSlot(dl);
            removePartials(id);
        }
        return { id, cancelled: true, removed: false };
    }

    if (dl.status === 'done') {
        removeFile(id);
        return { id, cancelled: false, removed: true };
    }
    return { id, cancelled: false, removed: false };
}

// ── Download Status ──────────────────────────────────────────
function getStatus(id) {
    const dl = activeDownloads.get(id);
    if (!dl) return null;
    return {
        id: dl.id,
        status: dl.status,                       // downloading | done | error
        phase: dl.status === 'downloading' ? dl.phase : dl.status,
        progress: dl.progress == null ? null : Math.round(dl.progress * 10) / 10, // 0–100, null = not known yet
        speed: dl.speed,
        eta: dl.eta,
        error: dl.error,
        cancelled: dl.cancelled || undefined,
        quality: dl.quality,
        title: dl.title || null,
        download: dl.status === 'done'
            ? { url: `/api/download/${id}`, size: dl.fileSize, ext: dl.ext, filename: dl.filename }
            : null,
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

    for (const [id, dl] of activeDownloads) {
        // Stuck for > 15 min with no file
        if (dl.status === 'downloading' && now - dl.startedAt > 15 * 60 * 1000) {
            dl.status = 'error';
            dl.error = 'Download timed out';
            dl.finishedAt = now;
            try { dl.process?.kill('SIGKILL'); } catch { /* ok */ }
            if (!dl.process) releaseSlot(dl);
        }
        // Failed / cancelled entries have no file to expire with; drop them after a while.
        if (dl.status === 'error' && dl.finishedAt && now - dl.finishedAt > 15 * 60 * 1000) {
            removePartials(id);
            activeDownloads.delete(id);
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

// ── Upstream self-check ──────────────────────────────────────
// YouTube sometimes refuses a whole server address ("confirm you're not a bot"). Rather than let
// every visitor find out after a click, probe a known public video on a timer and say so up front.
//   state: 'ok' | 'blocked' | 'unknown'   (GET /api/health → youtube, shown as a banner on the page)
const PROBE_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const PROBE_EVERY_MS = 30 * 60 * 1000;
let upstream = { state: 'unknown', checkedAt: 0, detail: '' };
let _probeTimer = null, _probing = false;

function probeUpstream() {
    if (_probing) return Promise.resolve(upstream);
    _probing = true;
    return new Promise((resolve) => {
        const args = ['--no-playlist', ...identityArgs(), '--simulate', '--no-warnings', '--socket-timeout', '20', '-f', 'ba/b', '--print', 'id', PROBE_URL];
        let err = '', out = '';
        let child;
        const done = (state, detail) => { _probing = false; upstream = { state, checkedAt: Date.now(), detail: String(detail || '').slice(0, 200) }; resolve(upstream); };
        try { child = spawn(config.ytdlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return done('unknown', e.message); }
        const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } }, 60000);
        child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
        child.on('error', e => { clearTimeout(killer); done('unknown', e.message); });
        child.on('close', (code) => {
            clearTimeout(killer);
            if (code === 0 && out.trim()) return done('ok', '');
            if (/Sign in to confirm|not a bot|HTTP Error 429|HTTP Error 403/i.test(err)) return done('blocked', 'YouTube is refusing requests from this server address');
            done('unknown', err.split('\n').filter(Boolean).pop() || 'probe failed');
        });
    });
}
function startUpstreamProbe() { if (_probeTimer) return; setTimeout(() => probeUpstream().catch(() => {}), 5000).unref(); _probeTimer = setInterval(() => probeUpstream().catch(() => {}), PROBE_EVERY_MS); _probeTimer.unref(); }
function getUpstream() { return upstream; }
/** A real request just told us more than the timer knows. */
function noteUpstream(state) { if (state === 'ok' || state === 'blocked') upstream = { state, checkedAt: Date.now(), detail: state === 'blocked' ? 'YouTube is refusing requests from this server address' : '' }; }

module.exports = {
    getInfo, getInfoLimited, cachedInfo, videoId, limitReason, infoStats, startDownload, cancelDownload, getStatus, getFile, removeFile,
    sanitizeTitle, downloadFilename, contentDisposition, applyLine,
    cleanup, startCleanup, stopCleanup, getStats, isValidUrl, probeUpstream, startUpstreamProbe, getUpstream,
};
