'use strict';
// ═══════════════════════════════════════════════════════════════
// POST /mcp on openvibe.tools: every tool to any agent (plan 2026-11-13 §AD.12 (a); the owner, 11-15: "all fully
// interconnected"). The MCP Streamable HTTP transport, one JSON-RPC call per request, protocol 2025-06-18 (2025-11-25
// and 2025-03-26 echoed when the client speaks them):
//
//   initialize, notifications/initialized, ping
//   tools/list   find_tools, run_tool and run_tools (the whole catalogue, the public tools people made, and the
//                caller's own, without putting 200 schemas in an agent's context), make_tool (a new tool of the
//                caller's own from a description: drafted by a model and saved private, §AD.12), bring_tool,
//                automate_tool and my_automations (any tool on a schedule or from a private link, as the caller: one
//                tool system, 11-15), run_code (a script that calls tools and returns only what it needs: code mode,
//                plan §AD.26, openvibe-sdk/code-mode), then the caller's own made tools by name (made_<slug>)
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
const INSTRUCTIONS = 'OpenVibe Tools: 180+ tools (network, developer, text, image, PDF, audio, video) and the tools people made. Use find_tools to find one for a need, then run_tool (or run_tools for several at once); when nothing fits, make_tool makes one of your own from a description, and bring_tool brings one from Val Town or Pipedream. Sign in (a Bearer token for openvibe.tools) to run your own tools and the ones people made, and to make tools; their runs are paid from your own allowance.';
// MCP 2026-07-28 (stateless: the version and the method on every request, server/discover) beside the handshake era.
const mcpKit = require('openvibe-sdk/mcp');
// Code mode (plan §AD.26; the owner, 11-17, sending Cloudflare's Code Mode): a script over the tools, in the SDK's sandbox.
const codeMode = require('openvibe-sdk/code-mode');
const SCRIPTS_AT_ONCE = 4;   // a script is a process: this many at once on the gateway, one a person
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
    {
        name: 'bring_tool',
        description: 'Bring a function from Val Town (a val\'s address, e.g. https://www.val.town/v/you/name, or its code) or a Pipedream Node.js code step (its code) and save it as your own private code tool: TypeScript, the vals it imports, and how it was called (a script\'s parameters, an http val\'s request, a step\'s props) are converted. Run it with run_tool and its id. Packages it imports cannot come along (the answer says which).',
        inputSchema: { type: 'object', properties: {
            from: { enum: ['valtown', 'pipedream'], description: 'Where the code comes from' },
            url: { type: 'string', maxLength: 300, description: 'Val Town: the val\'s address' },
            code: { type: 'string', maxLength: 65536, description: 'The code itself (a val\'s, when it has no public address; a Pipedream step\'s, always)' },
            name: { type: 'string', maxLength: 64, description: 'A name, for pasted code' },
        }, required: ['from'], additionalProperties: false },
        annotations: { title: 'Bring a tool from Val Town or Pipedream', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    {
        name: 'automate_tool',
        description: 'Run a tool on its own, as you: every hour or every day at a time (UTC), or from a private link (a webhook URL that runs it whenever something calls it: GitHub, a form, a shop, a shortcut). Any catalogue tool that runs without a sign-in, or one of your own made tools. The input you give is sent every time; the caller of a link adds theirs on top. A schedule tells you what it answered unless notify is false. The URL of a link is shown once.',
        inputSchema: { type: 'object', properties: {
            tool: { type: 'string', description: 'The tool id (from find_tools), or the mtl_ id of a tool you made' },
            kind: { enum: ['schedule', 'link'], description: 'schedule: every hour or day; link: a private URL that runs it' },
            every: { enum: ['hour', 'day'], description: 'For a schedule' },
            at: { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$', description: 'For a schedule: HH:MM in UTC (every hour uses the minutes)' },
            input: { type: 'object', description: 'The input sent every time, as the schema of the tool says' },
            notify: { type: 'boolean', description: 'For a schedule: tell you what it answered (default true)' },
        }, required: ['tool', 'kind'], additionalProperties: false },
        annotations: { title: 'Automate a tool', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    {
        name: 'my_automations',
        description: 'List every schedule and private link you have, on any tool: what it runs, when it runs next, its last answer and how many times it ran. Change or delete them on openvibe.tools/make.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { title: 'Your automations', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
        name: 'run_code',
        description: 'Run JavaScript that calls OpenVibe tools and returns only what you need (code mode): `const d = await run("dns-lookup", { domain: "x.com" }); const c = await run("ssl-check", { host: "x.com" }); return { mx: d, expires: c };`. run(id, input) runs one tool (ids from find_tools) as you and answers its result, parsed when it is JSON; find(need) answers find_tools\' list. Chain, loop, filter and join in one step instead of many calls; console.log lines come back too. Only the returned value (8 KB at most) reaches you, so return the facts, not whole pages. No network, files or require: only run and find. 30 seconds and 30 calls a script; needs a sign-in.',
        inputSchema: { type: 'object', properties: { code: { type: 'string', minLength: 1, maxLength: 20000, description: 'the body of an async function: use await, and return the value you need' } }, required: ['code'], additionalProperties: false },
        annotations: { title: 'Run code over tools', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
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
function createToolsMcp({ address, snapshot, store, verify, extractToken, fetchImpl = globalThis.fetch, runCode = codeMode.runCode } = {}) {
    // The scripts running now: at most SCRIPTS_AT_ONCE on the gateway, one a person.
    const running = new Set();
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

    /** bring_tool: convert a val or a Pipedream step (POST /api/v1/made-tools/import/…) and save it as the caller's own
     *  private tool, the way make_tool saves a draft. */
    async function bringOne(req, args) {
        const base = origin();
        if (!base) return { ok: false, text: 'The tools cannot be reached right now' };
        const a = args || {};
        const fromPd = a.from === 'pipedream';
        const body = fromPd ? { code: String(a.code || ''), name: a.name } : (a.code ? { code: String(a.code), name: a.name } : { url: String(a.url || '') });
        if (fromPd ? !body.code.trim() : !(body.url || body.code)) return { ok: false, text: fromPd ? 'Give the Pipedream step\'s code' : 'Give the val\'s address on Val Town, or its code' };
        const post = async (path, b, ms) => {
            const res = await fetchImpl(base + path, { method: 'POST', headers: callerHeaders(req), body: JSON.stringify(b), redirect: 'error', signal: AbortSignal.timeout(ms) });
            return { status: res.status, body: await res.json().catch(() => null) };
        };
        try {
            const d = await post(fromPd ? '/api/v1/made-tools/import/pipedream' : '/api/v1/made-tools/import/val', body, 60_000);
            if (d.status === 401) return { ok: false, text: 'Sign in (a Bearer token for openvibe.tools) to bring a tool of your own' };
            if (d.status !== 200 || !d.body || !d.body.body) return { ok: false, text: refusal(d.body, d.status, 'It could not be brought') };
            let tool = { ...d.body.body, visibility: 'private' };
            for (let tries = 0; tries < 3; tries++) {
                const m = await post('/api/v1/made-tools', tool, 30_000);
                if (m.status === 201 && m.body) {
                    const t = m.body;
                    return { ok: true, text: JSON.stringify({ made: { id: t.id, name: t.name, summary: t.summary, kind: t.kind, net: t.net, visibility: t.visibility, input: t.input, output: t.output },
                        notes: d.body.notes || [], run: `run_tool with tool "${t.id}"`, page: `https://openvibe.tools/make#${t.id}`, note: 'Your own private tool. Change it or publish it on its page.' }) };
                }
                if (m.status !== 409) return { ok: false, text: refusal(m.body, m.status, 'The tool was not saved') };
                tool = { ...tool, slug: `${String(tool.slug).slice(0, 34)}-${Math.random().toString(36).slice(2, 6)}` };
            }
            return { ok: false, text: 'The tool was not saved: its name is taken. Give it another name.' };
        } catch { return { ok: false, text: 'Bringing the tool took too long. Try again.' }; }
    }

    /** automate_tool: a schedule or a private link on any tool (POST /api/v1/tools/:id/triggers), as the caller. */
    async function automateOne(req, args) {
        const base = origin();
        if (!base) return { ok: false, text: 'The tools cannot be reached right now' };
        const a = args || {};
        const id = String(a.tool || '');
        if (!MADE_ID.test(id) && !TOOL_ID.test(id)) return { ok: false, text: `No tool is called ${id.slice(0, 64)}: use find_tools` };
        const body = a.kind === 'link' ? { kind: 'link', input: a.input || {} }
            : { kind: 'schedule', every: a.every || 'day', at: a.at || '09:00', input: a.input || {}, ...(a.notify === false ? { notify: false } : {}) };
        try {
            const res = await fetchImpl(`${base}/api/v1/tools/${encodeURIComponent(id)}/triggers`, { method: 'POST', headers: callerHeaders(req), body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15_000) });
            const out = await res.json().catch(() => null);
            if (res.status === 401) return { ok: false, text: 'Sign in (a Bearer token for openvibe.tools) to automate a tool' };
            if (res.status !== 201 || !out) return { ok: false, text: refusal(out, res.status, 'It was not set up') };
            const page = `https://openvibe.tools/make#${MADE_ID.test(id) ? id : `automate=${id}`}`;
            return { ok: true, text: JSON.stringify({ automation: { id: out.id, tool: out.tool, says: out.says, next_run_at: out.next_run_at, notify: out.notify, input: out.input },
                ...(out.url ? { url: out.url, note: 'The link is shown once: keep it. POST JSON (or GET with a query) to run the tool.' } : {}), page }) };
        } catch { return { ok: false, text: 'Setting it up took too long. Try again.' }; }
    }

    /** my_automations: every trigger the caller has (GET /api/v1/me/triggers). */
    async function automations(req) {
        const base = origin();
        if (!base) return { ok: false, text: 'The tools cannot be reached right now' };
        try {
            const h = callerHeaders(req);
            delete h['Content-Type'];
            const res = await fetchImpl(`${base}/api/v1/me/triggers`, { headers: h, redirect: 'error', signal: AbortSignal.timeout(15_000) });
            const out = await res.json().catch(() => null);
            if (res.status === 401) return { ok: false, text: 'Sign in (a Bearer token for openvibe.tools) to see your automations' };
            if (!res.ok || !out) return { ok: false, text: refusal(out, res.status, 'They could not be read') };
            return { ok: true, text: JSON.stringify({ automations: (out.triggers || []).map((t) => ({ id: t.id, tool: t.tool, tool_name: t.tool_name, kind: t.kind, says: t.says, enabled: t.enabled,
                next_run_at: t.next_run_at, last_run_at: t.last_run_at, last_state: t.last_state, runs: t.runs, page: t.page })), count: out.count || 0 }) };
        } catch { return { ok: false, text: 'Reading them took too long. Try again.' }; }
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
        // A 2026-07-28 request: headers checked against the body; every result complete; the tool list (yours too:
        // private) kept a minute; an unknown method a 404.
        const modern = !!mcpKit.requestVersion(msg.params);
        const ok = (out) => res.json({ jsonrpc: '2.0', id, result: !modern ? out
            : msg.method === 'tools/list' ? mcpKit.listResult('tools', out.tools, { cacheScope: 'private', ttlMs: 60000 }) : mcpKit.complete(out) });
        const fail = (code, message) => res.json({ jsonrpc: '2.0', id, error: { code, message } });
        if (msg.id === undefined) return res.status(202).end();   // a notification: no answer
        if (modern) {
            const bad = mcpKit.checkRequest({ header: (n) => req.get(n), method: msg.method, params: msg.params });
            if (bad) return res.status(bad.status).json({ jsonrpc: '2.0', id, error: bad.error });
            if (msg.method === 'server/discover') {
                return res.json({ jsonrpc: '2.0', id, result: mcpKit.discoverResult({ serverInfo: SERVER, capabilities: { tools: {} }, instructions: INSTRUCTIONS, versions: [...mcpKit.MODERN_VERSIONS, ...SUPPORTED] }) });
            }
            if (msg.method !== 'tools/list' && msg.method !== 'tools/call') {
                const nf = mcpKit.methodNotFound(msg.method);
                return res.status(nf.status).json({ jsonrpc: '2.0', id, error: nf.error });
            }
        }
        try {
            const p = msg.params && typeof msg.params === 'object' ? msg.params : {};
            switch (msg.method) {
            case 'initialize': {
                const asked = String(p.protocolVersion || '');
                return ok({ protocolVersion: SUPPORTED.includes(asked) ? asked : PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER,
                    instructions: INSTRUCTIONS });
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
                if (name === 'run_code') {
                    const code = typeof args.code === 'string' ? args.code : '';
                    if (!code.trim() || code.length > 20000) return fail(RPC.params, 'run_code needs { code } (at most 20,000 characters)');
                    const person = await who(req);
                    if (!person) return ok(result({ ok: false, text: 'Sign in to run code over the tools (a Bearer token for openvibe.tools)' }));
                    if (running.has(person.sub)) return ok(result({ ok: false, text: 'One script at a time: your last one is still running' }));
                    if (running.size >= SCRIPTS_AT_ONCE) return ok(result({ ok: false, text: 'The tools are busy running other scripts: try again in a moment' }));
                    running.add(person.sub);
                    try {
                        const out = await runCode(code, { functions: ['run', 'find'], call: async (kind, fn, a) => {
                            if (fn === 'run') {
                                const r = await runOne(req, a[0], a[1] && typeof a[1] === 'object' ? a[1] : {});
                                if (!r.ok) return { ok: false, error: r.text };
                                let value = r.text;
                                try { value = JSON.parse(r.text); } catch { /* words */ }
                                return { ok: true, value };
                            }
                            if (fn === 'find') return { ok: true, value: await find(String(a[0] || '').trim().slice(0, 200), Math.max(1, Math.min(20, Number(a[1]) || 8)), person) };
                            return { ok: false, error: `there is no function ${fn}` };
                        } });
                        const text = JSON.stringify(out.ok ? { result: out.value, logs: out.logs, calls: out.calls } : { error: out.error, logs: out.logs, calls: out.calls });
                        return ok({ content: [{ type: 'text', text }], ...(out.ok ? {} : { isError: true }) });
                    } finally {
                        running.delete(person.sub);
                    }
                }
                if (name === 'make_tool') return ok(result(await makeOne(req, args)));
                if (name === 'bring_tool') return ok(result(await bringOne(req, args)));
                if (name === 'automate_tool') return ok(result(await automateOne(req, args)));
                if (name === 'my_automations') return ok(result(await automations(req)));
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
