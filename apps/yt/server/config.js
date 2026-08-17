'use strict';

require('dotenv').config();

module.exports = {
    port: parseInt(process.env.PORT, 10) || 4013,
    host: process.env.HOST || '127.0.0.1',

    // yt-dlp binary path (auto-detect or override)
    ytdlpPath: process.env.YTDLP_PATH || 'yt-dlp',

    // Download limits
    download: {
        maxDuration: 3 * 60 * 60,     // 3 hours max video length (seconds)
        timeout: 10 * 60 * 1000,       // 10 min download timeout (ms)
        maxConcurrent: 5,               // max concurrent downloads
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
