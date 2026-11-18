'use strict';
// ═══════════════════════════════════════════════════════════════
// /api/v1/made-tools: tools people make (plan 2026-11-13 §AD.7 step 2; tools.made-tool@1).
//
//   GET    /api/v1/made-tools            public tools, the most run first (?q= words, ?limit= 1..100); anyone
//   GET    /api/v1/made-tools?mine=1     the caller's own tools, every visibility; signed in
//   GET    /api/v1/made-tools/models     the models a prompt tool can name (./models.js); anyone
//   POST   /api/v1/made-tools            make one (201); signed in
//   POST   /api/v1/made-tools/draft      { description, kind? } → { draft, body }: a model writes the make form's fields
//                                        (and a code tool's run(input)), as the person (their allowance pays); body is the
//                                        tool as POST / takes it. Nothing is saved (§AD.12 (d), Describe it)
//   GET    /api/v1/made-tools/:id        one tool: public and unlisted to anyone, private to its owner (else 404)
//   PATCH  /api/v1/made-tools/:id        change it (the next version); its owner
//   DELETE /api/v1/made-tools/:id        delete it (204); its owner
//   GET    /api/v1/made-tools/:id/source  a code tool's source as its maker wrote it (the page runs it in the browser)
//   GET    /api/v1/made-tools/:id/code    a code tool's entry (tool.js) for a runner; its sha256 is code.sha256
//   GET    /api/v1/made-tools/:id/triggers         its triggers (made/triggers.js, §AD.12 (g)); its owner
//   POST   /api/v1/made-tools/:id/triggers         { kind: link|schedule, every?, at?, input? } (201; a link's URL once)
//   PATCH  /api/v1/made-tools/:id/triggers/:tid    { enabled?, notify? }; DELETE …/:tid (204); its owner
//   GET|POST /hooks/<mth_…>                         a link trigger: the tool runs as its owner (mounted by index.js)
//   POST   /api/v1/made-tools/:id/run    { input } → tools.run@1; signed in (the run is paid from the caller's own
//                                        allowance, Vibes or keys). A code tool answers 501 tools.made.code_not_ready
//                                        until Link nodes run them (§AD.7 step 4).
//
// One tool system (the owner, 11-15: "all existing tools use the same universal shared modular system that users can make
// tools with"): a made tool is also at every catalogue tool's address, and every tool takes triggers.
//   POST   /api/v1/tools/mtl_…/run       the same run as /api/v1/made-tools/:id/run (index.js sends it here: runRoute)
//   GET    /api/v1/tools/mtl_…           308 to /api/v1/made-tools/:id (index.js)
//   GET|POST /api/v1/tools/:id/triggers, PATCH|DELETE …/:tid   any tool's triggers: a made tool's owner, or anyone signed
//                                        in on a catalogue tool with an API (their own triggers; anyTools)
//   GET    /api/v1/me/triggers           every trigger the person has, on any tool, with its tool's name (mineRoute)
//
// Who: a Network sign-in (Bearer user token with audience openvibe.tools, or the site's session cookie). A write that
// rides on the cookie must come from the site's own origin. A first-party service (Actor's and Codes' agents) acts for
// the person named in X-OV-Subject: with tools.made.run (Contracts 0.437.0) it lists their tools and runs a tool as them
// (paid from their allowance); with tools.made.write (0.439.0) it drafts a tool from their words and makes it for them,
// always private (only the person publishes). No service changes or deletes a tool. Errors are problem+json.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { Invalid } = require('./store');

const SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const MADE_ID = /^mtl_[0-9A-HJKMNP-TV-Z]{26}$/;
const CATALOGUE_ID = /^[a-z][a-z0-9-]{0,39}$/;

function problem(res, status, code, detail, extra = {}) {
    res.status(status).type('application/problem+json').json({ type: `https://openvibe.tools/problems/${code}`, title: detail, status, code, detail, ...extra });
}

/**
 * createMadeToolRoutes({ store, runner, verify, extractToken, origin, Ajv, addFormats, log })
 *   verify(token) → claims | null (Network user tokens for openvibe.tools); origin: https://openvibe.tools.
 */
function createMadeToolRoutes({ store, runner, models = null, verify, verifyService = null, extractToken, origin, address = null, fetchImpl = globalThis.fetch, valFetch = globalThis.fetch, Ajv, addFormats = null, log = console, triggers = null, codeRunner = null, snapshot = null }) {
    // Code tools run on machines when OpenVibe.Run is set up (made/run-code.js, §AD.13 (2)); else on their page only.
    const codeRuns = !!(codeRunner && codeRunner.enabled);
    const { peek, looksLikePrincipal, capabilityDenied } = require('../../../_shared/guard/tokens');
    const r = express.Router();
    const ajv = new Ajv({ strict: false, allErrors: true });
    if (addFormats) addFormats(ajv);
    const validators = new Map();   // id@version → { input, output }

    /** Compile a schema people sent, or refuse it in their words. */
    function compileSchema(schema, field) {
        try { ajv.compile(schema); } catch (err) { throw new Invalid(`${field} is not a JSON Schema that can be used: ${String(err.message).slice(0, 200)}`, [{ pointer: `/${field.replace('.', '/')}` }]); }
    }

    function validatorsFor(tool) {
        const key = `${tool.id}@${tool.version}`;
        if (!validators.has(key)) {
            if (validators.size > 500) validators.clear();
            validators.set(key, { input: ajv.compile(tool.input), output: tool.output.kind === 'json' ? ajv.compile(tool.output.schema) : null });
        }
        return validators.get(key);
    }

    /** A catalogue tool as a trigger sees it (its tools.tool@1 descriptor's facts), or null. One map per registry version. */
    let catalogue = { version: undefined, map: new Map() };
    function catalogueTool(id) {
        if (!snapshot || !CATALOGUE_ID.test(String(id || ''))) return null;
        const snap = snapshot();
        if (catalogue.version !== snap.version) catalogue = { version: snap.version, map: new Map(snap.tools.map((d) => [d.id, d])) };
        const d = catalogue.map.get(id);
        return d ? { id: d.id, kind: 'catalogue', name: d.name, summary: d.summary, input: d.input, api: d.api, auth: d.auth, files: d.files, execution: d.execution, version: `cat-${snap.version}` } : null;
    }
    /** The input check of any tool: a made tool's compiled schema, or a catalogue tool's (the run API checks it again). */
    function inputCheck(tool) {
        if (tool.kind !== 'catalogue') return validatorsFor(tool).input;
        const key = `${tool.id}@${tool.version}`;
        if (!validators.has(key)) {
            if (validators.size > 500) validators.clear();
            let input;
            try { input = ajv.compile(tool.input && typeof tool.input === 'object' ? tool.input : { type: 'object' }); } catch { input = () => true; }
            validators.set(key, { input, output: null });
        }
        return validators.get(key).input;
    }
    /** The gateway's own loopback origin, for runs through its run API, or null. */
    function loopback() {
        const a = typeof address === 'function' ? address() : null;
        if (!a || !a.port) return null;
        const host = !a.address || a.address === '::' || a.address === '0.0.0.0' ? '127.0.0.1' : a.address.includes(':') ? `[${a.address}]` : a.address;
        return `http://${host}:${a.port}`;
    }

    /** The signed-in person's subject, or null. A cookie-borne write must come from our own origin. */
    async function who(req) {
        const token = extractToken(req);
        if (!token) return null;
        const peeked = peek(token);
        if (verifyService && peeked && looksLikePrincipal(peeked)) {
            const v = await Promise.resolve(verifyService(token)).catch(() => null);
            if (!v || !v.ok) return null;
            const canRun = !capabilityDenied(v.claims, 'tools.made.run');
            const canMake = !capabilityDenied(v.claims, 'tools.made.write');
            if (!canRun && !canMake) return null;
            const sub = String(req.get('x-ov-subject') || '');
            return SUBJECT.test(sub) ? { sub, service: v.claims.sub, canRun, canMake } : null;
        }
        const claims = await Promise.resolve(verify(token)).catch(() => null);
        // The person is subject_id (usr_…): a Network token's sub is the numeric account id (11-18).
        const sub = claims && (claims.subject_id || claims.sub || claims.subject);
        if (!SUBJECT.test(String(sub || ''))) return null;
        if (req.method !== 'GET' && !req.headers.authorization && req.headers.origin !== origin) return { sub, crossSite: true };
        return { sub, name: claims.name || claims.username || null };
    }

    /** The person a request acts for, or null (answered). `make`: drafting or making a tool (tools.made.write for a
     *  service); `write`: changing or deleting one (the person only); else listing and running (tools.made.run). */
    async function person(req, res, { write = false, make = false } = {}) {
        const p = await who(req);
        if (!p) { problem(res, 401, 'tools.session_required', 'Sign in with your OpenVibe account'); return null; }
        if (p.service) {
            const ok = make ? p.canMake : write ? false : p.canRun;
            if (!ok) { problem(res, 403, 'capability.denied', make ? 'This service may not make tools for people (tools.made.write)' : write ? 'Only the person changes or deletes their tool' : 'This service may not run people\'s tools (tools.made.run)'); return null; }
        }
        if (p.crossSite) { problem(res, 403, 'tools.origin.refused', 'This change must come from openvibe.tools'); return null; }
        return p;
    }

    const visibleTo = (row, sub) => row && (row.visibility !== 'private' || row.owner_subject === sub);
    const send = (res, err) => {
        if (err instanceof Invalid) return problem(res, 422, err.code, err.message, { errors: err.errors });
        if (err && err.status && err.code) return problem(res, err.status, err.code, err.message);
        log.error('[made-tools]', err && err.message);
        return problem(res, 500, 'tools.made.failed', 'Something went wrong with that tool');
    };

    r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

    r.get('/', async (req, res) => {
        try {
            if (req.query.mine) {
                const p = await person(req, res);
                if (!p) return;
                const rows = await store.listMine(p.sub);
                return res.json({ tools: rows.map((x) => store.present(x)), count: rows.length });
            }
            const rows = await store.listPublic({ q: req.query.q, limit: req.query.limit });
            res.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' });
            res.json({ tools: rows.map((x) => store.present(x)), count: rows.length });
        } catch (err) { send(res, err); }
    });

    r.get('/models', async (req, res) => {
        const body = models ? await models.list().catch(() => ({ models: [], updated_at: null })) : { models: [], updated_at: null };
        res.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300' });
        res.json(body);
    });

    r.post('/draft', express.json({ limit: '16kb' }), async (req, res) => {
        try {
            const p = await person(req, res, { make: true });
            if (!p) return;
            const description = String((req.body && req.body.description) || '').trim();
            if (description.length < 8) return problem(res, 422, 'tools.made.invalid', 'Say in a sentence or two what the tool should do');
            const { draftTool, bodyFromDraft } = require('./prompt');
            const out = await draftTool(runner, description, { subject: p.sub, kind: req.body && req.body.kind === 'code' ? 'code' : 'prompt' });
            // The same tool as POST / takes it (private), for an agent or a command line that makes it next.
            res.json({ ...out, body: bodyFromDraft(out.draft) });
        } catch (err) { send(res, err); }
    });

    // Bring a val from Val Town (made/import-val.js; §AD.12: Val Town closes 2027-01-10): its address or its code as a
    // code tool's draft, the way /draft answers, with the vals it imports; nothing is saved. 20 a person each 10 minutes.
    const valImports = new Map();
    r.post('/import/val', express.json({ limit: '300kb' }), async (req, res) => {
        try {
            const p = await person(req, res, { make: true });
            if (!p) return;
            const now = Date.now();
            const recent = (valImports.get(p.sub) || []).filter((t) => now - t < 600_000);
            if (recent.length >= 20) return problem(res, 429, 'tools.made.slow_down', 'That is many vals at once: try again in a few minutes');
            recent.push(now);
            valImports.set(p.sub, recent);
            if (valImports.size > 5000) valImports.clear();
            const { parseValRef, fetchVal, convertVal } = require('./import-val');
            const b = req.body || {};
            const getVal = (ref) => fetchVal(ref, { fetchImpl: valFetch });
            let val;
            if (typeof b.code === 'string' && b.code.trim()) {
                val = { code: b.code, name: String(b.name || 'my-val').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'my-val', type: ['script', 'http', 'interval'].includes(b.type) ? b.type : 'script', user: '' };
            } else {
                const ref = parseValRef(b.url);
                if (!ref) return problem(res, 422, 'tools.made.invalid', 'Paste a val\'s address on Val Town (https://www.val.town/v/you/name), or its code');
                val = await getVal(ref);
            }
            const out = await convertVal(val, { getVal });
            const { bodyFromDraft } = require('./prompt');
            res.json({ ...out, body: { ...bodyFromDraft(out.draft), net: out.net } });
        } catch (err) { send(res, err); }
    });

    // Bring a Pipedream code step (made/import-pipedream.js; Pipedream Workflows close 2027-03-31): pasted code only,
    // read and compiled, never run here; the same answer as /import/val.
    r.post('/import/pipedream', express.json({ limit: '128kb' }), async (req, res) => {
        try {
            const p = await person(req, res, { make: true });
            if (!p) return;
            const b = req.body || {};
            const { convertPipedream } = require('./import-pipedream');
            const out = convertPipedream({ code: b.code, name: String(b.name || 'pipedream-step').replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 64) || 'pipedream-step' });
            const { bodyFromDraft } = require('./prompt');
            res.json({ ...out, body: { ...bodyFromDraft(out.draft), net: out.net } });
        } catch (err) { send(res, err); }
    });

    r.post('/', express.json({ limit: '128kb' }), async (req, res) => {
        try {
            const p = await person(req, res, { make: true });
            if (!p) return;
            // A tool an agent makes is the person's and private: only they publish it, on the make page.
            const body = p.service && req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? { ...req.body, visibility: 'private' } : req.body;
            const row = await store.create(p.sub, body, { compileSchema });
            if (p.service) log.log(`[made-tools] ${p.service} made ${row.id} for ${p.sub}`);
            res.status(201).set('Location', `/api/v1/made-tools/${row.id}`).json(store.present(row, p.name));
        } catch (err) { send(res, err); }
    });

    r.get('/:id', async (req, res) => {
        try {
            const p = await who(req);
            const row = await store.get(req.params.id);
            if (!visibleTo(row, p && p.sub)) return problem(res, 404, 'tools.made.not_found', 'No tool has that id');
            res.json(store.present(row));
        } catch (err) { send(res, err); }
    });

    // A code tool's source (for the page's sandbox) and entry (for a runner): to whoever may see the tool, never cached
    // by a shared cache for a private one.
    const codeOf = (kind) => async (req, res) => {
        try {
            const p = await who(req);
            const row = await store.get(req.params.id);
            if (!visibleTo(row, p && p.sub) || row.kind !== 'code' || row.code_text == null) return problem(res, 404, 'tools.made.not_found', 'No code tool has that id');
            const { entryOf } = require('./code');
            const body = kind === 'entry' ? entryOf(row.code_text) : row.code_text;
            res.set({ 'Content-Type': 'text/javascript; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': row.visibility === 'private' ? 'private, no-store' : 'public, max-age=60',
                'Content-Disposition': `inline; filename="${kind === 'entry' ? 'tool.js' : `${row.slug}.js`}"` });
            res.send(body);
        } catch (err) { send(res, err); }
    };
    r.get('/:id/source', codeOf('source'));
    r.get('/:id/code', codeOf('entry'));

    r.patch('/:id', express.json({ limit: '128kb' }), async (req, res) => {
        try {
            const p = await person(req, res, { write: true });
            if (!p) return;
            const row = await store.update(req.params.id, p.sub, req.body, { compileSchema });
            if (!row) return problem(res, 404, 'tools.made.not_found', 'You have no tool with that id');
            res.json(store.present(row, p.name));
        } catch (err) { send(res, err); }
    });

    r.delete('/:id', async (req, res) => {
        try {
            const p = await person(req, res, { write: true });
            if (!p) return;
            if (!(await store.remove(req.params.id, p.sub))) return problem(res, 404, 'tools.made.not_found', 'You have no tool with that id');
            res.status(204).end();
        } catch (err) { send(res, err); }
    });

    /**
     * One run of a made tool as `subject`: { body } (tools.run@1, succeeded or failed with the tool's own error), or
     * { refused: { status, code, detail, errors? } } before anything ran. `headers` carry the caller's credentials to a
     * chain's steps (none for a trigger: its steps run as anyone may).
     */
    async function runAs(tool, input, { subject, signal = null, headers = {}, ip = '', codeText = null } = {}) {
        const t0 = Date.now();
        const v = validatorsFor(tool);
        if (!v.input(input)) {
            return { refused: { status: 422, code: 'tools.input.invalid', detail: 'The input does not match the tool\'s input schema',
                errors: (v.input.errors || []).slice(0, 20).map((e) => ({ pointer: e.instancePath || '/', message: e.message })) } };
        }
        if (tool.kind === 'code') {
            if (!codeRuns || codeText == null) return { refused: { status: 501, code: 'tools.made.code_not_ready', detail: `A code tool runs on its page, in your browser (${origin}/make#${tool.id}); runs for agents and the API come with Link's runner` } };
            let out;
            try {
                out = await codeRunner.run(tool, codeText, input, { signal });
            } catch (err) {
                if (err && err.status === 501) return { refused: { status: 501, code: err.code, detail: err.message } };
                return { body: { state: 'failed', tool: tool.id, error: { type: `https://openvibe.tools/problems/${err.code || 'tools.made.machine_failed'}`, title: err.message, status: err.status || 502, code: err.code || 'tools.made.machine_failed', detail: err.message }, took_ms: Date.now() - t0 } };
            }
            if (v.output && out.data !== undefined && !v.output(out.data)) {
                return { body: { state: 'failed', tool: tool.id, error: { type: 'https://openvibe.tools/problems/tools.made.bad_answer', title: 'The code\'s answer did not match the tool\'s output schema', status: 422, code: 'tools.made.bad_answer', detail: (v.output.errors || []).slice(0, 3).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ') }, took_ms: Date.now() - t0 } };
            }
            store.counted(tool.id).catch(() => {});
            return { body: { state: 'succeeded', tool: tool.id, result: out.data !== undefined ? { data: out.data } : { text: out.text }, took_ms: Date.now() - t0, ...(out.job ? { job: out.job } : {}) } };
        }
        if (tool.kind === 'chain') {
            // Each step is one run through the gateway's own run API, as the caller (made/chain.js).
            const base = loopback();
            if (!base) return { refused: { status: 503, code: 'tools.unavailable', detail: 'The chain cannot reach the tools right now' } };
            const h = { 'X-Forwarded-For': ip || '', ...headers, Origin: origin };
            const out = await require('./chain').runChain(tool.chain, input, { base, headers: h, fetchImpl, signal });
            if (!out.ok) return { body: { state: 'failed', tool: tool.id, error: { type: 'https://openvibe.tools/problems/tools.made.step_failed', title: out.error, status: 502, code: 'tools.made.step_failed', detail: out.error, step: out.step }, steps: out.steps, took_ms: Date.now() - t0 } };
            if (v.output && out.result.data !== undefined && !v.output(out.result.data)) {
                return { body: { state: 'failed', tool: tool.id, error: { type: 'https://openvibe.tools/problems/tools.made.bad_answer', title: 'The last step\'s answer did not match the tool\'s output schema', status: 422, code: 'tools.made.bad_answer', detail: (v.output.errors || []).slice(0, 3).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ') }, steps: out.steps, took_ms: Date.now() - t0 } };
            }
            store.counted(tool.id).catch(() => {});
            return { body: { state: 'succeeded', tool: tool.id, result: out.result, steps: out.steps, took_ms: Date.now() - t0 } };
        }
        let out;
        try {
            out = await runner.run(tool, input, { subject, signal });
        } catch (err) {
            if (err && err.status === 401) return { refused: { status: 401, code: err.code, detail: err.message } };
            return { body: { state: 'failed', tool: tool.id, error: { type: `https://openvibe.tools/problems/${err.code || 'tools.made.model_failed'}`, title: err.message, status: err.status || 502, code: err.code || 'tools.made.model_failed', detail: err.message }, took_ms: Date.now() - t0 } };
        }
        if (v.output && !v.output(out.data)) {
            return { body: { state: 'failed', tool: tool.id, error: { type: 'https://openvibe.tools/problems/tools.made.bad_answer', title: 'The model\'s answer did not match the tool\'s output schema', status: 422, code: 'tools.made.bad_answer', detail: (v.output.errors || []).slice(0, 3).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ') }, took_ms: Date.now() - t0 } };
        }
        store.counted(tool.id).catch(() => {});
        return { body: { state: 'succeeded', tool: tool.id, result: out.data !== undefined ? { data: out.data } : { text: out.text }, took_ms: Date.now() - t0, ...(out.model ? { model: out.model } : {}), ...(out.usage ? { usage: out.usage } : {}) } };
    }
    /** One run of a catalogue tool through the run API on loopback, as anyone may (a trigger's run): { body } or
     *  { refused }, as runAs answers. */
    async function runCatalogue(tool, input, { signal = null, ip = '', headers = {} } = {}) {
        const t0 = Date.now();
        const base = loopback();
        if (!base) return { refused: { status: 503, code: 'tools.unavailable', detail: 'The tools cannot be reached right now' } };
        let res, body;
        try {
            res = await fetchImpl(`${base}/api/v1/tools/${encodeURIComponent(tool.id)}/run`, { method: 'POST', redirect: 'error',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Forwarded-For': ip || '', ...headers, Origin: origin },
                body: JSON.stringify({ input, wait_ms: 30000 }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000) });
            body = await res.json().catch(() => null);
        } catch {
            return { body: { state: 'failed', tool: tool.id, error: { type: 'https://openvibe.tools/problems/tools.run.timeout', title: `${tool.name} did not answer in time`, status: 504, code: 'tools.run.timeout', detail: `${tool.name} did not answer in time` }, took_ms: Date.now() - t0 } };
        }
        if (body && typeof body.state === 'string') return { body };
        const b = body || {};
        return { refused: { status: res.status || 502, code: String(b.code || 'tools.run.failed'), detail: String(b.detail || b.title || b.error || `${tool.name} answered ${res.status}`), ...(Array.isArray(b.errors) ? { errors: b.errors } : {}) } };
    }
    const runAny = (tool, input, opts) => (tool.kind === 'catalogue' ? runCatalogue(tool, input, opts) : runAs(tool, input, opts));

    const answer = (res, out) => (out.refused
        ? problem(res, out.refused.status, out.refused.code, out.refused.detail, out.refused.errors ? { errors: out.refused.errors } : {})
        : res.json(out.body));

    async function runRoute(req, res) {
        try {
            const p = await person(req, res);
            if (!p) return;
            const row = await store.get(req.params.id);
            if (!visibleTo(row, p.sub)) return problem(res, 404, 'tools.made.not_found', 'No tool has that id');
            const tool = store.present(row);
            const input = req.body && typeof req.body === 'object' && req.body.input !== undefined ? req.body.input : {};
            const ctrl = new AbortController();
            res.on('close', () => { if (!res.writableFinished) ctrl.abort(); });
            const headers = {};
            for (const k of ['authorization', 'cookie', 'x-ov-subject']) if (req.headers[k]) headers[k] = req.headers[k];
            answer(res, await runAs(tool, input, { subject: p.sub, signal: ctrl.signal, headers, ip: req.ip, codeText: row.code_text }));
        } catch (err) { send(res, err); }
    }
    r.post('/:id/run', express.json({ limit: '256kb' }), runRoute);
    r.runRoute = runRoute;

    // ── Triggers (§AD.12 (g)): on any tool. A made tool's are its owner's alone; on a catalogue tool, each person signed in
    // has their own. A service never makes or changes one. ──
    const ownTool = async (req, res) => {
        if (!triggers) { problem(res, 404, 'tools.trigger.off', 'Triggers are not on here'); return null; }
        const p = await person(req, res, { write: true });
        if (!p) return null;
        const id = String(req.params.id || '');
        if (!MADE_ID.test(id)) {
            const tool = catalogueTool(id);
            if (!tool) { problem(res, 404, 'tools.tool.not_found', 'No tool has that id'); return null; }
            return { p, tool };
        }
        const row = await store.get(id);
        if (!row || row.owner_subject !== p.sub) { problem(res, 404, 'tools.made.not_found', 'You have no tool with that id'); return null; }
        return { p, tool: store.present(row) };
    };
    const triggerSend = (res, err) => (err && err.code && String(err.code).startsWith('tools.trigger.') ? problem(res, err.status, err.code, err.message) : send(res, err));
    const anyTools = express.Router();
    anyTools.use('/:id/triggers', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    for (const router of [r, anyTools]) {
        router.get('/:id/triggers', async (req, res) => {
            try {
                const own = await ownTool(req, res);
                if (!own) return;
                const why = require('./triggers').refusal(own.tool, { codeRuns });
                res.json({ tool: { id: own.tool.id, name: own.tool.name, kind: own.tool.kind, input: own.tool.input }, triggers: await triggers.list(own.tool.id, own.p.sub), ...(why ? { unsupported: why } : {}) });
            } catch (err) { triggerSend(res, err); }
        });
        router.post('/:id/triggers', express.json({ limit: '32kb' }), async (req, res) => {
            try {
                const own = await ownTool(req, res);
                if (!own) return;
                const made = await triggers.create(own.tool, own.p.sub, req.body || {}, { codeRuns });
                res.status(201).json(made);
            } catch (err) { triggerSend(res, err); }
        });
        router.patch('/:id/triggers/:tid', express.json({ limit: '4kb' }), async (req, res) => {
            try {
                const own = await ownTool(req, res);
                if (!own) return;
                const b = req.body || {};
                const t = await triggers.change(req.params.tid, own.p.sub, { ...(b.enabled !== undefined ? { enabled: !!b.enabled } : {}), ...(b.notify !== undefined ? { notify: !!b.notify } : {}) });
                if (!t || t.tool !== own.tool.id) return problem(res, 404, 'tools.trigger.not_found', 'This tool has no trigger with that id');
                res.json(t);
            } catch (err) { triggerSend(res, err); }
        });
        router.delete('/:id/triggers/:tid', async (req, res) => {
            try {
                const own = await ownTool(req, res);
                if (!own) return;
                if (!(await triggers.remove(req.params.tid, own.p.sub))) return problem(res, 404, 'tools.trigger.not_found', 'This tool has no trigger with that id');
                res.status(204).end();
            } catch (err) { triggerSend(res, err); }
        });
    }
    r.anyTools = anyTools;

    /** The tool a trigger runs, as its owner may run it: { tool, codeText } or null (gone, or no longer theirs). */
    async function triggerTool(trig) {
        if (!MADE_ID.test(String(trig.tool_id || ''))) {
            const tool = catalogueTool(trig.tool_id);
            return tool && !require('./triggers').refusal(tool) ? { tool, codeText: null } : null;
        }
        const row = await store.get(trig.tool_id);
        if (!row || row.owner_subject !== trig.owner_subject) return null;
        return { tool: store.present(row), codeText: row.code_text };
    }

    // GET /api/v1/me/triggers (index.js mounts it): every trigger the person has, with its tool's name and where to change it.
    r.mineRoute = async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            if (!triggers) return res.json({ triggers: [] });
            const p = await person(req, res, { write: true });
            if (!p) return;
            const list = await triggers.listOwner(p.sub);
            const names = new Map();
            await Promise.all([...new Set(list.map((t) => t.tool))].map(async (id) => {
                if (MADE_ID.test(id)) { const row = await store.get(id).catch(() => null); names.set(id, row && row.owner_subject === p.sub ? { name: row.name, kind: 'made' } : null); }
                else { const t = catalogueTool(id); names.set(id, t ? { name: t.name, kind: 'catalogue' } : null); }
            }));
            res.json({ triggers: list.map((t) => {
                const n = names.get(t.tool);
                return { ...t, tool_name: n ? n.name : null, tool_kind: n ? n.kind : null, page: `${origin}/make#${MADE_ID.test(t.tool) ? t.tool : `automate=${t.tool}`}` };
            }), count: list.length });
        } catch (err) { send(res, err); }
    };

    /**
     * GET|POST /hooks/<mth_…> (index.js mounts it): a link trigger runs its tool as the owner. The input is the trigger's
     * fixed input under the request's: a JSON body's `input`, else the JSON body itself, else the query. When that is not
     * the tool's input and the tool takes one text field, the request's whole body goes into it (a webhook's payload).
     */
    async function hook(req, res) {
        res.set({ 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
        try {
            if (!triggers) return problem(res, 404, 'tools.trigger.not_found', 'No trigger has that link');
            const trig = await triggers.byToken(req.params.token);
            if (!trig) return problem(res, 404, 'tools.trigger.not_found', 'No trigger has that link');
            if (!trig.enabled) return problem(res, 423, 'tools.trigger.paused', 'Its owner paused this link');
            if (!triggers.allowLink(trig.id)) return problem(res, 429, 'tools.trigger.too_many', 'This link ran 30 times this minute: try again shortly');
            const found = await triggerTool(trig);
            if (!found) return problem(res, 404, 'tools.trigger.not_found', 'No trigger has that link');
            const tool = found.tool;
            const b = req.body;
            const json = b && typeof b === 'object' && !Array.isArray(b) && Object.keys(b).length ? b : null;
            const given = json ? (json.input && typeof json.input === 'object' && !Array.isArray(json.input) ? json.input : json) : { ...req.query };
            let input = { ...(trig.input || {}), ...given };
            const props = (tool.input && tool.input.properties) || {};
            const keys = Object.keys(props);
            if (!inputCheck(tool)(input) && keys.length === 1 && props[keys[0]] && props[keys[0]].type === 'string') {
                const raw = typeof b === 'string' ? b : b && typeof b === 'object' && Object.keys(b).length ? JSON.stringify(b) : '';
                if (raw) input = { [keys[0]]: raw.slice(0, Number(props[keys[0]].maxLength) || 20000) };
            }
            const ctrl = new AbortController();
            res.on('close', () => { if (!res.writableFinished) ctrl.abort(); });
            const out = await runAny(tool, input, { subject: trig.owner_subject, signal: ctrl.signal, ip: req.ip, codeText: found.codeText });
            await triggers.record(trig.id, out.body || { state: 'failed', error: { detail: out.refused.detail } }).catch(() => {});
            answer(res, out);
        } catch (err) { send(res, err); }
    }
    r.hook = hook;
    // The scheduler's run: a due schedule's tool, as its owner, with its fixed input.
    // After a schedule ran: tell its owner (made/notify.js), with the tool's name.
    r.toldTrigger = async (trig, out, notifier) => {
        if (!notifier) return { sent: false, reason: 'off' };
        const found = await triggerTool(trig);
        if (!found) return { sent: false, reason: 'gone' };
        return notifier.scheduleRan({ subject: trig.owner_subject, tool: { id: found.tool.id, name: found.tool.name }, says: require('./triggers').describe(trig), out });
    };
    r.runTrigger = async (trig) => {
        const found = await triggerTool(trig);
        if (!found) {
            // The tool is gone (or no longer runs on its own): the schedule stops instead of failing every hour.
            await triggers.setEnabled(trig.id, trig.owner_subject, false).catch(() => {});
            return { state: 'failed', error: { detail: 'The tool is gone, so this schedule is paused' } };
        }
        const out = await runAny(found.tool, trig.input || {}, { subject: trig.owner_subject, signal: AbortSignal.timeout(120_000), codeText: found.codeText });
        return out.body || { state: 'failed', error: { detail: out.refused.detail } };
    };

    return r;
}

module.exports = { createMadeToolRoutes };
