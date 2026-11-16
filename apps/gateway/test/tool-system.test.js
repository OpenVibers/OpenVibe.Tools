'use strict';
// One tool system (the owner, 11-15: "make sure all existing tools use the same universal shared modular system that
// users can make tools with"; made/routes.js, made/triggers.js, migration 0021), on a real in-memory PGlite database:
//   - a tool people made answers at every tool's address: POST /api/v1/tools/mtl_…/run is its run, as the caller;
//   - a catalogue tool takes triggers like a made one: a private link and a schedule, each person their own, run through
//     the run API on loopback with no one's sign-in; a tool that takes a file, needs a sign-in or has no API is refused;
//   - GET /api/v1/me/triggers lists every trigger the person has, on any tool, with the tool's name and where to change it;
//   - a schedule whose tool is gone pauses instead of failing every hour;
//   - the scheduler runs due schedules side by side, so a slow one never holds up the rest.
const assert = require('assert');
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const { createDb } = require('openvibe-sdk/db');
const { openToolsDb } = require('../../_shared/db');
const { ajvFrom } = require('../../_shared/tools/run');
const { createMadeTools } = require('../server/made/store');
const { createPromptRunner } = require('../server/made/prompt');
const { createMadeToolRoutes } = require('../server/made/routes');
const { createTriggers, refusal } = require('../server/made/triggers');

const ADA = 'usr_01JCZ3NDEKTSV4RRFFQ69G5FAW';
const BO = 'usr_01JCZ3NDEKTSV4RRFFQ69G5FAY';
const ORIGIN = 'https://openvibe.tools';
const T0 = Date.UTC(2026, 10, 15, 8, 10);

const descriptor = (id, extra = {}) => ({
    id, family: 'dev', name: id[0].toUpperCase() + id.slice(1), summary: `The ${id} tool.`, status: 'available', execution: 'sync', api: true,
    input: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', maxLength: 2000 }, upper: { type: 'boolean' } } },
    files: null, auth: { anonymous: true, capability: 'tools.tool.run' }, ...extra,
});
const SNAPSHOT = {
    version: 'v1',
    tools: [
        descriptor('echo'),
        descriptor('pdfsplit', { files: { min: 1, max: 1, accept: ['application/pdf'], maxBytes: 1000 }, execution: 'job' }),
        descriptor('portscan', { auth: { anonymous: false, capability: 'tools.net.probe' } }),
        descriptor('colorpick', { api: false, execution: 'client' }),
    ],
};

(async () => {
    assert.strictEqual(refusal({ kind: 'catalogue', ...SNAPSHOT.tools[0] }), null, 'a catalogue tool with an API, for anyone, takes triggers');
    assert.match(refusal({ kind: 'catalogue', ...SNAPSHOT.tools[1] }), /file/);
    assert.match(refusal({ kind: 'catalogue', ...SNAPSHOT.tools[2] }), /signed in/);
    assert.match(refusal({ kind: 'catalogue', ...SNAPSHOT.tools[3] }), /own page/);

    const { db, ready } = openToolsDb({ createDb, service: 'tools-test', log: { warn() {}, info() {}, log() {}, error() {} } });
    await ready;
    const fakeAi = async (url, init) => {
        const body = JSON.parse(init.body);
        const said = body.input.messages[body.input.messages.length - 1].content;
        return new Response(JSON.stringify({ run: { id: 'run_1', status: 'succeeded', output: { model: 'gpt-5-nano', choices: [{ message: { role: 'assistant', content: JSON.stringify({ reply: `Thanks (${said.length} chars)` }) } }] } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    let clock = T0;
    let slowMs = 0;
    const store = createMadeTools({ db });
    const triggers = createTriggers({ db, now: () => clock, baseUrl: ORIGIN });
    const runner = createPromptRunner({ aiUrl: 'https://ai.example', tokens: { getToken: async () => 'svc-token' }, fetchImpl: fakeAi });
    const app = express();
    app.use(cookieParser());
    let server;
    const routes = createMadeToolRoutes({
        store, runner, origin: ORIGIN, log: { error() {}, log() {} }, triggers,
        verify: async (t) => ({ ada: { sub: ADA }, bo: { sub: BO } }[t] || null),
        extractToken: (req) => (req.headers.authorization || '').replace(/^Bearer /, '') || null,
        ...ajvFrom(require),
        address: () => server.address(),
        snapshot: () => SNAPSHOT,
    });
    // As index.js wires it: the made tool at every tool's address, triggers on any tool, then the catalogue's run API.
    const MADE_TOOL_ID = /^mtl_[0-9A-HJKMNP-TV-Z]{26}$/;
    const madeRunBody = express.json({ limit: '256kb' });
    app.post('/api/v1/tools/:id/run', (req, res, next) => (MADE_TOOL_ID.test(req.params.id) ? madeRunBody(req, res, (err) => (err ? next(err) : routes.runRoute(req, res))) : next()));
    app.get('/api/v1/tools/:id', (req, res, next) => (MADE_TOOL_ID.test(req.params.id) ? res.redirect(308, `/api/v1/made-tools/${req.params.id}`) : next()));
    app.use('/api/v1/tools', (req, res, next) => (/^\/[^/]+\/triggers(\/|$)/.test(req.path) ? routes.anyTools(req, res, next) : next()));
    const catalogueRuns = [];
    app.post('/api/v1/tools/:id/run', express.json(), async (req, res) => {
        catalogueRuns.push({ id: req.params.id, input: req.body.input, auth: req.headers.authorization || null, cookie: req.headers.cookie || null });
        if (slowMs) await new Promise((r) => setTimeout(r, slowMs));
        const text = String(req.body.input.text || '');
        res.json({ state: 'succeeded', tool: req.params.id, result: { data: { text: req.body.input.upper ? text.toUpperCase() : text } }, took_ms: 1 });
    });
    app.use('/api/v1/made-tools', routes);
    app.get('/api/v1/me/triggers', (req, res) => routes.mineRoute(req, res));
    app.get('/hooks/:token', (req, res) => routes.hook(req, res));
    app.post('/hooks/:token', express.json(), express.text({ type: ['text/*'] }), (req, res) => routes.hook(req, res));
    server = http.createServer(app).listen(0);
    const root = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, path, { as, body } = {}) => {
        const res = await fetch(root + path, { method, redirect: 'manual', headers: { ...(as ? { Authorization: `Bearer ${as}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* empty */ }
        return { status: res.status, body: json, location: res.headers.get('location') };
    };
    try {
        // ── a made tool at every tool's address ──
        const made = await call('POST', '/api/v1/made-tools', { as: 'ada', body: {
            slug: 'reply-kindly', name: 'Reply kindly', summary: 'Drafts a kind reply.', kind: 'prompt',
            input: { type: 'object', required: ['message'], properties: { message: { type: 'string', maxLength: 4000 } } },
            output: { kind: 'json', schema: { type: 'object', required: ['reply'], properties: { reply: { type: 'string' } } } },
            prompt: { instructions: 'Reply kindly.', model: 'auto' },
        } });
        assert.strictEqual(made.status, 201, JSON.stringify(made.body));
        const id = made.body.id;
        const viaTools = await call('POST', `/api/v1/tools/${id}/run`, { as: 'ada', body: { input: { message: 'well done' }, wait_ms: 1000 } });
        assert.deepStrictEqual([viaTools.status, viaTools.body.state, viaTools.body.tool], [200, 'succeeded', id], JSON.stringify(viaTools.body));
        assert.match(viaTools.body.result.data.reply, /^Thanks/);
        assert.strictEqual((await call('POST', `/api/v1/tools/${id}/run`, { body: { input: { message: 'x' } } })).status, 401, 'a made tool still needs a sign-in');
        const described = await call('GET', `/api/v1/tools/${id}`);
        assert.deepStrictEqual([described.status, described.location], [308, `/api/v1/made-tools/${id}`], 'its description is its made-tool record');

        // ── a catalogue tool takes a link, each person their own ──
        const link = await call('POST', '/api/v1/tools/echo/triggers', { as: 'ada', body: { kind: 'link', input: { upper: true } } });
        assert.strictEqual(link.status, 201, JSON.stringify(link.body));
        assert.match(link.body.url, /^https:\/\/openvibe\.tools\/hooks\/mth_/);
        const token = link.body.url.split('/').pop();
        const ran = await call('POST', `/hooks/${token}`, { body: { text: 'hello there' } });
        assert.deepStrictEqual([ran.status, ran.body.state, ran.body.result.data.text], [200, 'succeeded', 'HELLO THERE'], JSON.stringify(ran.body));
        const last = catalogueRuns[catalogueRuns.length - 1];
        assert.deepStrictEqual([last.id, last.input, last.auth, last.cookie], ['echo', { upper: true, text: 'hello there' }, null, null], 'the fixed input under the request\'s, with no one\'s sign-in');
        const listed = await call('GET', '/api/v1/tools/echo/triggers', { as: 'ada' });
        assert.deepStrictEqual([listed.status, listed.body.tool.kind, listed.body.tool.name, listed.body.triggers.length, listed.body.triggers[0].runs], [200, 'catalogue', 'Echo', 1, 1]);
        assert.deepStrictEqual((await call('GET', '/api/v1/tools/echo/triggers', { as: 'bo' })).body.triggers, [], 'Bo sees none of Ada\'s');
        assert.strictEqual((await call('PATCH', `/api/v1/tools/echo/triggers/${link.body.id}`, { as: 'bo', body: { enabled: false } })).status, 404, 'nor changes them');
        assert.strictEqual((await call('GET', '/api/v1/tools/echo/triggers')).status, 401, 'signed in only');

        // Refused: a file each time, a sign-in each time, no API; an unknown tool.
        for (const t of ['pdfsplit', 'portscan', 'colorpick']) {
            const no = await call('POST', `/api/v1/tools/${t}/triggers`, { as: 'ada', body: { kind: 'link' } });
            assert.deepStrictEqual([no.status, no.body.code], [422, 'tools.trigger.unsupported'], t);
            assert.ok((await call('GET', `/api/v1/tools/${t}/triggers`, { as: 'ada' })).body.unsupported, `${t} says why`);
        }
        assert.strictEqual((await call('GET', '/api/v1/tools/nothing-here/triggers', { as: 'ada' })).status, 404);

        // ── a schedule on a catalogue tool, and on a made one ──
        const daily = await call('POST', '/api/v1/tools/echo/triggers', { as: 'ada', body: { kind: 'schedule', every: 'day', at: '09:00', input: { text: 'good morning' }, notify: false } });
        assert.strictEqual(daily.status, 201, JSON.stringify(daily.body));
        const madeDaily = await call('POST', `/api/v1/tools/${id}/triggers`, { as: 'ada', body: { kind: 'schedule', every: 'day', at: '09:00', input: { message: 'morning' }, notify: false } });
        assert.strictEqual(madeDaily.status, 201, 'a made tool\'s triggers at the same address');
        assert.strictEqual((await call('POST', `/api/v1/tools/${id}/triggers`, { as: 'bo', body: { kind: 'link' } })).status, 404, 'a made tool\'s triggers are its owner\'s');

        // ── every trigger the person has ──
        const mine = await call('GET', '/api/v1/me/triggers', { as: 'ada' });
        assert.strictEqual(mine.status, 200);
        assert.deepStrictEqual(mine.body.triggers.map((t) => [t.tool, t.tool_kind, t.tool_name, t.kind]),
            [['echo', 'catalogue', 'Echo', 'link'], ['echo', 'catalogue', 'Echo', 'schedule'], [id, 'made', 'Reply kindly', 'schedule']]);
        assert.deepStrictEqual(mine.body.triggers.map((t) => t.page), [`${ORIGIN}/make#automate=echo`, `${ORIGIN}/make#automate=echo`, `${ORIGIN}/make#${id}`]);
        assert.strictEqual((await call('GET', '/api/v1/me/triggers', { as: 'bo' })).body.count, 0);

        // ── the scheduler: side by side ──
        slowMs = 300;
        clock = Date.UTC(2026, 10, 15, 9, 1);
        const loop = triggers.start({ run: routes.runTrigger, everyMs: 3_600_000 });
        const t0 = Date.now();
        await loop.tick();
        const took = Date.now() - t0;
        slowMs = 0;
        const afterTick = (await call('GET', '/api/v1/me/triggers', { as: 'ada' })).body.triggers;
        assert.deepStrictEqual(afterTick.map((t) => [t.kind, t.runs, t.last_state]), [['link', 1, 'succeeded'], ['schedule', 1, 'succeeded'], ['schedule', 1, 'succeeded']]);
        assert.strictEqual(afterTick[1].last_result.data.text, 'good morning', 'the catalogue tool\'s answer is kept');
        assert.ok(took < 550, `two due schedules ran side by side (${took} ms; one at a time is over 600)`);

        // ── a schedule whose tool is gone pauses ──
        await db.exec('DELETE FROM made_tools WHERE id = $1', [id]);
        clock = Date.UTC(2026, 10, 16, 9, 1);
        await loop.tick();
        const gone = (await call('GET', '/api/v1/me/triggers', { as: 'ada' })).body.triggers.find((t) => t.id === madeDaily.body.id);
        assert.deepStrictEqual([gone.enabled, gone.last_state, gone.tool_name], [false, 'failed', null], 'paused, and says why');
        assert.match(gone.last_result.error, /gone/);
        loop.stop();
    } finally {
        server.close();
        await db.close();
    }
    console.log('tool system: a made tool at every tool\'s address; catalogue tools take links and schedules (each person their own, no one\'s sign-in), files, sign-ins and page-only tools refused; every trigger listed; schedules side by side; a gone tool\'s schedule paused');
})().catch((err) => { console.error(err); process.exit(1); });
