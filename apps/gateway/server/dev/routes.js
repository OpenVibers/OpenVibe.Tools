'use strict';

// ═══════════════════════════════════════════════════════════════
// Dev.OpenVibe — API Routes
// Server-side endpoints for webhook bins, Open Graph fetching,
// and tool listing. Most dev tools are client-side only.
// ═══════════════════════════════════════════════════════════════

const { Router } = require('express');
const crypto = require('crypto');
const { DEV_TOOLS } = require('./config');

// ── In-memory webhook bin storage ────────────────────────────
const webhookBins = new Map();
const WEBHOOK_BIN_TTL = 60 * 60 * 1000;       // 1 hour
const WEBHOOK_MAX_REQUESTS = 200;
const WEBHOOK_MAX_BINS = 500;

function cleanupBins() {
    const now = Date.now();
    for (const [id, bin] of webhookBins) {
        if (now - bin.created > WEBHOOK_BIN_TTL) webhookBins.delete(id);
    }
}
setInterval(cleanupBins, 5 * 60 * 1000);

// ── Helpers ──────────────────────────────────────────────────
async function timedFetch(url, opts = {}, timeoutMs = 10000) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...opts, signal: ac.signal, redirect: 'follow' });
        clearTimeout(timer);
        return res;
    } catch (err) {
        clearTimeout(timer);
        throw err;
    }
}

function extractOGTags(html) {
    const tags = {};
    const metaRegex = /<meta\s+([^>]*?)>/gi;
    let match;
    while ((match = metaRegex.exec(html)) !== null) {
        const attrs = match[1];
        const propMatch = attrs.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i);
        const contentMatch = attrs.match(/content\s*=\s*["']([^"']*?)["']/i);
        if (propMatch && contentMatch) {
            const prop = propMatch[1].toLowerCase();
            if (prop.startsWith('og:') || prop.startsWith('twitter:') || prop === 'description' || prop === 'theme-color') {
                tags[prop] = contentMatch[1];
            }
        }
    }
    // Also grab <title>
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    if (titleMatch) tags['title'] = titleMatch[1].trim();
    return tags;
}

// ═════════════════════════════════════════════════════════════
module.exports = function createDevRoutes(db, requireAuth) {
    const router = Router();

    // Optional auth — attaches req.user if token present, but doesn't block.
    // Verifies the shared ov_token OFFLINE against the Network public key.
    function optionalAuth(req, res, next) {
        const authHeader = req.headers.authorization;
        const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : req.cookies?.ov_token;
        const auth = req.app.locals.auth;
        if (!token || !auth) return next();
        Promise.resolve(auth.verify(token))
            .then(claims => { if (claims) req.user = claims; next(); })
            .catch(() => next());
    }

    // ── List all dev tools ───────────────────────────────────
    router.get('/tools', (_req, res) => {
        res.json({
            ok: true,
            tools: DEV_TOOLS.map(t => ({
                id: t.id, subdomain: t.subdomain, name: t.name,
                icon: t.icon, desc: t.desc, category: t.category,
                hub: t.hub || false,
            })),
        });
    });

    // ── Open Graph / Meta tag fetcher ────────────────────────
    router.get('/opengraph', optionalAuth, async (req, res) => {
        let targetUrl = req.query.url || req.query.target;
        if (!targetUrl) return res.status(400).json({ error: 'Missing ?url= parameter' });

        // Ensure protocol
        if (!/^https?:\/\//i.test(targetUrl)) targetUrl = 'https://' + targetUrl;

        try {
            new URL(targetUrl); // validate
        } catch {
            return res.status(400).json({ error: 'Invalid URL' });
        }

        try {
            const response = await timedFetch(targetUrl, {
                headers: {
                    'User-Agent': 'OpenVibeOpenGraph/1.0 (https://opengraph.openvibe.tools)',
                    'Accept': 'text/html,application/xhtml+xml',
                },
            });
            const html = await response.text();
            const tags = extractOGTags(html);

            // Build structured result
            const result = {
                ok: true,
                url: targetUrl,
                status: response.status,
                tags,
                preview: {
                    title: tags['og:title'] || tags['twitter:title'] || tags['title'] || '',
                    description: tags['og:description'] || tags['twitter:description'] || tags['description'] || '',
                    image: tags['og:image'] || tags['twitter:image'] || '',
                    siteName: tags['og:site_name'] || '',
                    type: tags['og:type'] || 'website',
                    twitterCard: tags['twitter:card'] || 'summary',
                    url: tags['og:url'] || targetUrl,
                    themeColor: tags['theme-color'] || '',
                },
                recommendations: [],
            };

            // SEO recommendations
            if (!tags['og:title']) result.recommendations.push({ level: 'error', msg: 'Missing og:title — required for social sharing' });
            if (!tags['og:description']) result.recommendations.push({ level: 'error', msg: 'Missing og:description — important for previews' });
            if (!tags['og:image']) result.recommendations.push({ level: 'warning', msg: 'Missing og:image — posts without images get less engagement' });
            if (!tags['og:url']) result.recommendations.push({ level: 'info', msg: 'Missing og:url — recommended for canonical URL' });
            if (!tags['twitter:card']) result.recommendations.push({ level: 'info', msg: 'Missing twitter:card — defaults to "summary"' });
            if (tags['og:image'] && !tags['og:image:width']) result.recommendations.push({ level: 'info', msg: 'Consider adding og:image:width and og:image:height' });
            if (!tags['og:site_name']) result.recommendations.push({ level: 'info', msg: 'Missing og:site_name — helps brand recognition' });

            res.json(result);
        } catch (err) {
            res.status(502).json({ error: `Failed to fetch: ${err.message}` });
        }
    });

    // ── Webhook Bins ─────────────────────────────────────────

    // Create a new bin
    router.post('/webhook/bins', optionalAuth, (_req, res) => {
        cleanupBins();
        if (webhookBins.size >= WEBHOOK_MAX_BINS) {
            return res.status(429).json({ error: 'Too many active bins. Try again later.' });
        }

        const binId = crypto.randomBytes(12).toString('hex');
        webhookBins.set(binId, {
            created: Date.now(),
            requests: [],
        });

        res.json({
            ok: true,
            binId,
            url: `https://openvibe.tools/api/dev/webhook/bins/${binId}/in`,
            expiresIn: '1 hour',
        });
    });

    // Get bin requests
    router.get('/webhook/bins/:binId', optionalAuth, (req, res) => {
        const bin = webhookBins.get(req.params.binId);
        if (!bin) return res.status(404).json({ error: 'Bin not found or expired' });

        res.json({
            ok: true,
            binId: req.params.binId,
            created: bin.created,
            requestCount: bin.requests.length,
            requests: bin.requests.slice().reverse(), // newest first
        });
    });

    // Receive a webhook (any HTTP method)
    router.all('/webhook/bins/:binId/in', (req, res) => {
        const bin = webhookBins.get(req.params.binId);
        if (!bin) return res.status(404).json({ error: 'Bin not found or expired' });

        if (bin.requests.length >= WEBHOOK_MAX_REQUESTS) {
            bin.requests.shift(); // drop oldest
        }

        const entry = {
            id: crypto.randomBytes(6).toString('hex'),
            timestamp: Date.now(),
            method: req.method,
            path: req.path,
            query: req.query,
            headers: { ...req.headers },
            body: req.body || null,
            ip: req.ip,
            contentType: req.get('content-type') || '',
            size: req.get('content-length') || 0,
        };

        // Remove sensitive proxy headers
        delete entry.headers['cookie'];
        delete entry.headers['authorization'];

        bin.requests.push(entry);

        res.status(200).json({ ok: true, message: 'Received' });
    });

    // Delete bin
    router.delete('/webhook/bins/:binId', optionalAuth, (req, res) => {
        const deleted = webhookBins.delete(req.params.binId);
        res.json({ ok: true, deleted });
    });

    return router;
};
