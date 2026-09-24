'use strict';

// ═══════════════════════════════════════════════════════════════
// Dev.OpenVibe — API Routes
// Server-side endpoints for webhook bins, Open Graph fetching,
// and tool listing. Most dev tools are client-side only.
//
// Guard (apps/_shared/guard, opts.guard): the Open Graph fetcher counts against tools-fetch and a
// per-target throttle; a webhook bin belongs to whoever made it (the browser session cookie, a
// sign-in or a token): only they can read or delete it, anyone may post to its /in URL. Bins per
// owner and per address are capped (limits.js webhook), so one address cannot fill the global cap.
// ═══════════════════════════════════════════════════════════════

const { Router } = require('express');
const crypto = require('crypto');
const { DEV_TOOLS } = require('./config');
const { createEgress, TargetRefused } = require('../../../_shared/egress');
const { createCallerResolver } = require('../../../_shared/guard/caller');
const guardLimits = require('../../../_shared/guard/limits');

// ── In-memory webhook bin storage ────────────────────────────
const webhookBins = new Map();                // binId → { created, requests, owner, ipKey }
const WEBHOOK_BIN_TTL = 60 * 60 * 1000;       // 1 hour
const WEBHOOK_MAX_REQUESTS = 200;

function cleanupBins() {
    const now = Date.now();
    for (const [id, bin] of webhookBins) {
        if (now - bin.created > WEBHOOK_BIN_TTL) webhookBins.delete(id);
    }
}
setInterval(cleanupBins, 5 * 60 * 1000).unref();

// ── Helpers ──────────────────────────────────────────────────
const OG_MAX_BYTES = 2 * 1024 * 1024;   // Open Graph tags live in <head>; never buffer more than this

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
// `opts.egress` is for tests: the shared SSRF guard with a mock resolver and transports.
// `opts.guard` is the gateway's guard (identify() has run before these routes; quotas, the per-target
// throttle, the abuse log). Without one (tests), bins are still owned: by the session cookie.
module.exports = function createDevRoutes(db, requireAuth, opts = {}) {
    const router = Router();
    const egress = opts.egress || createEgress();
    const guard = opts.guard || null;
    const callers = guard ? null : createCallerResolver({ getPublicKey: () => null });
    const whoIs = (req, res, create) => (guard ? guard.resolveCaller(req, res, { create }) : callers.resolve(req, res, { create }));
    const caps = guardLimits.bounds().webhook;
    const refuse = (req, res, r) => (guard ? guard.refuse(req, res, r) : (res.status(r.status).json({ error: r.detail, code: r.code }), true));

    // Every dev API call (and the Open Graph fetcher's own tools-fetch quota, below).
    if (guard) router.use(guard.toolQuota((req) => (req.method === 'GET' && req.path === '/opengraph' ? 'opengraph' : null)));

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
    router.get('/opengraph', async (req, res) => {
        let targetUrl = req.query.url || req.query.target;
        if (!targetUrl) return res.status(400).json({ error: 'Missing ?url= parameter' });

        // Ensure protocol
        if (!/^https?:\/\//i.test(targetUrl)) targetUrl = 'https://' + targetUrl;

        try {
            new URL(targetUrl); // validate
        } catch {
            return res.status(400).json({ error: 'Invalid URL' });
        }
        // Per-target throttle (descriptor opengraph: limits.perTargetPerMinute), across every caller.
        if (guard && !guard.target(req, res, { tool: 'opengraph', target: targetUrl })) return;

        try {
            // Public addresses only, checked after DNS and dialled as checked; each redirect hop is
            // checked again (shared SSRF guard).
            const response = await egress.follow(targetUrl, {
                method: 'GET',
                headers: {
                    'User-Agent': 'OpenVibeOpenGraph/1.0 (https://opengraph.openvibe.tools)',
                    'Accept': 'text/html,application/xhtml+xml',
                },
                timeoutMs: 10000,
                maxBytes: OG_MAX_BYTES,
                maxRedirects: 5,
            });
            const html = response.body.toString('utf8');
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
            if (err instanceof TargetRefused) return res.status(403).json({ error: err.message, code: err.code });
            if (err && err.status === 400) return res.status(400).json({ error: err.message });
            res.status(502).json({ error: `Failed to fetch: ${err.message}` });
        }
    });

    // ── Webhook Bins ─────────────────────────────────────────

    /** The bin, if it exists AND belongs to the caller; otherwise null (the same 404 either way). */
    function ownBin(req, res) {
        const bin = webhookBins.get(req.params.binId);
        const who = whoIs(req, res, false);
        return bin && who.owner && bin.owner === who.owner ? bin : null;
    }

    // Create a new bin. Its owner is the caller: a browser gets the session cookie here (the page
    // calls with credentials), a signed-in person or a token is itself.
    router.post('/webhook/bins', (req, res) => {
        cleanupBins();
        if (webhookBins.size >= caps.total) {
            return res.status(429).json({ error: 'Too many active bins. Try again later.' });
        }
        const who = whoIs(req, res, true);
        let mine = 0, fromHere = 0;
        for (const b of webhookBins.values()) { if (b.owner === who.owner) mine++; if (b.ipKey === who.ipKey) fromHere++; }
        if (mine >= caps.perOwner && refuse(req, res, { status: 429, code: 'tools.quota.exceeded', reason: 'webhook', tool: 'webhook', retryAfter: 300, detail: `At most ${caps.perOwner} webhook bins at a time; old ones expire after an hour.`, extra: { scope: 'webhook' } })) return undefined;
        if (fromHere >= caps.perIp && refuse(req, res, { status: 429, code: 'tools.quota.exceeded', reason: 'webhook', tool: 'webhook', retryAfter: 300, detail: `At most ${caps.perIp} webhook bins from one address at a time.`, extra: { scope: 'address' } })) return undefined;

        const binId = crypto.randomBytes(12).toString('hex');
        webhookBins.set(binId, {
            created: Date.now(),
            requests: [],
            owner: who.owner,
            ipKey: who.ipKey,
        });

        res.json({
            ok: true,
            binId,
            url: `https://openvibe.tools/api/dev/webhook/bins/${binId}/in`,
            expiresIn: '1 hour',
        });
    });

    // Get bin requests (its owner only)
    router.get('/webhook/bins/:binId', (req, res) => {
        res.set('Cache-Control', 'private, no-store');
        const bin = ownBin(req, res);
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

    // Delete bin (its owner only; anyone else learns nothing)
    router.delete('/webhook/bins/:binId', (req, res) => {
        const bin = ownBin(req, res);
        const deleted = bin ? webhookBins.delete(req.params.binId) : false;
        res.json({ ok: true, deleted });
    });

    return router;
};
