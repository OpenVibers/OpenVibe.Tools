'use strict';
// ═══════════════════════════════════════════════════════════════
// Triggers: a made tool runs without anyone pressing Run (plan 2026-11-13 §AD.12 (g); migration 0019).
//
//   link      a secret URL, https://openvibe.tools/hooks/<mth_…>: GET or POST it and the tool runs as its owner with the
//             request's input over the trigger's fixed input. A webhook's own payload (GitHub, a form, a shop) goes
//             whole into the tool's one text field when it is not the tool's input. Only the token's SHA-256 is kept;
//             the URL is shown once, when it is made.
//   schedule  every hour (at a minute) or every day (at a time, UTC), with a fixed input.
//
// Every run is the owner's (their allowance pays) and the last answer is kept for /make. A code tool runs only in the
// browser for now, and a chain that calls tools people made needs a person signed in, so neither takes a trigger yet.
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');

const MAX_PER_OWNER = 20;
const RESULT_CHARS = 4000;
const LINK_PER_MINUTE = 30;
const ID_RE = /^mtt_[0-9A-HJKMNP-TV-Z]{26}$/;
const TOKEN_RE = /^mth_[A-Za-z0-9_-]{43}$/;
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

class TriggerError extends Error {
    constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function newId(now = Date.now()) {
    let t = now, time = '';
    for (let i = 0; i < 10; i++) { time = B32[t % 32] + time; t = Math.floor(t / 32); }
    const bytes = crypto.randomBytes(16);
    let rand = '';
    for (let i = 0; i < 16; i++) rand += B32[bytes[i] % 32];
    return `mtt_${time}${rand}`;
}
const hashOf = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/** The next time a schedule is due after `from` (ms): every hour at at_minute % 60, or every day at at_minute (UTC). */
function nextRun(everyMinutes, atMinute, from) {
    const d = new Date(from);
    if (everyMinutes === 60) {
        const at = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), atMinute % 60));
        return at.getTime() > from ? at.getTime() : at.getTime() + 3_600_000;
    }
    const at = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), Math.floor(atMinute / 60), atMinute % 60));
    return at.getTime() > from ? at.getTime() : at.getTime() + 86_400_000;
}

/** Words for a trigger, for people: "Every day at 09:00 UTC", "Every hour at :15", "A link …k3Zq". */
function describe(row) {
    if (row.kind === 'link') return `A link …${row.token_hint || ''}`;
    const hh = String(Math.floor(row.at_minute / 60)).padStart(2, '0');
    const mm = String(row.at_minute % 60).padStart(2, '0');
    return row.every_minutes === 60 ? `Every hour at :${mm}` : `Every day at ${hh}:${mm} UTC`;
}

/** Can this tool take a trigger? Words when it cannot. */
function refusal(tool) {
    if (tool.kind === 'code') return 'A code tool runs in your browser for now, so it cannot run on its own yet';
    if (tool.kind === 'chain' && ((tool.chain && tool.chain.steps) || []).some((s) => /^mtl_/.test(String(s.tool)))) {
        return 'A chain that calls tools people made needs you there to run them; a trigger can run chains of catalogue tools';
    }
    return null;
}

function createTriggers({ db, now = () => Date.now(), baseUrl = 'https://openvibe.tools' }) {
    const present = (row, extra = {}) => ({
        id: row.id, tool: row.tool_id, kind: row.kind, says: describe(row),
        ...(row.kind === 'schedule' ? { every: row.every_minutes === 60 ? 'hour' : 'day', at: `${String(Math.floor(row.at_minute / 60)).padStart(2, '0')}:${String(row.at_minute % 60).padStart(2, '0')}` } : { hint: row.token_hint }),
        input: row.input || {}, enabled: row.enabled !== false,
        next_run_at: row.next_run_at ? new Date(row.next_run_at).toISOString() : null,
        last_run_at: row.last_run_at ? new Date(row.last_run_at).toISOString() : null,
        last_state: row.last_state || null, last_result: row.last_result || null, runs: Number(row.runs) || 0,
        created_at: new Date(row.created_at).toISOString(), ...extra,
    });

    /** A new trigger on the owner's tool. A link's URL comes back here, once. */
    async function create(tool, owner, body = {}) {
        const why = refusal(tool);
        if (why) throw new TriggerError(422, 'tools.trigger.unsupported', why);
        const count = Number((await db.one('SELECT count(*)::int AS n FROM made_tool_triggers WHERE owner_subject = $1', [owner])).n);
        if (count >= MAX_PER_OWNER) throw new TriggerError(422, 'tools.trigger.limit', `You have ${MAX_PER_OWNER} triggers: delete one first`);
        const input = body.input && typeof body.input === 'object' && !Array.isArray(body.input) ? body.input : {};
        if (JSON.stringify(input).length > 20000) throw new TriggerError(422, 'tools.trigger.invalid', 'The fixed input is at most 20 KB');
        const id = newId(now());
        const at = new Date(now());
        if (body.kind === 'link') {
            const token = `mth_${crypto.randomBytes(32).toString('base64url')}`;
            const row = await db.one(`INSERT INTO made_tool_triggers (id, tool_id, owner_subject, kind, token_hash, token_hint, input, created_at, updated_at)
                VALUES ($1, $2, $3, 'link', $4, $5, $6::jsonb, $7, $7) RETURNING *`, [id, tool.id, owner, hashOf(token), token.slice(-4), JSON.stringify(input), at]);
            return present(row, { url: `${baseUrl}/hooks/${token}` });
        }
        if (body.kind !== 'schedule') throw new TriggerError(422, 'tools.trigger.invalid', 'kind is link or schedule');
        const every = body.every === 'hour' ? 60 : body.every === 'day' ? 1440 : null;
        if (!every) throw new TriggerError(422, 'tools.trigger.invalid', 'every is hour or day');
        const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(body.at || '00:00'));
        if (!m) throw new TriggerError(422, 'tools.trigger.invalid', 'at is a time, HH:MM (UTC)');
        const atMinute = every === 60 ? Number(m[2]) : Number(m[1]) * 60 + Number(m[2]);
        const row = await db.one(`INSERT INTO made_tool_triggers (id, tool_id, owner_subject, kind, every_minutes, at_minute, input, next_run_at, created_at, updated_at)
            VALUES ($1, $2, $3, 'schedule', $4, $5, $6::jsonb, $7, $8, $8) RETURNING *`, [id, tool.id, owner, every, atMinute, JSON.stringify(input), new Date(nextRun(every, atMinute, now())), at]);
        return present(row);
    }

    async function list(toolId, owner) {
        return (await db.many('SELECT * FROM made_tool_triggers WHERE tool_id = $1 AND owner_subject = $2 ORDER BY created_at', [toolId, owner])).map((r) => present(r));
    }

    async function setEnabled(id, owner, enabled) {
        if (!ID_RE.test(String(id || ''))) return null;
        const row = await db.maybe('SELECT * FROM made_tool_triggers WHERE id = $1 AND owner_subject = $2', [id, owner]);
        if (!row) return null;
        // A schedule turned back on counts from now: it never makes up the runs it missed.
        const next = row.kind === 'schedule' && enabled ? new Date(nextRun(row.every_minutes, row.at_minute, now())) : row.next_run_at;
        return present(await db.one('UPDATE made_tool_triggers SET enabled = $3, next_run_at = $4, updated_at = $5 WHERE id = $1 AND owner_subject = $2 RETURNING *', [id, owner, !!enabled, next, new Date(now())]));
    }

    async function remove(id, owner) {
        if (!ID_RE.test(String(id || ''))) return false;
        return (await db.exec('DELETE FROM made_tool_triggers WHERE id = $1 AND owner_subject = $2', [id, owner])) > 0;
    }

    async function byToken(token) {
        if (!TOKEN_RE.test(String(token || ''))) return null;
        return db.maybe('SELECT * FROM made_tool_triggers WHERE token_hash = $1', [hashOf(token)]);
    }

    /**
     * Claims up to `limit` due schedules: each is moved to its next time with a check on the time it had, so two
     * processes never run one twice. A missed hour or day is not made up: the next time counts from now.
     */
    async function claimDue(limit = 5) {
        const t = now();
        const due = await db.many(`SELECT * FROM made_tool_triggers WHERE kind = 'schedule' AND enabled AND next_run_at <= $1 ORDER BY next_run_at LIMIT $2`, [new Date(t), limit]);
        const won = [];
        for (const row of due) {
            const n = await db.exec('UPDATE made_tool_triggers SET next_run_at = $3 WHERE id = $1 AND next_run_at = $2', [row.id, row.next_run_at, new Date(nextRun(row.every_minutes, row.at_minute, t))]);
            if (n > 0) won.push(row);
        }
        return won;
    }

    /** What a run answered, kept short, and one more run counted. */
    async function record(id, out) {
        let result = out.state === 'succeeded' ? out.result || null : { error: (out.error && (out.error.detail || out.error.title)) || 'The run failed' };
        let text = JSON.stringify(result);
        if (text && text.length > RESULT_CHARS) result = { text: `${text.slice(0, RESULT_CHARS)}…`, clipped: true };
        await db.exec('UPDATE made_tool_triggers SET last_run_at = $2, last_state = $3, last_result = $4::jsonb, runs = runs + 1 WHERE id = $1',
            [id, new Date(now()), out.state === 'succeeded' ? 'succeeded' : 'failed', result == null ? null : JSON.stringify(result)]);
    }

    // A link answers at most LINK_PER_MINUTE runs a minute (each costs its owner).
    const windows = new Map();
    function allowLink(id) {
        const t = now();
        for (const [k, w] of windows) if (w.until <= t) windows.delete(k);
        const w = windows.get(id) || { until: t + 60_000, n: 0 };
        if (w.n >= LINK_PER_MINUTE) return false;
        w.n++;
        windows.set(id, w);
        return true;
    }

    /** The scheduler: every `everyMs`, the due schedules run (run(row) → tools.run@1), one at a time. */
    function start({ run, everyMs = 30_000, log = console } = {}) {
        let busy = false;
        const tick = async () => {
            if (busy) return;
            busy = true;
            try {
                for (const row of await claimDue(5)) {
                    let out;
                    try { out = await run(row); } catch (err) { out = { state: 'failed', error: { detail: (err && err.message) || 'The run failed' } }; }
                    await record(row.id, out).catch(() => {});
                }
            } catch (err) {
                log.error(`[made-triggers] ${(err && err.message) || err}`);
            } finally { busy = false; }
        };
        const timer = setInterval(tick, everyMs);
        if (timer.unref) timer.unref();
        return { stop: () => clearInterval(timer), tick };
    }

    return { create, list, setEnabled, remove, byToken, claimDue, record, allowLink, start, present };
}

module.exports = { createTriggers, nextRun, describe, refusal, TriggerError, hashOf };
