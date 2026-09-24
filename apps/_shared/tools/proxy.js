'use strict';
// ═══════════════════════════════════════════════════════════════
// Forward one API request to a Tools app on loopback and stream the answer back (the gateway's run
// API for satellite tools and its /api/v1/jobs facade). Uploads, SSE event streams and result files
// pass through without being buffered. The caller's own address goes along as the one trusted hop
// (X-Forwarded-For = req.ip, as the host proxy does), with its credentials, Idempotency-Key,
// Last-Event-ID and trace headers. Small JSON answers can be read on the way (onJson), e.g. to learn
// which satellite holds a job. The gateway's CORS headers are the ones the browser sees.
// No dependencies (node:http).
// ═══════════════════════════════════════════════════════════════

const http = require('http');

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);
const JSON_MAX = 1024 * 1024;

function outHeaders(req, extra = {}) {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && !k.startsWith('x-ov-')) headers[k] = v;
    const client = String(req.ip || (req.socket && req.socket.remoteAddress) || '');
    headers['x-forwarded-for'] = client;
    headers['x-real-ip'] = client;
    headers['cf-connecting-ip'] = client;
    headers['x-forwarded-host'] = String(req.headers['x-forwarded-host'] || req.headers.host || '');
    headers['x-forwarded-proto'] = 'https';
    // The satellite sees the public host (same-origin checks, canonical links) as the gateway did.
    if (req.headers.host) headers.host = req.headers.host;
    return Object.assign(headers, extra);
}

/**
 * @param {object} req  @param {object} res
 * @param {object} o
 * @param {number} o.port
 * @param {string} [o.path]            default req.originalUrl
 * @param {string} [o.method]          default req.method
 * @param {Buffer} [o.body]            the whole body (already read); else `head` + the rest of req
 * @param {Buffer} [o.head]            bytes of req already read (a peek), sent before the rest
 * @param {(body, status, headers) => void} [o.onJson]   sees a JSON answer (≤ 1 MB) before it is sent
 * @param {number} [o.timeoutMs=600000]
 * @param {() => void} [o.onError]     the satellite could not be reached (default: 502 problem)
 * @returns {Promise<void>} settles when the answer has been handed over
 */
function forward(req, res, o) {
    return new Promise((resolve) => {
        const extra = {};
        if (o.body) { extra['content-length'] = String(o.body.length); delete req.headers['transfer-encoding']; }
        const up = http.request({ host: '127.0.0.1', port: o.port, method: o.method || req.method, path: o.path || req.originalUrl || req.url, headers: outHeaders(req, extra) }, (r) => {
            const headers = {};
            for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k) && !k.startsWith('access-control-')) headers[k] = v;
            const type = String(r.headers['content-type'] || '');
            const len = Number(r.headers['content-length'] || 0);
            if (o.onJson && /json/.test(type) && len <= JSON_MAX) {
                const chunks = [];
                let size = 0;
                r.on('data', (c) => { size += c.length; if (size <= JSON_MAX) chunks.push(c); });
                r.on('end', () => {
                    const buf = Buffer.concat(chunks);
                    if (size <= JSON_MAX) { try { o.onJson(JSON.parse(buf.toString('utf8')), r.statusCode, r.headers); } catch { /* not JSON after all */ } }
                    headers['content-length'] = String(buf.length);
                    if (!res.headersSent) res.writeHead(r.statusCode || 502, headers);
                    res.end(buf);
                    resolve();
                });
                r.on('error', () => { res.destroy(); resolve(); });
                return;
            }
            res.writeHead(r.statusCode || 502, headers);
            if (typeof res.flushHeaders === 'function' && /event-stream/.test(type)) res.flushHeaders();
            r.pipe(res);
            r.on('end', resolve);
            r.on('error', () => { res.destroy(); resolve(); });
        });
        up.setTimeout(o.timeoutMs || 10 * 60_000, () => up.destroy(new Error('upstream timeout')));
        up.on('error', () => {
            if (!res.headersSent) {
                if (o.onError) o.onError();
                else {
                    res.statusCode = 502;
                    res.setHeader('Content-Type', 'application/problem+json');
                    res.setHeader('Retry-After', '5');
                    res.end(JSON.stringify({ type: 'https://openvibe.network/problems/tools.unavailable', title: 'Bad Gateway', status: 502, code: 'tools.unavailable', detail: 'This tool is restarting. Try again in a moment.', error: 'This tool is restarting. Try again in a moment.' }));
                }
            } else res.destroy();
            resolve();
        });
        res.on('close', () => { if (!res.writableFinished) up.destroy(); });
        if (o.body) up.end(o.body);
        else {
            if (o.head && o.head.length) up.write(o.head);
            req.pipe(up);
        }
    });
}

module.exports = { forward, outHeaders };
