'use strict';
const express = require('express');
const HOUR = 3600000;
const METRIC = 'successful_api_runs';
// Launch evidence: Tools PR #98 (09718c0), merged 2026-10-25 UTC. Dates are authored,
// never inferred from registry order, a restart or a first page view. Add future launches here.
const LAUNCHES = { scan: '2026-10-25', datamatrix: '2026-10-25', pdf417: '2026-10-25', aztec: '2026-10-25', gs1: '2026-10-25', bulkbarcodes: '2026-10-25' };
function createDiscovery({ db, registry, now = Date.now }) {
    let memo, pending;
    async function snapshot() {
        const at = now();
        if (memo && at - memo.at < 60000 && memo.registry === registry.get().updated) return memo.value;
        if (pending) return pending;
        pending = (async () => {
            const hour = Math.floor(at / HOUR), today = Math.floor(hour / 24) * 24;
            // Last 168 UTC buckets versus the preceding 168; current hour versus preceding hour.
            const rows = await db.many(`SELECT tool,
                COALESCE(sum(uses) FILTER (WHERE hour >= $2), 0)::float8 AS week,
                COALESCE(sum(uses) FILTER (WHERE hour < $2), 0)::float8 AS previous_week,
                COALESCE(sum(uses) FILTER (WHERE hour >= $3), 0)::float8 AS today,
                COALESCE(sum(uses) FILTER (WHERE hour = $4), 0)::float8 AS current_hour,
                COALESCE(sum(uses) FILTER (WHERE hour = $4 - 1), 0)::float8 AS previous_hour
                FROM tool_usage_hourly WHERE hour >= $1 AND hour <= $4 GROUP BY tool`,
            [hour - 335, hour - 167, today, hour]);
            const tools = registry.get().tools.filter(t => t.status !== 'unavailable');
            const byId = new Map(tools.map(t => [t.id, t]));
            const item = t => ({ id: t.id, name: t.name, description: t.tagline, family: t.family, icon: t.icon, url: t.url });
            const valid = rows.filter(r => byId.has(r.tool));
            const ranked = (field, previous) => valid.filter(r => Number(r[field]) > 0 && (!previous || Number(r[field]) > Number(r[previous])))
                .map(r => ({ ...item(byId.get(r.tool)), uses: Number(r[field]), ...(previous ? { previous_uses: Number(r[previous]), increase: Number(r[field]) - Number(r[previous]) } : {}) }))
                .sort((a,b) => (previous ? b.increase - a.increase : b.uses - a.uses) || b.uses - a.uses || a.id.localeCompare(b.id));
            const value = { available: true, metric: METRIC, updated_at: new Date(at).toISOString(),
                uses_today: valid.reduce((sum,r) => sum + Number(r.today), 0),
                popular: ranked('week'), week: ranked('week', 'previous_week'), hour: ranked('current_hour', 'previous_hour'),
                newest: tools.filter(t => LAUNCHES[t.id]).map(t => ({ ...item(t), added_at: LAUNCHES[t.id] })).sort((a,b) => b.added_at.localeCompare(a.added_at) || a.id.localeCompare(b.id)) };
            memo = { at, registry: registry.get().updated, value };
            return value;
        })();
        try { return await pending; } finally { pending = null; }
    }
    function router() {
        const r = express.Router();
        for (const kind of ['popular', 'trending']) r.get(`/api/v1/tools/${kind}`, async (req,res) => {
            res.set('Access-Control-Allow-Origin', '*');
            const limit = req.query.limit === undefined ? 12 : Number(req.query.limit);
            const window = req.query.window === undefined ? 'week' : req.query.window;
            if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !['hour','week'].includes(window) || (kind === 'popular' && window !== 'week')) return res.status(400).json({ error: 'Use limit 1–50 and window hour or week (popular: week only).' });
            try {
                const s = await snapshot();
                const items = s[kind === 'popular' ? 'popular' : window].slice(0,limit);
                res.set('Cache-Control','public, max-age=60');
                res.json({ metric: METRIC, window, updated_at: s.updated_at, uses_today: s.uses_today, tools: items, count: items.length });
            } catch {
                res.set('Cache-Control','no-store');
                res.status(503).json({ error: 'Tool usage is temporarily unavailable.' });
            }
        });
        return r;
    }
    return { snapshot, router };
}
module.exports = { createDiscovery, LAUNCHES };
