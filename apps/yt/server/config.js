'use strict';

require('dotenv').config();

module.exports = {
    port: parseInt(process.env.PORT, 10) || 4013,
    host: process.env.HOST || '127.0.0.1',

    // yt-dlp binary path (auto-detect or override)
    ytdlpPath: process.env.YTDLP_PATH || 'yt-dlp',

    // Download limits (enforced: /api/info says so, /api/download refuses, yt-dlp gets --match-filter
    // and --max-filesize, and a download is stopped when its reported length or size passes them)
    download: {
        maxDuration: parseInt(process.env.YT_MAX_DURATION, 10) || 3 * 60 * 60,           // seconds (3 hours)
        maxFilesize: parseInt(process.env.YT_MAX_FILESIZE_MB, 10) || 2048,                  // MB per downloaded part (2 GB)
        timeout: 10 * 60 * 1000,       // 10 min download timeout (ms)
        maxConcurrent: 5,               // max concurrent downloads
    },

    // Video info (/api/info): yt-dlp runs at most this many at once, others wait in a short queue;
    // answers are kept per video id for a while.
    info: {
        maxConcurrent: parseInt(process.env.YT_INFO_CONCURRENCY, 10) || 3,
        maxQueued: 20,
        cacheTtlMs: 10 * 60 * 1000,
        cacheMax: 500,
    },

    // Ephemeral file retention (ms)
    retention: {
        fileTTL: 60 * 60 * 1000,        // 1 hour
        cleanupInterval: 5 * 60 * 1000,  // every 5 min
    },

    // Rate limits (per user/IP)
    rateLimit: {
        anonPerHour: 5,
        authedPerHour: 20,
    },

    // Paths
    dataDir: process.env.DATA_DIR || 'data',
    downloadsDir: process.env.DOWNLOADS_DIR || 'data/downloads',

    // Auth — OpenVibe Network (RS256 JWT issuer + JWKS source)
    networkUrl: process.env.OV_NETWORK_URL || 'https://openvibe.network',
    networkInternalUrl: process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000',
    // Optional PEM file override (air-gapped setups)
    publicKeyPaths: [
        process.env.OV_NETWORK_PUBLIC_KEY,
    ].filter(Boolean),
};
