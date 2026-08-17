'use strict';

// ═══════════════════════════════════════════════════════════════
// Docs.OpenVibe — Rate Limiting Middleware
// Tiered rate limits: anonymous vs authenticated users.
// Includes anti-abuse burst protection.
// ═══════════════════════════════════════════════════════════════

const rateLimit = require('express-rate-limit');

/** General API rate limit */
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: (req) => req.user ? 120 : 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.user?.sub || req.user?.id || req.ip,
    message: { error: 'Too many requests. Please try again later.' },
});

/**
 * Processing rate limit — stricter, tiered by auth.
 * Anonymous: 10 conversions/minute
 * Authenticated: 30 conversions/minute
 */
const processLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: (req) => req.user ? 30 : 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.user?.sub || req.user?.id || req.ip,
    message: { error: 'Processing rate limit reached. Sign in for higher limits or wait a moment.' },
});

/**
 * Anti-burst limiter — prevents rapid-fire abuse.
 * Very short window: max 4 requests per 5 seconds per IP.
 */
const burstLimiter = rateLimit({
    windowMs: 5 * 1000,
    max: 4,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: (req) => req.ip,
    message: { error: 'Too many requests in quick succession. Please slow down.' },
});

module.exports = { apiLimiter, processLimiter, burstLimiter };
