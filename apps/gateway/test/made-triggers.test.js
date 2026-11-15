'use strict';
// Triggers for the tools people make (plan 2026-11-13 §AD.12 (g); migration 0019; server/made/triggers.js), on a real
// in-memory PGlite database:
//   - the owner makes a link trigger: its URL comes back once, the list shows only its last four characters;
//   - GET or POST the link and the tool runs as its owner (their allowance pays), with the fixed input under the
//     request's; a webhook's own payload goes whole into the tool's one text field; the last answer is kept;
//   - a paused link answers 423, an unknown one 404, a busy one 429;
//   - a schedule runs every hour or every day at its time (UTC), claimed once, the missed runs never made up;
//   - a code tool and a chain of tools people made take no trigger; only the owner sees and changes a tool's triggers,
//     never a service; deleting the tool deletes its triggers; the export has them without the link's hash.
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
const { createTriggers, nextRun } = require('../server/made/triggers');
const accountData = require('../server/account-data');

const ADA = 'usr_01JCZ3NDEKTSV4RRFFQ69G5FAW';
const BO = 'usr_01JCZ3NDEKTSV4RRFFQ69G5FAY';
const ORIGIN = 'https://openvibe.tools';
const T0 = Date.UTC(2026, 10, 15, 8, 10);   // 2026-11-15 08:10 UTC

(async () => {
    // The schedule maths, first: the next hour at :15, the next day at 09:30, never the time itself.
    assert.strictEqual(new Date(nextRun(60, 15, T0)).toISOString(), '2026-11-15T08:15:00.000Z');
    assert.strictEqual(new Date(nextRun(60, 5, T0)).toISOString(), '2026-11-15T09:05:00.000Z');
    assert.strictEqual(new Date(nextRun(1440, 9 * 60 + 30, T0)).toISOString(), '2026-11-15T09:30:00.000Z');
    assert.strictEqual(new Date(nextRun(1440, 8 * 60 + 10, T0)).toISOString(), '2026-11-16T08:10:00.000Z');

    const { db, ready } = openToolsDb({ createDb, service: 'tools-test', log: { warn() {}, info() {}, log() {}, error() {} } });
    await ready;
    const aiCalls = [];
    const fakeAi = async (url, init) => {
        const body = JSON.parse(init.body);
        aiCalls.push(body);
        const said = body.input.messages[body.input.messages.length - 1].content;
        return new Response(JSON.stringify({ run: { id: 'run_1', status: 'succeeded', output: { model: 'gpt-5-nano', choices: [{ message: { role: 'assistant', content: JSON.stringify({ reply: `Thanks (${said.length} chars)` }) } }] } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    let clock = T0;
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
        verifyService: async (t) => { const c = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()); return c.sig === 'good' ? { ok: true, claims: c } : { ok: false }; },
        ...ajvFrom(require),
        address: () => server.address(),
    });
    app.use('/api/v1/made-tools', routes);
    app.get('/hooks/:token', (req, res) => routes.hook(req, res));
    app.post('/hooks/:token', express.json(), express.text({ type: ['text/*'] }), (req, res) => routes.hook(req, res));
    server = http.createServer(app).listen(0);
    const root = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, path, { as, body, subject, raw, type } = {}) => {
        const res = await fetch(root + path, { method, headers: { ...(subject ? { 'X-OV-Subject': subject } : {}), ...(as ? { Authorization: `Bearer ${as}` } : {}), ...(body || raw ? { 'Content-Type': type || 'application/json' } : {}) }, body: raw != null ? raw : body ? JSON.stringify(body) : undefined });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* empty */ }
        return { status: res.status, body: json };
    };
    const svc = (cap) => `x.${Buffer.from(JSON.stringify({ sub: 'svc:actor', cap, sig: 'good' })).toString('base64url')}.y`;
    try {
        const reply = await call('POST', '/api/v1/made-tools', { as: 'ada', body: {
            slug: 'reply-kindly', name: 'Reply kindly', summary: 'Drafts a kind reply.', kind: 'prompt',
            input: { type: 'object', required: ['message'], properties: { message: { type: 'string', maxLength: 4000 }, tone: { type: 'string' } } },
            output: { kind: 'json', schema: { type: 'object', required: ['reply'], properties: { reply: { type: 'string' } } } },
            prompt: { instructions: 'Reply kindly.', model: 'auto' },
        } });
        assert.strictEqual(reply.status, 201, JSON.stringify(reply.body));
        const id = reply.body.id;

        // ── a link ──
        const link = await call('POST', `/api/v1/made-tools/${id}/triggers`, { as: 'ada', body: { kind: 'link', input: { tone: 'warm' } } });
        assert.strictEqual(link.status, 201, JSON.stringify(link.body));
        assert.match(link.body.url, /^https:\/\/openvibe\.tools\/hooks\/mth_[A-Za-z0-9_-]{43}$/, 'the URL, once');
        const token = link.body.url.split('/').pop();
        const listed = await call('GET', `/api/v1/made-tools/${id}/triggers`, { as: 'ada' });
        assert.deepStrictEqual([listed.body.triggers.length, listed.body.triggers[0].hint, listed.body.triggers[0].url], [1, token.slice(-4), undefined], 'the list shows the last four, never the URL');
        assert.match(listed.body.triggers[0].says, /^A link …/);

        const ran = await call('POST', `/hooks/${token}`, { body: { message: 'you did great' } });
        assert.deepStrictEqual([ran.status, ran.body.state], [200, 'succeeded'], JSON.stringify(ran.body));
        const asked = aiCalls[aiCalls.length - 1];
        assert.deepStrictEqual(asked.on_behalf_of, { type: 'user', id: ADA }, 'the owner pays');
        assert.match(asked.input.messages[asked.input.messages.length - 1].content, /warm/, 'the fixed input is under the request\'s');
        const viaGet = await call('GET', `/hooks/${token}?message=hello`);
        assert.strictEqual(viaGet.body.state, 'succeeded', 'GET with the input in the query');
        // A webhook's own payload: not the tool's input, so it goes whole into the one text field.
        const one = await call('POST', '/api/v1/made-tools', { as: 'ada', body: {
            slug: 'summarize-event', name: 'Summarize an event', summary: 'Says what a webhook event is about.', kind: 'prompt',
            input: { type: 'object', required: ['event'], properties: { event: { type: 'string', maxLength: 20000 } } },
            output: { kind: 'json', schema: { type: 'object', required: ['reply'], properties: { reply: { type: 'string' } } } },
            prompt: { instructions: 'Say in one line what happened.', model: 'auto' },
        } });
        const hookTwo = (await call('POST', `/api/v1/made-tools/${one.body.id}/triggers`, { as: 'ada', body: { kind: 'link' } })).body.url.split('/').pop();
        const payload = { action: 'opened', pull_request: { number: 7, title: 'Fix the search bar' } };
        assert.strictEqual((await call('POST', `/hooks/${hookTwo}`, { body: payload })).body.state, 'succeeded');
        assert.ok(aiCalls[aiCalls.length - 1].input.messages.some((m) => String(m.content).includes('Fix the search bar')), 'the payload reached the model whole');
        assert.strictEqual((await call('POST', `/hooks/${hookTwo}`, { raw: 'plain words from a form', type: 'text/plain' })).body.state, 'succeeded', 'a text body too');

        const after = (await call('GET', `/api/v1/made-tools/${id}/triggers`, { as: 'ada' })).body.triggers[0];
        assert.deepStrictEqual([after.runs, after.last_state, typeof after.last_result.data.reply], [2, 'succeeded', 'string'], 'the last answer is kept');

        // Paused, unknown, busy.
        const tid = after.id;
        assert.strictEqual((await call('PATCH', `/api/v1/made-tools/${id}/triggers/${tid}`, { as: 'ada', body: { enabled: false } })).body.enabled, false);
        assert.strictEqual((await call('POST', `/hooks/${token}`, { body: { message: 'x' } })).status, 423);
        assert.strictEqual((await call('PATCH', `/api/v1/made-tools/${id}/triggers/${tid}`, { as: 'ada', body: { enabled: true } })).body.enabled, true);
        assert.strictEqual((await call('POST', `/hooks/mth_${'A'.repeat(43)}`, { body: {} })).status, 404);
        assert.strictEqual((await call('POST', '/hooks/nonsense', { body: {} })).status, 404);
        let allowed = 0;
        for (let i = 0; i < 40; i++) if (triggers.allowLink('mtt_busy')) allowed++;
        assert.strictEqual(allowed, 30, 'thirty runs a minute a link');

        // ── a schedule ──
        const daily = await call('POST', `/api/v1/made-tools/${id}/triggers`, { as: 'ada', body: { kind: 'schedule', every: 'day', at: '09:30', input: { message: 'good morning' } } });
        assert.strictEqual(daily.status, 201, JSON.stringify(daily.body));
        assert.deepStrictEqual([daily.body.says, daily.body.next_run_at], ['Every day at 09:30 UTC', '2026-11-15T09:30:00.000Z']);
        assert.strictEqual((await call('POST', `/api/v1/made-tools/${id}/triggers`, { as: 'ada', body: { kind: 'schedule', every: 'minute' } })).status, 422);
        assert.strictEqual((await call('POST', `/api/v1/made-tools/${id}/triggers`, { as: 'ada', body: { kind: 'schedule', every: 'day', at: '25:00' } })).status, 422);
        const loop = triggers.start({ run: routes.runTrigger, everyMs: 3_600_000 });
        await loop.tick();
        assert.strictEqual((await call('GET', `/api/v1/made-tools/${id}/triggers`, { as: 'ada' })).body.triggers[1].runs, 0, 'not due yet');
        clock = Date.UTC(2026, 10, 17, 12, 0);   // two days later: one run, not three
        await loop.tick();
        await loop.tick();
        const ranDaily = (await call('GET', `/api/v1/made-tools/${id}/triggers`, { as: 'ada' })).body.triggers[1];
        assert.deepStrictEqual([ranDaily.runs, ranDaily.last_state, ranDaily.next_run_at], [1, 'succeeded', '2026-11-18T09:30:00.000Z'], 'run once, the missed day not made up');
        loop.stop();

        // ── who may ──
        const code = await call('POST', '/api/v1/made-tools', { as: 'ada', body: { slug: 'shout', name: 'Shout', summary: 'Upper-cases text.', kind: 'code', input: { type: 'object', properties: { text: { type: 'string' } } }, output: { kind: 'text' }, source_code: 'function run(input) { return String(input.text || "").toUpperCase(); }' } });
        const noCode = await call('POST', `/api/v1/made-tools/${code.body.id}/triggers`, { as: 'ada', body: { kind: 'link' } });
        assert.deepStrictEqual([noCode.status, noCode.body.code], [422, 'tools.trigger.unsupported']);
        assert.match((await call('GET', `/api/v1/made-tools/${code.body.id}/triggers`, { as: 'ada' })).body.unsupported, /browser/);
        assert.strictEqual((await call('GET', `/api/v1/made-tools/${id}/triggers`, { as: 'bo' })).status, 404, 'someone else sees nothing');
        assert.strictEqual((await call('POST', `/api/v1/made-tools/${id}/triggers`, { as: 'bo', body: { kind: 'link' } })).status, 404);
        assert.strictEqual((await call('GET', `/api/v1/made-tools/${id}/triggers`, { as: svc(['tools.made.run']), subject: ADA })).status, 403, 'a service never touches triggers');
        assert.strictEqual((await call('DELETE', `/api/v1/made-tools/${id}/triggers/${tid}`, { as: 'bo' })).status, 404);

        // ── the export has them, never the hash; deleting the tool deletes its triggers ──
        const t = accountData.TABLES.find((x) => x.table === 'made_tool_triggers');
        assert.ok(t && t.subject === 'owner_subject' && !t.columns.includes('token_hash') && t.columns.includes('last_result'));
        assert.strictEqual((await call('DELETE', `/api/v1/made-tools/${id}`, { as: 'ada' })).status, 204);
        assert.strictEqual((await db.one('SELECT count(*)::int AS n FROM made_tool_triggers WHERE tool_id = $1', [id])).n, 0, 'gone with the tool');
        assert.strictEqual((await call('POST', `/hooks/${token}`, { body: { message: 'x' } })).status, 404, 'its link is dead');
    } finally {
        server.close();
        await db.close();
    }
    console.log('made triggers: a link runs the tool as its owner (input, query, a webhook\'s payload), paused, unknown and busy links; a schedule runs once at its time; code tools and other people refused; gone with the tool');
})().catch((err) => { console.error(err); process.exit(1); });
