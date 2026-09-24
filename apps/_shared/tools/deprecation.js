'use strict';
// ═══════════════════════════════════════════════════════════════
// The older tool endpoints (/api/process…, /api/net/*, /api/dev/*) keep working with their own
// response shapes, and say what replaces them (RFC 9745 Deprecation, RFC 8594 Sunset, RFC 8288 Link):
//
//   Deprecation: true
//   Sunset: Thu, 31 Dec 2026 23:59:59 GMT
//   Link: </api/v1/tools/{id}/run>; rel="successor-version"
// ═══════════════════════════════════════════════════════════════

const SUNSET = 'Thu, 31 Dec 2026 23:59:59 GMT';

/** Mark an answer deprecated; `successor` is a path (the tool's run route, or a registry listing). */
function deprecate(res, successor) {
    if (res.headersSent) return;
    res.setHeader('Deprecation', 'true');
    res.setHeader('Sunset', SUNSET);
    if (successor) res.setHeader('Link', `<${successor}>; rel="successor-version"`);
}

/** Middleware: successorOf(req) → a path or null (null: deprecated without a named successor is not said). */
function deprecated(successorOf) {
    return (req, res, next) => {
        const s = successorOf(req);
        if (s) deprecate(res, s);
        next();
    };
}

const runPath = (id) => (id ? `/api/v1/tools/${id}/run` : null);

module.exports = { deprecate, deprecated, runPath, SUNSET };
