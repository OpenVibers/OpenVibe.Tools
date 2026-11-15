'use strict';
// ═══════════════════════════════════════════════════════════════
// POST /mcp on openvibe.tools: every tool to any agent (plan 2026-11-13 §AD.12 (a); the owner, 11-15: "all fully
// interconnected"). The MCP Streamable HTTP transport, one JSON-RPC call per request, protocol 2025-06-18 (2025-11-25
// and 2025-03-26 echoed when the client speaks them):
//
//   initialize, notifications/initialized, ping
//   tools/list   find_tools, run_tool and run_tools (the whole catalogue, the public tools people made, and the
//                caller's own, without putting 200 schemas in an agent's context), make_tool (a new tool of the
//                caller's own from a description: drafted by a model and saved private, §AD.12), then the caller's own
//                made tools by name (made_<slug>)
//   tools/call   one of those
//
// Who: anyone (the anonymous tools run for anyone, as on their pages), or a person's Bearer token for openvibe.tools
// (their own tools, the tools that need a sign-in, and the made tools, paid from their allowance). Every run goes
// through the run API itself over loopback with the caller's own credentials and address, so every rule of one run
// (authorization, quotas, throttles, files) applies; nothing is cached or skipped here.
// ═══════════════════════════════════════════════════════════════

const PROTOCOL = '2025-06-18';
const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26'];
const SERVER = { name: 'openvibe-tools', title: 'OpenVibe Tools', version: '1.0' };
const RPC = { parse: -32700, invalid: -32600, method: -32601, params: -32602, internal: -32603 };
const MADE_ID = /^mtl_[0-9A-HJKMNP-TV-Z]{26}$/;
const TOOL_ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const MAX_CALLS = 8;

const META = [
    {
        name: 'find_tools',
        description: 'Find OpenVibe tools for a need (for example "dns lookup", "merge pdf", "qr code", "summarize an email"): the catalogue of 180+ tools and the tools people made. Returns each tool id with its summary and its input schema, ready for run_tool.',
        inputSchema: { type: 'object', properties: { need: { type: 'string', minLength: 1, maxLength: 200, description: 'What the tool should do, in a few words' }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['need'], additionalProperties: false },
        annotations: { title: 'Find tools', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
        name: 'run_tool',
        description: 'Run one OpenVibe tool by its id (from find_tools) with its input object. A tool people made (an mtl_ id) runs as you and is paid from your own allowance.',
        inputSchema: { type: 'object', properties: { tool: { type: 'string', description: 'The tool id' }, input: { type: 'object', description: 'The tool\'s input, as its schema says' } }, required: ['tool'], additionalProperties: false },
        annotations: { title: 'Run a tool', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    {
        name: 'run_tools',
        description: `Run several OpenVibe tools at once (at most ${MAX_CALLS}), in parallel: the same ids and inputs run_tool takes. Use it when the calls do not depend on each other (the DNS, the certificate and the headers of one site; one lookup for several domains). Each answer comes back under its call.`,
        inputSchema: { type: 'object', properties: { calls: { type: 'array', minItems: 1, maxItems: MAX_CALLS, items: { type: 'object', properties: { tool: { type: 'string' }, input: { type: 'object' } }, required: ['tool'] } } }, required: ['calls'], additionalProperties: false },
        annotations: { title: 'Run tools in parallel', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    {
        name: 'make_tool',
        description: 'Make a new tool of your own from a description, when find_tools has nothing that fits ("turn meeting notes into decisions and action items", "add sales tax to a price"). A model drafts it, as instructions for a model (kind prompt, the default) or as plain JavaScript that computes the answer without a network (kind code), and it is saved as your own private tool: run it with run_tool and its id. Drafting is paid from your allowance. Change it or publish it on openvibe.tools/make.',
        inputSchema: { type: 'object', properties: { description: { type: 'string', minLength: 8, maxLength: 2000, description: 'What the tool should do, in a sentence or two' }, kind: { enum: ['prompt', 'code'], description: 'prompt: a model does the work (default). code: JavaScript computes the answer (math, formats, conversions)' } }, required: ['description'], additionalProperties: false },
        annotations: { title: 'Make a tool', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
];

// The words of a need that say something: not a, the, for, my, … (they match every tool).
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'what', 'how', 'can', 'you', 'your', 'my', 'me', 'some', 'any', 'tool', 'tools', 'make', 'get', 'use']);
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => (w.length >= 3 || /^[a-z]{2}$/.test(w) && ['qr', 'ip', 'mx', 'ai', 'id'].includes(w)) && !STOP.has(w));

/**
 * createToolsMcp({ address, snapshot, store, verify, extractToken, fetchImpl })
 *   address(): the gateway's own listening socket; snapshot(): the tool registry (descriptors with their schemas);
 *   store: the made tools (made/store.js); verify(token) → claims | null (Network user tokens for openvibe.tools).
 */
function createToolsMcp({ address, snapshot, store, verify, extractToken, fetchImpl = globalThis.fetch } = {}) {
    function origin() {
        const a = typeof address === 'function' ? address() : null;
        if (!a || typeof a !== 'object' || !a.port) return null;
        const host = !a.address || a.address === '::' || a.address === '0.0.0.0' ? '127.0.0.1' : a.address.includes(':') ? `[${a.address}]` : a.address;
        return `http://${host}:${a.port}`;
    }

    async function who(req) {
        const token = extractToken(req);
        if (!token) return null;
        const claims = await Promise.resolve(verify(token)).catch(() => null);
        const sub = claims && (claims.sub || claims.subject);
        return /^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(sub || '')) ? { sub, token } : null;
    }

    const catalogue = () => {
        const s = snapshot();
        return (s && Array.isArray(s.tools) ? s.tools : []).filter((d) => d && d.api && d.run);
    };
    const inputOf = (d) => (d.input && typeof d.input === 'object' && !d.input.$ref ? d.input : { type: 'object' });
    const madeName = (t) => `made_${String(t.slug).replace(/-/g, '_')}`.slice(0, 64);

    /** The catalogue and the made tools that fit a need, best first. */
    async function find(need, limit, person) {
        const q = words(need);
        const scored = [];
        for (const d of catalogue()) {
            const hay = `${d.id} ${d.name} ${d.summary} ${(d.keywords || []).join(' ')}`.toLowerCase();
            let score = 0;
            for (const w of q) if (hay.includes(w)) score += (String(d.id) === w ? 5 : 0) + (String(d.name).toLowerCase().includes(w) ? 2 : 1);
            if (score) scored.push({ score, tool: { tool: d.id, name: d.name, summary: d.summary, input: inputOf(d), needs_sign_in: !(d.auth && d.auth.anonymous) } });
        }
        if (store) {
            const made = [...await store.listPublic({ q: need, limit: 20 }).catch(() => []), ...(person ? await store.listMine(person.sub).catch(() => []) : [])];
            const seen = new Set();
            for (const row of made) {
                if (seen.has(row.id)) continue;
                seen.add(row.id);
                const hay = `${row.name} ${row.summary} ${row.slug}`.toLowerCase();
                const score = q.reduce((n, w) => n + (hay.includes(w) ? 2 : 0), 0) + (person && row.owner_subject === person.sub ? 1 : 0);
                if (score) {
                    const t = store.present(row);
                    scored.push({ score, tool: { tool: t.id, name: t.name, summary: t.summary, input: t.input, made: true, yours: !!(person && row.owner_subject === person.sub), needs_sign_in: true } });
                }
            }
        }
        return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.tool);
    }

    /** The caller's credentials and address, for a call through the gateway's own API. */
    function callerHeaders(req) {
        const headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Forwarded-For': req.ip || '' };
        if (req.headers.authorization) headers.Authorization = req.headers.authorization;
        else { const t = extractToken(req); if (t) headers.Authorization = `Bearer ${t}`; }
        return headers;
    }
    const refusal = (body, status, fallback) => String((body && (body.detail || body.title || body.error)) || `${fallback} (${status})`).slice(0, 500);

    /** make_tool: draft a tool from the caller's words (POST /api/v1/made-tools/draft) and save the draft's body as their
     *  own private tool (POST /api/v1/made-tools), both as the caller; a slug they already use gets a short suffix. */
    async function makeOne(req, args) {
        const base = origin();
        if (!base) return { ok: false, text: 'The tools cannot be reached right now' };
        const description = String((args && args.description) || '').trim().slice(0, 2000);
        if (description.length < 8) return { ok: false, text: 'Say in a sentence or two what the tool should do' };
        const kind = args && args.kind === 'code' ? 'code' : 'prompt';
        const post = async (path, body, ms) => {
            const res = await fetchImpl(base + path, { method: 'POST', headers: callerHeaders(req), body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(ms) });
            return { status: res.status, body: await res.json().catch(() => null) };
        };
        try {
            const d = await post('/api/v1/made-tools/draft', { description, kind }, 120_000);
            if (d.status === 401) return { ok: false, text: 'Sign in (a Bearer token for openvibe.tools) to make a tool of your own' };
            if (d.status !== 200 || !d.body || !d.body.body) return { ok: false, text: refusal(d.body, d.status, 'The tool could not be drafted') };
            let body = { ...d.body.body, visibility: 'private' };
            for (let tries = 0; tries < 3; tries++) {
                const m = await post('/api/v1/made-tools', body, 30_000);
                if (m.status === 201 && m.body) {
                    const t = m.body;
                    return { ok: true, text: JSON.stringify({ made: { id: t.id, name: t.name, summary: t.summary, kind: t.kind, visibility: t.visibility, input: t.input, output: t.output },
                        run: `run_tool with tool "${t.id}"`, page: `https://openvibe.tools/make#${t.id}`, note: 'Your own private tool. Change it or publish it on its page.' }) };
                }
                if (m.status !== 409) return { ok: false, text: refusal(m.body, m.status, 'The tool was not saved') };
                body = { ...body, slug: `${String(body.slug).slice(0, 34)}-${Math.random().toString(36).slice(2, 6)}` };
            }
            return { ok: false, text: 'The tool was not saved: its name is taken. Try other words.' };
        } catch { return { ok: false, text: 'Making the tool took too long. Try again.' }; }
    }

    /** One run through the gateway's own run API, with the caller's credentials and address. */
    async function runOne(req, tool, input) {
        const base = origin();
        if (!base) return { ok: false, text: 'The tools cannot be reached right now' };
        const id = String(tool || '');
        const made = MADE_ID.test(id);
        if (!made && !TOOL_ID.test(id)) return { ok: false, text: `No tool is called ${id.slice(0, 64)}: use find_tools` };
        const path = made ? `/api/v1/made-tools/${id}/run` : `/api/v1/tools/${encodeURIComponent(id)}/run`;
        const headers = callerHeaders(req);
        let res, body;
        try {
            res = await fetchImpl(base + path, { method: 'POST', headers, body: JSON.stringify(made ? { input: input || {} } : { input: input || {}, wait_ms: 30000 }), redirect: 'error', signal: AbortSignal.timeout(90_000) });
            body = await res.json().catch(() => null);
        } catch { return { ok: false, text: 'The tool did not answer in time' }; }
        if (!res.ok) return { ok: false, text: String((body && (body.detail || body.title || body.error)) || `The run was refused (${res.status})`).slice(0, 500) };
        if (body && body.state === 'succeeded') {
            const r = body.result || {};
            return { ok: true, text: r.text != null ? String(r.text) : JSON.stringify(r.data !== undefined ? r.data : r.files || r) };
        }
        if (body && (body.state === 'queued' || body.state === 'running')) return { ok: true, text: JSON.stringify({ state: body.state, job: body.job, location: body.location, note: 'Still running: GET the location for its result.' }) };
        const e = (body && body.error) || {};
        return { ok: false, text: String(e.detail || e.title || 'The tool failed').slice(0, 500) };
    }

    const result = (r) => ({ content: [{ type: 'text', text: r.text }], ...(r.ok ? {} : { isError: true }) });

    async function handle(req, res) {
        res.set({ 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
        const msg = req.body;
        if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
            return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: RPC.invalid, message: 'One JSON-RPC 2.0 request per POST' } });
        }
        const id = msg.id === undefined ? null : msg.id;
        const ok = (out) => res.json({ jsonrpc: '2.0', id, result: out });
        const fail = (code, message) => res.json({ jsonrpc: '2.0', id, error: { code, message } });
        if (msg.id === undefined) return res.status(202).end();   // a notification: no answer
        try {
            const p = msg.params && typeof msg.params === 'object' ? msg.params : {};
            switch (msg.method) {
            case 'initialize': {
                const asked = String(p.protocolVersion || '');
                return ok({ protocolVersion: SUPPORTED.includes(asked) ? asked : PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER,
                    instructions: 'OpenVibe Tools: 180+ tools (network, developer, text, image, PDF, audio, video) and the tools people made. Use find_tools to find one for a need, then run_tool (or run_tools for several at once); when nothing fits, make_tool makes one of your own from a description. Sign in (a Bearer token for openvibe.tools) to run your own tools and the ones people made, and to make tools; their runs are paid from your own allowance.' });
            }
            case 'ping': return ok({});
            case 'tools/list': {
                const person = await who(req);
                const mine = person && store ? await store.listMine(person.sub).catch(() => []) : [];
                const own = mine.map((row) => store.present(row)).map((t) => ({
                    name: madeName(t), title: t.name, description: `${t.summary} (your tool, ${t.kind}; runs as you)`,
                    inputSchema: t.input, annotations: { title: t.name, readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: t.kind === 'prompt' },
                }));
                return ok({ tools: [...META, ...own] });
            }
            case 'tools/call': {
                const name = String(p.name || '');
                const args = p.arguments && typeof p.arguments === 'object' ? p.arguments : {};
                if (name === 'find_tools') {
                    const need = String(args.need || '').trim().slice(0, 200);
                    if (!need) return fail(RPC.params, 'find_tools needs { need }');
                    const found = await find(need, Math.max(1, Math.min(20, Number(args.limit) || 8)), await who(req));
                    return ok({ content: [{ type: 'text', text: JSON.stringify(found.length ? found : { none: `No tool fits "${need}" yet. People can make one at https://openvibe.tools/make` }) }] });
                }
                if (name === 'run_tool') return ok(result(await runOne(req, args.tool, args.input)));
                if (name === 'make_tool') return ok(result(await makeOne(req, args)));
                if (name === 'run_tools') {
                    const calls = Array.isArray(args.calls) ? args.calls.slice(0, MAX_CALLS) : [];
                    if (!calls.length) return fail(RPC.params, `run_tools needs { calls: [1..${MAX_CALLS}] }`);
                    const outs = await Promise.all(calls.map((c) => runOne(req, c && c.tool, c && c.input)));
                    return ok({ content: [{ type: 'text', text: JSON.stringify(outs.map((o, i) => ({ tool: calls[i] && calls[i].tool, ok: o.ok, result: o.text }))) }], ...(outs.every((o) => !o.ok) ? { isError: true } : {}) });
                }
                if (name.startsWith('made_')) {
                    const person = await who(req);
                    if (!person || !store) return ok(result({ ok: false, text: 'Sign in to run your own tools' }));
                    const row = (await store.listMine(person.sub)).find((r) => madeName(store.present(r)) === name);
                    if (!row) return ok(result({ ok: false, text: `You have no tool called ${name}` }));
                    return ok(result(await runOne(req, row.id, args)));
                }
                return fail(RPC.params, `No tool is called ${name.slice(0, 64)}`);
            }
            default: return fail(RPC.method, `This server does not answer ${msg.method.slice(0, 64)}`);
            }
        } catch (err) {
            return fail(RPC.internal, 'The tools server failed on that call');
        }
    }

    return { handle, find, META };
}

module.exports = { createToolsMcp, META };
