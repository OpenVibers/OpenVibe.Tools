'use strict';

// ═══════════════════════════════════════════════════════════════
// Host roles for the satellite apps (shared-contracts §1).
//
// The Tools gateway owns the catalog of hosts. When it forwards a request it says which tool
// the host belongs to and what role the host plays:
//
//   X-OV-Tool            catalog id of the tool ("yt", "png", …)
//   X-OV-Host-Role       canonical | short | alias
//   X-OV-Canonical-Host  the host every canonical / og:url / JSON-LD url uses
//   X-OV-Short-Host      the host people type
//
// A satellite keeps its own domain map for branding, so without the headers it behaves as it
// always has (each host is its own canonical). With them, the canonical host comes from the
// gateway — which is how a custom domain becomes canonical without the satellite knowing it.
//
// No dependencies: every satellite requires this file by relative path.
// ═══════════════════════════════════════════════════════════════

const TOOLS_HOME = 'https://openvibe.tools/';
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const TOOL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function cleanHost(value) {
    const h = String(value || '').trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
    return HOST_RE.test(h) ? h : '';
}

/** Request hostname, lower-cased, without the port ('' when absent). */
function requestHost(req) {
    return String((req.headers && req.headers.host) || '').trim().toLowerCase().replace(/:\d+$/, '');
}

/** Loopback / LAN / bare names: development, health checks and service-to-service calls. */
function isLocalHost(host) {
    if (!host) return true;
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
    if (/^\[?[0-9a-f:]+\]?$/i.test(host)) return true;          // IPv6 literal
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;       // IPv4 literal
    return !host.includes('.');
}

/**
 * What the gateway said about this request.
 * @returns {{ viaGateway: boolean, tool: string, role: string, canonicalHost: string, shortHost: string }}
 */
function hostRole(req) {
    const h = req.headers || {};
    const toolRaw = String(h['x-ov-tool'] || '').trim().toLowerCase();
    const tool = TOOL_RE.test(toolRaw) ? toolRaw : '';
    const roleRaw = String(h['x-ov-host-role'] || '').trim().toLowerCase();
    const role = ['canonical', 'short', 'alias'].includes(roleRaw) ? roleRaw : '';
    return {
        viaGateway: !!tool,
        tool,
        role,
        canonicalHost: cleanHost(h['x-ov-canonical-host']),
        shortHost: cleanHost(h['x-ov-short-host']),
    };
}

/** The host canonical URLs are built on: the gateway's when it named one, else `fallbackHost`. */
function canonicalHostFor(req, fallbackHost) {
    const info = req.ovHost || hostRole(req);
    return info.canonicalHost || cleanHost(fallbackHost) || requestHost(req);
}

/** `https://<canonical host><pathname>` — query strings never belong in a canonical. */
function canonicalUrlFor(req, fallbackHost, pathname) {
    let p = pathname == null ? String(req.path || '/') : String(pathname);
    if (!p.startsWith('/')) p = `/${p}`;
    return `https://${canonicalHostFor(req, fallbackHost)}${p}`;
}

/**
 * Which host of the satellite's own domain map a request is for. Through the gateway the tool id
 * decides (a descriptive host, a mirror or a custom domain is not in the satellite's map, but
 * `<tool>.openvibe.tools` is); otherwise the Host header.
 * @param {(host: string) => boolean} has  is this hostname in the satellite's map?
 */
function ownHost(req, has) {
    const info = req.ovHost || hostRole(req);
    const byTool = info.tool ? `${info.tool}.openvibe.tools` : '';
    if (byTool && has(byTool)) return byTool;
    return requestHost(req);
}

/**
 * Swap `https://<fromHost>` for `https://<toHost>` inside <head> — for static pages whose canonical,
 * og:url and JSON-LD were written for one host (maps, food).
 */
function restampHead(html, fromHost, toHost) {
    if (!fromHost || !toHost || fromHost === toHost) return html;
    const end = html.search(/<\/head>/i);
    if (end < 0) return html;
    const from = new RegExp(`https://${fromHost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[/"'])`, 'g');
    return html.slice(0, end).replace(from, `https://${toHost}`) + html.slice(end);
}

/**
 * Handler for a static page written for one host: the canonical, og:url and JSON-LD in its <head>
 * are rewritten to the canonical host of this request (the gateway's X-OV-Canonical-Host, or
 * `ownHost` itself when reached directly). The file is read once.
 */
function stampedPage(file, ownHostName) {
    let html = null;
    const cache = new Map();
    return function sendStampedPage(req, res) {
        if (html === null) html = require('fs').readFileSync(file, 'utf8');
        const canonical = canonicalHostFor(req, ownHostName);
        if (!cache.has(canonical)) { if (cache.size > 50) cache.clear(); cache.set(canonical, restampHead(html, ownHostName, canonical)); }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Vary', 'X-OV-Canonical-Host');
        return res.send(cache.get(canonical));
    };
}

/**
 * Express middleware. Sets `req.ovHost` and turns away hosts this satellite does not serve.
 *
 * @param {object}   opts
 * @param {(host: string) => boolean} opts.knows    is this hostname in the satellite's own map?
 * @param {(host: string) => string}  [opts.aliasOf] where an alias in the satellite's own map points ('' = not an alias)
 * @param {string[]} [opts.skip]   path prefixes that are never redirected (APIs, health checks)
 */
function hostGuard(opts) {
    const knows = opts.knows;
    const aliasOf = opts.aliasOf || (() => '');
    const skip = opts.skip || ['/api/'];
    const extra = new Set(String(process.env.OV_EXTRA_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));

    return function ovHostGuard(req, res, next) {
        const info = hostRole(req);
        const host = requestHost(req);
        info.host = host;
        req.ovHost = info;

        if (skip.some(p => req.path.startsWith(p))) return next();
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();

        if (info.viaGateway) {
            // The gateway redirects aliases itself; this only covers a request that slipped past it.
            if (info.role === 'alias') {
                const target = info.shortHost || info.canonicalHost;
                if (target && target !== host) return res.redirect(301, `https://${target}${req.originalUrl || '/'}`);
            }
            return next();
        }

        if (isLocalHost(host) || extra.has(host)) return next();

        const target = cleanHost(aliasOf(host));
        if (target && target !== host) return res.redirect(301, `https://${target}${req.originalUrl || '/'}`);
        if (knows(host)) return next();

        // Not ours: never render a default page under a made-up brand.
        res.setHeader('Cache-Control', 'public, max-age=300');
        return res.redirect(301, TOOLS_HOME);
    };
}

module.exports = { hostRole, hostGuard, canonicalHostFor, canonicalUrlFor, ownHost, restampHead, stampedPage, requestHost, isLocalHost, cleanHost, TOOLS_HOME };
