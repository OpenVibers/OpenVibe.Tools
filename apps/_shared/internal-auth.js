'use strict';
// Internal-only routes (analytics totals for the Network's admin and ranking).
// Two independent conditions, both required:
//   1. X-Internal-Key equals INTERNAL_API_KEY from the unit's environment (never a value in the repo;
//      with no key configured every internal route is closed).
//   2. The request did not come through the public proxy: nginx always adds X-Forwarded-For and
//      X-Real-IP, service-to-service calls on loopback never do.
const crypto = require('crypto');

function internalOk(req) {
    const want = String(process.env.INTERNAL_API_KEY || process.env.OV_INTERNAL_KEY || '');
    const got = String(req.headers['x-internal-key'] || '');
    if (want.length < 16 || got.length !== want.length) return false;
    if (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['cf-connecting-ip']) return false;
    const ip = String(req.socket && req.socket.remoteAddress || '');
    if (!/^(::1|::ffff:127\.|127\.)/.test(ip)) return false;
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

function requireInternal(req, res, next) { return internalOk(req) ? next() : res.status(404).json({ error: 'Not found' }); }

module.exports = { internalOk, requireInternal };
