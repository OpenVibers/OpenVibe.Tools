'use strict';

require('dotenv').config();

module.exports = {
    port: parseInt(process.env.PORT, 10) || 4014,
    host: process.env.HOST || '127.0.0.1',

    // Upload limits
    upload: {
        maxFileSize: 100 * 1024 * 1024, // 100 MB (audio files can be large)
        allowedMimes: [
            'audio/mpeg', 'audio/mp3',
            'audio/wav', 'audio/x-wav', 'audio/wave',
            'audio/flac', 'audio/x-flac',
            'audio/ogg', 'audio/vorbis',
            'audio/mp4', 'audio/x-m4a', 'audio/aac',
            'audio/opus',
            'audio/x-ms-wma',
            'audio/aiff', 'audio/x-aiff',
            'audio/ac3',
            'audio/webm',
            'audio/amr',
            // Video files (for extract tool)
            'video/mp4', 'video/webm', 'video/x-matroska',
            'video/avi', 'video/x-msvideo',
            'video/quicktime', 'video/x-flv',
            'video/ogg',
            // Fallbacks for browsers that mis-type
            'application/ogg', 'application/octet-stream',
        ],
    },

    // Ephemeral file retention (milliseconds)
    retention: {
        anonTTL:   60 * 60 * 1000,       // 1 hour
        authedTTL: 24 * 60 * 60 * 1000,   // 24 hours
        cleanupInterval: 5 * 60 * 1000,    // every 5 min
        tempMaxAge: 10 * 60 * 1000,        // 10 min for uploads
    },

    // Paths
    dataDir: process.env.DATA_DIR || 'data',
    uploadsDir: process.env.UPLOADS_DIR || 'data/uploads',
    outputDir: process.env.OUTPUT_DIR || 'data/output',

    // Auth — OpenVibe Network (RS256 JWT issuer + JWKS source)
    networkUrl: process.env.OV_NETWORK_URL || 'https://openvibe.network',
    networkInternalUrl: process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000',
    // Optional PEM file override (air-gapped setups)
    publicKeyPaths: [
        process.env.OV_NETWORK_PUBLIC_KEY,
    ].filter(Boolean),
};
