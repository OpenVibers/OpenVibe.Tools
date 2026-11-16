'use strict';
// ═══════════════════════════════════════════════════════════════
// POST /api/v1/tools/batch: several tool runs at once (the owner, 11-15: the agentic system "should be able to do
// shit in parallel eg search multiple specific sites or runs tools"). An agent sends up to 16 calls and gets every
// answer back together, the slowest call setting the time instead of their sum.
//
//   Body:    { calls: [{ tool, input, files?, wait_ms? }, …1..16], concurrency?: 1..8 (default 6) }
//   Answer:  200 { results: [{ tool, status, body }, …in the calls' order], took_ms }
//            each body is exactly what POST /api/v1/tools/:id/run answers for that call (tools.run@1, or the
//            problem+json of its refusal), each status its HTTP status.
//
// Every call goes through the run API itself, over loopback, with the caller's own credentials and address: the
// same authorization, capability, quotas (each call counts), idempotency, file checks and per-target throttles as
// one run. Nothing is cached or skipped here. A batch needs a signed-in caller or a token (an agent's): an anonymous
// caller runs tools one at a time, so the batch is never a way to multiply anonymous runs.
// ═══════════════════════════════════════════════════════════════

const TOOL_ID = /^[a-z0-9][a-z0-9.-]{0,63}$|^mtl_[0-9A-HJKMNP-TV-Z]{26}$/;  // a catalogue tool or one people made (11-15)
const MAX_CALLS = 16;
const MAX_CONCURRENCY = 8;

function problem(res, status, code, detail) {
    res.status(status).type('application/problem+json').json({ type: `https://openvibe.tools/problems/${code}`, title: detail, status, code, detail });
}

/**
 * createBatch({ address: () => server.address(), fetchImpl }) → { handle(req, res) }. address() is the gateway's own
 * listening socket (a port on loopback, or the socket systemd handed over).
 */
function createBatch({ address, fetchImpl = globalThis.fetch } = {}) {
    function origin() {
        const a = typeof address === 'function' ? address() : null;
        if (!a || typeof a !== 'object' || !a.port) return null;
        const host = !a.address || a.address === '::' || a.address === '0.0.0.0' ? '127.0.0.1' : a.address.includes(':') ? `[${a.address}]` : a.address;
        return `http://${host}:${a.port}`;
    }

    async function handle(req, res) {
        const t0 = Date.now();
        const auth = req.headers.authorization;
        const cookie = req.headers.cookie;
        if (!auth && !cookie) return problem(res, 401, 'token.missing', 'A batch of runs needs a sign-in or a token: run tools one at a time without one');
        const b = req.body && typeof req.body === 'object' ? req.body : null;
        const calls = b && Array.isArray(b.calls) ? b.calls : null;
        if (!calls || !calls.length || calls.length > MAX_CALLS) return problem(res, 400, 'tools.batch.invalid', `calls is a list of 1 to ${MAX_CALLS} runs`);
        for (const [i, c] of calls.entries()) {
            if (!c || typeof c !== 'object' || !TOOL_ID.test(String(c.tool || ''))) return problem(res, 400, 'tools.batch.invalid', `calls[${i}].tool is a tool id`);
            if (c.wait_ms !== undefined && !(Number.isInteger(c.wait_ms) && c.wait_ms >= 0 && c.wait_ms <= 60000)) return problem(res, 400, 'tools.batch.invalid', `calls[${i}].wait_ms is 0 to 60000`);
        }
        const width = Math.max(1, Math.min(MAX_CONCURRENCY, Number.isInteger(b.concurrency) ? b.concurrency : 6));
        const base = origin();
        if (!base) return problem(res, 503, 'tools.unavailable', 'The batch cannot reach the run API right now');
        const headers = { 'Content-Type': 'application/json', Accept: 'application/json',
            ...(auth ? { Authorization: auth } : {}), ...(cookie ? { Cookie: cookie } : {}),
            ...(req.headers.origin ? { Origin: req.headers.origin } : {}),
            ...(req.headers['user-agent'] ? { 'User-Agent': String(req.headers['user-agent']).slice(0, 300) } : {}),
            // The caller's own address (the one trust proxy resolved), so per-address limits count them, not us.
            'X-Forwarded-For': req.ip || '' };
        const results = new Array(calls.length);
        let next = 0;
        const one = async (i) => {
            const c = calls[i];
            const body = { input: c.input === undefined ? {} : c.input, ...(c.files !== undefined ? { files: c.files } : {}), ...(c.wait_ms !== undefined ? { wait_ms: c.wait_ms } : {}) };
            try {
                const r = await fetchImpl(`${base}/api/v1/tools/${encodeURIComponent(c.tool)}/run`, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(90_000) });
                const text = await r.text();
                let parsed = null;
                try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { detail: text.slice(0, 500) }; }
                results[i] = { tool: c.tool, status: r.status, body: parsed };
            } catch (err) {
                results[i] = { tool: c.tool, status: 504, body: { code: 'tools.batch.call_failed', detail: String((err && err.message) || err).slice(0, 300) } };
            }
        };
        await Promise.all(Array.from({ length: Math.min(width, calls.length) }, async () => {
            for (let i = next++; i < calls.length; i = next++) await one(i);
        }));
        res.set('Cache-Control', 'no-store');
        return res.json({ results, took_ms: Date.now() - t0 });
    }
    return { handle, MAX_CALLS, MAX_CONCURRENCY };
}

module.exports = { createBatch, MAX_CALLS, MAX_CONCURRENCY };
