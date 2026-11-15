'use strict';
// ═══════════════════════════════════════════════════════════════
// /api/v1/made-tools: tools people make (plan 2026-11-13 §AD.7 step 2; tools.made-tool@1).
//
//   GET    /api/v1/made-tools            public tools, the most run first (?q= words, ?limit= 1..100); anyone
//   GET    /api/v1/made-tools?mine=1     the caller's own tools, every visibility; signed in
//   GET    /api/v1/made-tools/models     the models a prompt tool can name (./models.js); anyone
//   POST   /api/v1/made-tools            make one (201); signed in
//   GET    /api/v1/made-tools/:id        one tool: public and unlisted to anyone, private to its owner (else 404)
//   PATCH  /api/v1/made-tools/:id        change it (the next version); its owner
//   DELETE /api/v1/made-tools/:id        delete it (204); its owner
//   POST   /api/v1/made-tools/:id/run    { input } → tools.run@1; signed in (the run is paid from the caller's own
//                                        allowance, Vibes or keys). A code tool answers 501 tools.made.code_not_ready
//                                        until Link nodes run them (§AD.7 step 4).
//
// Who: a Network sign-in (Bearer user token with audience openvibe.tools, or the site's session cookie). A write that
// rides on the cookie must come from the site's own origin. Errors are problem+json.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const { Invalid } = require('./store');

const SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;

function problem(res, status, code, detail, extra = {}) {
    res.status(status).type('application/problem+json').json({ type: `https://openvibe.tools/problems/${code}`, title: detail, status, code, detail, ...extra });
}

/**
 * createMadeToolRoutes({ store, runner, verify, extractToken, origin, Ajv, addFormats, log })
 *   verify(token) → claims | null (Network user tokens for openvibe.tools); origin: https://openvibe.tools.
 */
function createMadeToolRoutes({ store, runner, models = null, verify, extractToken, origin, Ajv, addFormats = null, log = console }) {
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

    /** The signed-in person's subject, or null. A cookie-borne write must come from our own origin. */
    async function who(req) {
        const token = extractToken(req);
        if (!token) return null;
        const claims = await Promise.resolve(verify(token)).catch(() => null);
        const sub = claims && (claims.sub || claims.subject);
        if (!SUBJECT.test(String(sub || ''))) return null;
        if (req.method !== 'GET' && !req.headers.authorization && req.headers.origin !== origin) return { sub, crossSite: true };
        return { sub, name: claims.name || claims.username || null };
    }

    async function person(req, res) {
        const p = await who(req);
        if (!p) { problem(res, 401, 'tools.session_required', 'Sign in with your OpenVibe account'); return null; }
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

    r.post('/', express.json({ limit: '64kb' }), async (req, res) => {
        try {
            const p = await person(req, res);
            if (!p) return;
            const row = await store.create(p.sub, req.body, { compileSchema });
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

    r.patch('/:id', express.json({ limit: '64kb' }), async (req, res) => {
        try {
            const p = await person(req, res);
            if (!p) return;
            const row = await store.update(req.params.id, p.sub, req.body, { compileSchema });
            if (!row) return problem(res, 404, 'tools.made.not_found', 'You have no tool with that id');
            res.json(store.present(row, p.name));
        } catch (err) { send(res, err); }
    });

    r.delete('/:id', async (req, res) => {
        try {
            const p = await person(req, res);
            if (!p) return;
            if (!(await store.remove(req.params.id, p.sub))) return problem(res, 404, 'tools.made.not_found', 'You have no tool with that id');
            res.status(204).end();
        } catch (err) { send(res, err); }
    });

    r.post('/:id/run', express.json({ limit: '256kb' }), async (req, res) => {
        const t0 = Date.now();
        try {
            const p = await person(req, res);
            if (!p) return;
            const row = await store.get(req.params.id);
            if (!visibleTo(row, p.sub)) return problem(res, 404, 'tools.made.not_found', 'No tool has that id');
            const tool = store.present(row);
            const input = req.body && typeof req.body === 'object' && req.body.input !== undefined ? req.body.input : {};
            const v = validatorsFor(tool);
            if (!v.input(input)) {
                return problem(res, 422, 'tools.input.invalid', 'The input does not match the tool\'s input schema',
                    { errors: (v.input.errors || []).slice(0, 20).map((e) => ({ pointer: e.instancePath || '/', message: e.message })) });
            }
            if (tool.kind === 'code') return problem(res, 501, 'tools.made.code_not_ready', 'Code tools run on Link nodes, which are not taking them yet: make it a prompt tool for now');
            const ctrl = new AbortController();
            res.on('close', () => { if (!res.writableFinished) ctrl.abort(); });
            let out;
            try {
                out = await runner.run(tool, input, { subject: p.sub, signal: ctrl.signal });
            } catch (err) {
                if (err && err.status === 401) return problem(res, 401, err.code, err.message);
                return res.json({ state: 'failed', tool: tool.id, error: { type: `https://openvibe.tools/problems/${err.code || 'tools.made.model_failed'}`, title: err.message, status: err.status || 502, code: err.code || 'tools.made.model_failed', detail: err.message }, took_ms: Date.now() - t0 });
            }
            if (v.output && !v.output(out.data)) {
                return res.json({ state: 'failed', tool: tool.id, error: { type: 'https://openvibe.tools/problems/tools.made.bad_answer', title: 'The model\'s answer did not match the tool\'s output schema', status: 422, code: 'tools.made.bad_answer', detail: (v.output.errors || []).slice(0, 3).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ') }, took_ms: Date.now() - t0 });
            }
            store.counted(tool.id).catch(() => {});
            res.json({ state: 'succeeded', tool: tool.id, result: out.data !== undefined ? { data: out.data } : { text: out.text }, took_ms: Date.now() - t0, ...(out.model ? { model: out.model } : {}), ...(out.usage ? { usage: out.usage } : {}) });
        } catch (err) { send(res, err); }
    });

    return r;
}

module.exports = { createMadeToolRoutes };
