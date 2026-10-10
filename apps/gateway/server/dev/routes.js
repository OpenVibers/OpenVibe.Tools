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
const { readHtml, decodeBody } = require('./reader');

// ── In-memory webhook bin storage ────────────────────────────
const webhookBins = new Map();                // binId → { created, requests, bytes, owner, ipKey }
const WEBHOOK_BIN_TTL = 60 * 60 * 1000;       // 1 hour
const WEBHOOK_MAX_REQUESTS = 200;
// A bin holds a bounded amount of memory: a received body is kept up to WEBHOOK_MAX_BODY_BYTES (the
// rest is cut, and the entry says so), and a bin keeps at most WEBHOOK_MAX_BIN_BYTES in all (oldest
// entries go first). Without the caps, one address's ten bins × 200 entries × the 1 MB JSON body
// limit could pin gigabytes of the gateway's heap.
const WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
const WEBHOOK_MAX_BIN_BYTES = 1024 * 1024;

function cleanupBins() {
    const now = Date.now();
    for (const [id, bin] of webhookBins) {
        if (now - bin.created > WEBHOOK_BIN_TTL) webhookBins.delete(id);
    }
}
setInterval(cleanupBins, 5 * 60 * 1000).unref();

// ── Helpers ──────────────────────────────────────────────────
const OG_MAX_BYTES = 2 * 1024 * 1024;   // Open Graph tags live in <head>; never buffer more than this
const READ_MAX_BYTES = 2 * 1024 * 1024; // the reader never buffers more than this of a page
const READ_USER_AGENT = 'OpenVibeReader/1.0 (+https://read.openvibe.tools)';

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
// The webhook bins' own API (it was part of /api/dev, which is gone): /api/dev/webhook/bins… on the
// outside. `opts.guard` is the gateway's guard (identify() has run before these routes; bin caps and the
// abuse log). Without one (tests), bins are still owned: by the session cookie.
function createWebhookRouter(opts = {}) {
    const router = Router();
    const guard = opts.guard || null;
    const callers = guard ? null : createCallerResolver({ getPublicKey: () => null });
    const whoIs = (req, res, create) => (guard ? guard.resolveCaller(req, res, { create }) : callers.resolve(req, res, { create }));
    const caps = guardLimits.bounds().webhook;
    const refuse = (req, res, r) => (guard ? guard.refuse(req, res, r) : (res.status(r.status).json({ error: r.detail, code: r.code }), true));

    /** The bin, if it exists AND belongs to the caller; otherwise null (the same 404 either way). */
    function ownBin(req, res) {
        const bin = webhookBins.get(req.params.binId);
        const who = whoIs(req, res, false);
        return bin && who.owner && bin.owner === who.owner ? bin : null;
    }

    // Create a new bin. Its owner is the caller: a browser gets the session cookie here (the page
    // calls with credentials), a signed-in person or a token is itself.
    router.post('/bins', (req, res) => {
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
        webhookBins.set(binId, { created: Date.now(), requests: [], bytes: 0, owner: who.owner, ipKey: who.ipKey });

        res.json({
            ok: true,
            binId,
            url: `https://openvibe.tools/api/dev/webhook/bins/${binId}/in`,
            expiresIn: '1 hour',
        });
    });

    // Get bin requests (its owner only)
    router.get('/bins/:binId', (req, res) => {
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
    router.all('/bins/:binId/in', (req, res) => {
        const bin = webhookBins.get(req.params.binId);
        if (!bin) return res.status(404).json({ error: 'Bin not found or expired' });

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

        // A large webhook (a GitHub push, a Stripe event) is still received: its body is kept as text up
        // to the cap, marked truncated, so the bin shows what arrived without holding all of it.
        const bodyText = entry.body == null ? '' : (typeof entry.body === 'string' ? entry.body : JSON.stringify(entry.body));
        if (Buffer.byteLength(bodyText) > WEBHOOK_MAX_BODY_BYTES) {
            entry.body = Buffer.from(bodyText).subarray(0, WEBHOOK_MAX_BODY_BYTES).toString('utf8');
            entry.truncated = true;
        }
        const entryBytes = Buffer.byteLength(JSON.stringify(entry));

        // Keep the bin within its count and byte bounds, dropping the oldest entries first.
        while (bin.requests.length && (bin.requests.length >= WEBHOOK_MAX_REQUESTS || bin.bytes + entryBytes > WEBHOOK_MAX_BIN_BYTES)) {
            bin.bytes -= Buffer.byteLength(JSON.stringify(bin.requests.shift()));
        }

        bin.requests.push(entry);
        bin.bytes += entryBytes;

        res.status(200).json({ ok: true, message: 'Received' });
    });

    // Delete bin (its owner only; anyone else learns nothing)
    router.delete('/bins/:binId', (req, res) => {
        const bin = ownBin(req, res);
        const deleted = bin ? webhookBins.delete(req.params.binId) : false;
        res.json({ ok: true, deleted });
    });

    return router;
}

// ═════════════════════════════════════════════════════════════
// `opts.egress` is for tests: the shared SSRF guard with a mock resolver and transports.
// `opts.guard` is the gateway's guard. The webhook bins live in their own router (createWebhookRouter),
// mounted at /webhook here; the run API still calls the Open Graph route in this process.
module.exports = function createDevRoutes(db, requireAuth, opts = {}) {
    const router = Router();
    const egress = opts.egress || createEgress();
    const guard = opts.guard || null;

    // Every dev API call (and the Open Graph fetcher's own tools-fetch quota, below).
    if (guard) router.use(guard.toolQuota((req) => (req.method === 'GET' && (req.path === '/opengraph' || req.path === '/read') ? req.path.slice(1) : null)));

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
            console.error('[OpenGraph] fetch failed:', err.message);
            res.status(502).json({ error: 'Failed to fetch the page.' });
        }
    });

    // ── Web page reader ──────────────────────────────────────
    // A page's readable text (title, description, main text as light Markdown, outgoing links),
    // fetched through the same SSRF guard as Open Graph.
    router.get('/read', async (req, res) => {
        let targetUrl = String(req.query.url || req.query.target || '').trim();
        if (!targetUrl) return res.status(400).json({ error: 'Missing ?url= parameter' });
        const format = req.query.format === undefined || req.query.format === '' ? 'markdown' : String(req.query.format);
        if (format !== 'markdown' && format !== 'text') return res.status(400).json({ error: 'format must be "markdown" or "text"' });
        let maxChars = 20000;
        if (req.query.max_chars !== undefined && req.query.max_chars !== '') {
            maxChars = Number(req.query.max_chars);
            if (!Number.isInteger(maxChars) || maxChars < 1000 || maxChars > 50000) return res.status(400).json({ error: 'max_chars must be an integer from 1000 to 50000' });
        }
        if (targetUrl.length > 2048) return res.status(400).json({ error: 'URL is too long' });
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(targetUrl) && !/^https?:\/\//i.test(targetUrl)) return res.status(400).json({ error: 'Only http and https URLs are supported' });
        if (!/^https?:\/\//i.test(targetUrl)) targetUrl = 'https://' + targetUrl;
        try {
            new URL(targetUrl);
        } catch {
            return res.status(400).json({ error: 'Invalid URL' });
        }
        // Per-target throttle (descriptor read: limits.perTargetPerMinute), across every caller.
        if (guard && !guard.target(req, res, { tool: 'read', target: targetUrl })) return;

        try {
            const response = await egress.follow(targetUrl, {
                method: 'GET',
                headers: {
                    'User-Agent': READ_USER_AGENT,
                    'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9',
                },
                timeoutMs: 10000,
                maxBytes: READ_MAX_BYTES,
                maxRedirects: 5,
            });
            const finalUrl = response.url || targetUrl;
            const contentType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
            const raw = response.body;
            const sniffedHtml = !contentType && /^\s*(<!doctype html|<html|<head|<body)/i.test(raw.subarray(0, 512).toString('latin1'));
            const isHtml = /^(text\/html|application\/xhtml\+xml)$/.test(contentType) || sniffedHtml;
            const isText = contentType === 'text/plain';
            if (!isHtml && !isText) {
                return res.status(415).json({ error: `Not a readable page (${contentType || 'unknown content type'}); the reader handles HTML and plain text`, code: 'tools.read.unsupported_content_type', content_type: contentType || null });
            }
            const decoded = decodeBody(raw, response.headers['content-type']);
            let out;
            if (isHtml) {
                out = readHtml(decoded, { baseUrl: finalUrl, format, maxChars });
            } else {
                const plain = decoded.replace(/\r\n?/g, '\n').trim();
                out = { title: '', description: '', lang: '', text: plain.slice(0, maxChars), truncated: plain.length > maxChars, links: [] };
            }
            res.json({
                ok: true,
                url: finalUrl,
                status: response.status,
                content_type: contentType || (isHtml ? 'text/html' : 'text/plain'),
                title: out.title,
                description: out.description,
                lang: out.lang,
                text: out.text,
                truncated: out.truncated || Boolean(response.truncated),
                chars: out.text.length,
                links: out.links,
            });
        } catch (err) {
            if (err instanceof TargetRefused) return res.status(403).json({ error: err.message, code: err.code });
            if (err && err.status === 400) return res.status(400).json({ error: err.message });
            console.error('[Read] fetch failed:', err.message);
            res.status(502).json({ error: 'Failed to fetch the page.' });
        }
    });

    // ── Webhook Bins ─────────────────────────────────────────
    // Their own router (above): the bins' API, reachable at /api/dev/webhook/* on the gateway.
    router.use('/webhook', createWebhookRouter(opts));

    return router;
};

module.exports.createWebhookRouter = createWebhookRouter;
