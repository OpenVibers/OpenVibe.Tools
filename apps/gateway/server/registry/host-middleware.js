'use strict';
// Host roles at the door (shared-contracts §1). Runs before body parsing so proxied uploads and
// SSE streams pass through untouched.
//   alias                     → 301 short host (same path)
//   unknown *.openvibe.tools  → 301 https://openvibe.tools/   (no made-up brands)
//   unknown custom domain     → 404
//   tool/family on a satellite → streamed to the satellite with X-OV-* headers
//   everything else           → req.ovHost for the gateway's own pages
const http = require('http');
const registry = require('./index');

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

const BOT_RE = /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|embedly|quora|pinterest|vkshare|w3c_validator|whatsapp|telegram|discord|slack|twitter|linkedin|preview|lighthouse|headless|curl|wget|python|httpclient|go-http|java\/|ruby|perl|scrapy|gpt|claude|anthropic|perplexity|ccbot|bytespider|amazonbot|applebot|yandex|baidu|duckduck|archive\.org|ia_archiver/i;
/** A browser loading a page for a person: GET, wants HTML, has a browser UA, is not a crawler or link preview. */
function isPersonNavigating(req) {
    if (req.method !== 'GET') return false;
    const ua = String(req.headers['user-agent'] || '');
    if (!/Mozilla\//.test(ua) || BOT_RE.test(ua)) return false;
    if (!/text\/html/.test(String(req.headers.accept || ''))) return false;
    const dest = req.headers['sec-fetch-dest'];
    return !dest || dest === 'document';
}

function proxyTo(port, info, req, res) {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && !k.startsWith('x-ov-')) headers[k] = v;
    headers['x-ov-tool'] = info.tool;
    headers['x-ov-host-role'] = info.role;
    headers['x-ov-canonical-host'] = info.canonicalHost;
    headers['x-ov-short-host'] = info.shortHost;
    headers['x-forwarded-host'] = info.host;
    headers['x-forwarded-proto'] = 'https';
    // The gateway is the satellite's one trusted hop (TRUST_PROXY): it passes on the address it
    // resolved itself (req.ip, from nginx), never a chain a client could have started.
    const client = String(req.ip || req.socket.remoteAddress || '');
    headers['x-forwarded-for'] = client;
    headers['x-real-ip'] = client;
    headers['cf-connecting-ip'] = client;
    const up = http.request({ host: '127.0.0.1', port, method: req.method, path: req.originalUrl || req.url, headers }, (r) => {
        const out = {};
        for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k)) out[k] = v;
        res.writeHead(r.statusCode || 502, out);
        r.pipe(res);
    });
    up.setTimeout(10 * 60_000, () => up.destroy(new Error('upstream timeout')));
    up.on('error', () => { if (!res.headersSent) res.status(502).type('text/plain').send('This tool is restarting. Try again in a moment.'); else res.destroy(); });
    res.on('close', () => up.destroy());
    req.pipe(up);
}

/**
 * @param {object} opts
 * @param {(host: string) => string} opts.hostOf      request → hostname
 * @param {(sub: string) => boolean} opts.isLegacyHost gateway-served subdomains that are not catalog tools (aliases, pastes…)
 * @param {boolean} opts.enforce                        false in development: unknown hosts fall through
 */
function hostRoles(opts) {
    return function ovHostRoles(req, res, next) {
        const host = opts.hostOf(req);
        const info = registry.resolveHost(host);
        req.ovHost = info;
        if (info.kind === 'apex') return next();
        if (info.kind === 'unknown') {
            if (!opts.enforce) return next();
            if (!info.inZone) return res.status(404).type('text/plain').send('Not an OpenVibe site.');
            if (opts.isLegacyHost(info.host.slice(0, -('.' + registry.ZONE).length))) return next();
            res.set('Cache-Control', 'public, max-age=300');
            return res.redirect(301, `https://${registry.APEX}/`);
        }
        if (info.role === 'alias') {
            res.set('Cache-Control', 'public, max-age=300');
            return res.redirect(301, `https://${info.shortHost}${req.originalUrl || '/'}`);
        }
        // People get the address that is easiest to remember; crawlers stay on the canonical host.
        // The descriptive host (or a custom domain) is what links, sitemaps and rel=canonical name, so
        // search engines index that one. A person who follows such a link is sent on to the short host
        // (302, same path). Same page either way, so this is a convenience redirect, not different content.
        if (info.role === 'canonical' && info.shortHost && info.shortHost !== info.host && isPersonNavigating(req)) {
            res.set('Cache-Control', 'private, no-store'); res.set('Vary', 'User-Agent, Accept');
            return res.redirect(302, `https://${info.shortHost}${req.originalUrl || '/'}`);
        }
        if (info.port) return proxyTo(info.port, info, req, res);
        next();
    };
}

module.exports = { hostRoles, proxyTo, isPersonNavigating };
