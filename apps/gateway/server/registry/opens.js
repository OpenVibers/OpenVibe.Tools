'use strict';
// Tool opens: the count behind the home page's "Most opened this week".
//
// An open is a person's browser loading a tool's page on its own host (host-middleware's isPersonNavigating: a GET
// for HTML from a browser that is not a crawler or a link preview). Each address counts once per tool per UTC day,
// so a refresh, the canonical-to-short-host hop or a reload loop adds nothing. The dedupe set lives in this process
// only, holds salted hashes (never an address) and is dropped when the day changes; past MAX_SEEN keys a day stops
// counting new opens rather than counting them twice. What reaches the database (migration 0007) is one number per
// tool per day, written every FLUSH_MS.
const crypto = require('crypto');

const FLUSH_MS = 60_000;
const TOP_MS = 5 * 60_000;
const MAX_SEEN = 200_000;

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

function createOpens({ db, now = Date.now, log = console } = {}) {
    const salt = crypto.randomBytes(16);
    let day = null;
    let seen = new Set();
    const pending = new Map();   // `${day}|${tool}` → opens not yet written
    let topMemo = null;
    let timer = null;

    /** One open of `tool` from `address` (counted once per address, tool and day). */
    function record(tool, address) {
        if (!tool) return false;
        const d = dayOf(now());
        if (d !== day) { day = d; seen = new Set(); }
        const key = crypto.createHmac('sha256', salt).update(`${d}\u0000${address || ''}\u0000${tool}`).digest('base64url').slice(0, 22);
        if (seen.has(key) || seen.size >= MAX_SEEN) return false;
        seen.add(key);
        const k = `${d}|${tool}`;
        pending.set(k, (pending.get(k) || 0) + 1);
        return true;
    }

    /** Write what is pending (one upsert per tool and day); a failed write keeps the counts for the next flush. */
    async function flush() {
        if (!pending.size) return 0;
        const batch = [...pending];
        pending.clear();
        let written = 0;
        for (let i = 0; i < batch.length; i++) {
            const [k, n] = batch[i];
            try {
                await db.exec(
                    `INSERT INTO tool_opens_daily (tool, day, opens) VALUES ($1, $2::date, $3)
                     ON CONFLICT (tool, day) DO UPDATE SET opens = tool_opens_daily.opens + EXCLUDED.opens`,
                    [k.slice(11), k.slice(0, 10), n]);
                written += n;
            } catch (err) {
                // This one and every one after it wait for the next flush.
                for (const [kk, nn] of batch.slice(i)) pending.set(kk, (pending.get(kk) || 0) + nn);
                if (log.warn) log.warn('[tools] tool opens not written yet:', err.message);
                break;
            }
        }
        return written;
    }

    /** The most opened tools over the last `days` UTC days (today included): [{ tool, opens }], read at most every TOP_MS. */
    async function top(days = 7, limit = 12) {
        const at = now();
        if (topMemo && at - topMemo.at < TOP_MS && topMemo.days === days && topMemo.limit === limit) return topMemo.rows;
        const since = dayOf(at - (days - 1) * 86_400_000);
        const rows = (await db.many(
            `SELECT tool, sum(opens)::int AS opens FROM tool_opens_daily WHERE day >= $1::date
              GROUP BY tool ORDER BY opens DESC, tool LIMIT $2`,
            [since, limit])).map((r) => ({ tool: String(r.tool), opens: Number(r.opens) || 0 }));
        topMemo = { at, days, limit, rows };
        return rows;
    }

    /** The top list as a short string: a page cached on it is rebuilt when the list it shows changes, and only then. */
    const version = () => (topMemo ? topMemo.rows.map((r) => `${r.tool}:${r.opens}`).join(',') : '');

    function start() {
        if (timer) return;
        timer = setInterval(() => { flush().catch(() => {}); }, FLUSH_MS);
        timer.unref();
    }
    async function stop() {
        if (timer) clearInterval(timer);
        timer = null;
        await flush().catch(() => {});
    }

    return { record, flush, top, version, start, stop };
}

module.exports = { createOpens, dayOf, MAX_SEEN };
