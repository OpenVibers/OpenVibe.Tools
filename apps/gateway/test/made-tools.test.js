'use strict';
// Tools people make (plan 2026-11-13 §AD.7 step 2; tools.made-tool@1; server/made) on a real in-memory PGlite database:
//   - a person makes a prompt tool; its shape is the contract's; their short name is theirs alone;
//   - a schema that cannot be used, a prompt tool with code or a network, and an unknown kind are refused in words;
//   - private tools are their owner's alone; public ones are listed for everyone, unlisted ones only by id;
//   - a run checks the input against the tool's schema, then asks OpenVibe.AI as the person who runs it (their
//     allowance pays, never the maker's), with the tool's instructions, model and output schema; an answer that does
//     not match the output schema is a failed run; a code tool is not taken yet;
//   - a write carried by the site's cookie must come from openvibe.tools; the owner changes (the next version) and
//     deletes; the account export names the table.
const assert = require('assert');
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const { createDb } = require('openvibe-sdk/db');
const { openToolsDb } = require('../../_shared/db');
const { ajvFrom } = require('../../_shared/tools/run');
const { createMadeTools } = require('../server/made/store');
const { createPromptRunner, parseJson } = require('../server/made/prompt');
const { createMadeToolRoutes } = require('../server/made/routes');
const accountData = require('../server/account-data');

const ADA = 'usr_01JCZ3NDEKTSV4RRFFQ69G5FAW';
const BO = 'usr_01JCZ3NDEKTSV4RRFFQ69G5FAY';
const ORIGIN = 'https://openvibe.tools';

(async () => {
    const { db, ready } = openToolsDb({ createDb, service: 'tools-test', log: { warn() {}, info() {}, log() {}, error() {} } });
    await ready;
    const aiCalls = [];
    let aiAnswer = '{"reply":"Thank you, that is kind of you."}';
    const fakeAi = async (url, init) => {
        aiCalls.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ run: { id: 'run_1', status: 'succeeded', output: { model: 'gpt-5-nano', choices: [{ message: { role: 'assistant', content: aiAnswer } }] }, usage: { tokens_in: 120, tokens_out: 14, cost_usd: 0.00002 } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const store = createMadeTools({ db });
    const runner = createPromptRunner({ aiUrl: 'https://ai.example', tokens: { getToken: async () => 'svc-token' }, fetchImpl: fakeAi });
    const app = express();
    app.use(cookieParser());
    app.use('/api/v1/made-tools', createMadeToolRoutes({
        store, runner, origin: ORIGIN, log: { error() {} },
        verify: async (t) => ({ ada: { sub: ADA, username: 'ada' }, bo: { sub: BO, username: 'bo' } }[t] || null),
        extractToken: (req) => (req.headers.authorization || '').replace(/^Bearer /, '') || (req.cookies && req.cookies.ov_token) || null,
        // A first-party service (Actor's agents): tools.made.run, acting for X-OV-Subject (Contracts 0.437.0).
        verifyService: async (t) => { const c = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()); return c.sig === 'good' ? { ok: true, claims: c } : { ok: false, code: 'token.bad_signature' }; },
        ...ajvFrom(require),
    }));
    const server = http.createServer(app).listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api/v1/made-tools`;
    const svc = (cap, sig = 'good') => `x.${Buffer.from(JSON.stringify({ sub: 'svc:actor', cap, sig })).toString('base64url')}.y`;
    const call = async (method, path, { as, body, cookie, origin, subject } = {}) => {
        const res = await fetch(base + path, { method, headers: { ...(subject ? { 'X-OV-Subject': subject } : {}), ...(as ? { Authorization: `Bearer ${as}` } : {}), ...(cookie ? { Cookie: `ov_token=${cookie}` } : {}), ...(origin ? { Origin: origin } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* empty */ }
        return { status: res.status, body: json };
    };
    const reply = {
        slug: 'reply-kindly', name: 'Reply kindly', summary: 'Drafts a short, kind reply to a message.', kind: 'prompt',
        input: { type: 'object', required: ['message'], properties: { message: { type: 'string', maxLength: 4000 } } },
        output: { kind: 'json', schema: { type: 'object', required: ['reply'], properties: { reply: { type: 'string' } } } },
        prompt: { instructions: 'Write a short, kind reply to the message.', model: 'gpt-5-nano', temperature: 0.4 },
        visibility: 'public',
    };
    try {
        // ── making ──
        assert.strictEqual((await call('POST', '/', { body: reply })).status, 401, 'making a tool needs a sign-in');
        const made = await call('POST', '/', { as: 'ada', body: reply });
        assert.strictEqual(made.status, 201, JSON.stringify(made.body));
        const t = made.body;
        assert.match(t.id, /^mtl_[0-9A-HJKMNP-TV-Z]{26}$/);
        assert.deepStrictEqual([t.owner.subject, t.kind, t.version, t.net, t.hosting, t.code, t.run.path], [ADA, 'prompt', 1, 'deny', 'openvibe', null, `/api/v1/made-tools/${t.id}/run`]);
        const contracts = require('openvibe-contracts');
        let known = true;
        try { contracts.assertValid('tools.made-tool@1', t); } catch (err) { if (/unknown|not found|no contract/i.test(err.message)) known = false; else throw err; }
        if (!known) console.log('made tools: this openvibe-contracts has no tools.made-tool@1 yet; the shape is checked by the fields above');
        assert.strictEqual((await call('POST', '/', { as: 'ada', body: reply })).status, 409, 'the same short name twice');
        assert.strictEqual((await call('POST', '/', { as: 'bo', body: { ...reply, visibility: 'unlisted' } })).status, 201, 'another person may use the same short name');

        // ── refused in words ──
        const bad = async (body, pointer) => {
            const r = await call('POST', '/', { as: 'ada', body: { ...reply, slug: 'x-' + Math.random().toString(36).slice(2, 8), ...body } });
            assert.strictEqual(r.status, 422, JSON.stringify(body));
            assert.strictEqual(r.body.code, 'tools.made.invalid');
            if (pointer) assert.ok(r.body.errors.some((e) => e.pointer.startsWith(pointer)), `${pointer} in ${JSON.stringify(r.body.errors)}`);
        };
        await bad({ input: { type: 'object', properties: { a: { type: 'nonsense' } } } }, '/input');
        await bad({ input: { type: 'string' } }, '/input');
        await bad({ code: { sha256: 'a'.repeat(64), entry: 'tool.js' } }, '/code');
        await bad({ net: 'public' }, '/net');
        await bad({ kind: 'macro' }, '/kind');
        await bad({ slug: 'Bad Slug' }, '/slug');
        await bad({ output: { kind: 'json' } }, '/output');

        // ── who sees what ──
        const code = await call('POST', '/', { as: 'ada', body: { slug: 'csv-columns', name: 'CSV columns', summary: 'Lists a CSV\'s columns.', kind: 'code', input: { type: 'object', properties: { csv: { type: 'string' } } }, output: { kind: 'json', schema: { type: 'object' } }, code: { sha256: 'b'.repeat(64), entry: 'tool.js' }, hosting: 'mine' } });
        assert.strictEqual(code.status, 201, JSON.stringify(code.body));
        assert.deepStrictEqual([code.body.visibility, code.body.prompt, code.body.hosting], ['private', null, 'mine'], 'private unless said; a code tool has no prompt');
        assert.strictEqual((await call('GET', `/${code.body.id}`, { as: 'bo' })).status, 404, 'a private tool is its owner\'s alone');
        assert.strictEqual((await call('GET', `/${code.body.id}`)).status, 404);
        assert.strictEqual((await call('GET', `/${code.body.id}`, { as: 'ada' })).status, 200);
        assert.strictEqual((await call('GET', `/${t.id}`)).status, 200, 'a public tool is anyone\'s to read');
        const pub = await call('GET', '/?q=kind reply');
        assert.deepStrictEqual(pub.body.tools.map((x) => x.id), [t.id], 'listed: public tools only (not the unlisted one of the same name)');
        const mine = await call('GET', '/?mine=1', { as: 'ada' });
        assert.deepStrictEqual(mine.body.tools.map((x) => x.slug).sort(), ['csv-columns', 'reply-kindly']);
        assert.strictEqual((await call('GET', '/?mine=1')).status, 401);

        // ── running ──
        assert.strictEqual((await call('POST', `/${t.id}/run`, { body: { input: { message: 'hi' } } })).status, 401, 'a run needs a sign-in: it is paid from the runner\'s allowance');
        const badInput = await call('POST', `/${t.id}/run`, { as: 'bo', body: { input: { msg: 'hi' } } });
        assert.strictEqual(badInput.status, 422);
        assert.strictEqual(badInput.body.code, 'tools.input.invalid');
        assert.strictEqual(aiCalls.length, 0, 'a refused input never reaches the model');
        const ran = await call('POST', `/${t.id}/run`, { as: 'bo', body: { input: { message: 'You did great today.' } } });
        assert.strictEqual(ran.status, 200, JSON.stringify(ran.body));
        assert.deepStrictEqual([ran.body.state, ran.body.result.data.reply, ran.body.model], ['succeeded', 'Thank you, that is kind of you.', 'gpt-5-nano']);
        const sent = aiCalls[0];
        assert.ok(sent.url.startsWith('https://ai.example/api/v1/runs?wait='));
        assert.strictEqual(sent.auth, 'Bearer svc-token');
        assert.deepStrictEqual(sent.body.on_behalf_of, { type: 'user', id: BO }, 'the person who runs it pays, never the maker');
        assert.strictEqual(sent.body.workflow, 'ai.complete');
        assert.strictEqual(sent.body.input.model, 'gpt-5-nano');
        assert.strictEqual(sent.body.input.temperature, 0.4);
        assert.strictEqual(sent.body.input.response_format.json_schema.name, 'reply_kindly');
        assert.ok(sent.body.input.messages[0].content.startsWith('Write a short, kind reply to the message.'));
        assert.deepStrictEqual(JSON.parse(sent.body.input.messages[1].content), { message: 'You did great today.' }, 'the input goes as data');
        assert.strictEqual((await call('GET', `/${t.id}`)).body.runs, 1, 'runs are counted');

        aiAnswer = 'Sure! ```json\n{"answer": 3}\n```';
        const off = await call('POST', `/${t.id}/run`, { as: 'bo', body: { input: { message: 'x' } } });
        assert.deepStrictEqual([off.body.state, off.body.error.code], ['failed', 'tools.made.bad_answer'], 'an answer outside the output schema is a failed run');
        assert.deepStrictEqual(parseJson('Sure! ```json\n{"a":1}\n``` done'), { a: 1 });
        assert.strictEqual(parseJson('no json here'), undefined);
        assert.strictEqual((await call('POST', `/${code.body.id}/run`, { as: 'bo', body: { input: {} } })).status, 404, 'nobody else runs a private tool');
        const notYet = await call('POST', `/${code.body.id}/run`, { as: 'ada', body: { input: { csv: 'a,b' } } });
        assert.deepStrictEqual([notYet.status, notYet.body.code], [501, 'tools.made.code_not_ready']);

        // ── an agent runs it as the person (tools.made.run) ──
        const agent = svc(['tools.made.run']);
        const n0 = aiCalls.length;
        aiAnswer = '{"reply":"Hello from an agent run"}';
        const viaAgent = await call('POST', `/${t.id}/run`, { as: agent, subject: BO, body: { input: { message: 'hi' } } });
        assert.deepStrictEqual([viaAgent.status, viaAgent.body.state], [200, 'succeeded'], JSON.stringify(viaAgent.body));
        assert.deepStrictEqual(aiCalls[n0].body.on_behalf_of, { type: 'user', id: BO }, 'the person the agent works for pays');
        const theirs = await call('GET', '/?mine=1', { as: agent, subject: ADA });
        assert.deepStrictEqual(theirs.body.tools.map((x) => x.slug).sort(), ['csv-columns', 'reply-kindly'], 'the agent lists the person\'s own tools');
        assert.strictEqual((await call('POST', `/${code.body.id}/run`, { as: agent, subject: BO, body: { input: {} } })).status, 404, 'a private tool runs only for its owner, through an agent too');
        assert.strictEqual((await call('POST', '/', { as: agent, subject: ADA, body: { ...reply, slug: 'by-agent' } })).status, 403, 'an agent never makes one');
        assert.strictEqual((await call('DELETE', `/${t.id}`, { as: agent, subject: ADA })).status, 403, 'or deletes one');
        assert.strictEqual((await call('POST', `/${t.id}/run`, { as: svc([]), subject: BO, body: { input: { message: 'x' } } })).status, 401, 'without tools.made.run');
        assert.strictEqual((await call('POST', `/${t.id}/run`, { as: agent, body: { input: { message: 'x' } } })).status, 401, 'without the person it works for');
        assert.strictEqual((await call('POST', `/${t.id}/run`, { as: svc(['tools.made.run'], 'forged'), subject: BO, body: { input: { message: 'x' } } })).status, 401, 'a forged token');
        aiAnswer = '{"reply":"Thank you, that is kind of you."}';

        // ── changing and deleting ──
        assert.strictEqual((await call('PATCH', `/${t.id}`, { cookie: 'ada', origin: 'https://evil.example', body: { name: 'x' } })).status, 403, 'a cookie-borne write from another site is refused');
        assert.strictEqual((await call('PATCH', `/${t.id}`, { as: 'bo', body: { name: 'Mine now' } })).status, 404, 'nobody else changes it');
        const changed = await call('PATCH', `/${t.id}`, { cookie: 'ada', origin: ORIGIN, body: { summary: 'Drafts a short, warm reply.', prompt: { instructions: 'Reply warmly.', model: 'auto' } } });
        assert.strictEqual(changed.status, 200, JSON.stringify(changed.body));
        assert.deepStrictEqual([changed.body.version, changed.body.summary, changed.body.prompt.model], [2, 'Drafts a short, warm reply.', 'auto']);
        assert.strictEqual((await call('PATCH', `/${t.id}`, { as: 'ada', body: { kind: 'code' } })).status, 422, 'a tool keeps its kind');
        aiAnswer = '{"reply":"ok"}';
        await call('POST', `/${t.id}/run`, { as: 'ada', body: { input: { message: 'x' } } });
        assert.ok(!('model' in aiCalls[aiCalls.length - 1].body.input), 'auto leaves the model to the router');
        assert.strictEqual((await call('DELETE', `/${t.id}`, { as: 'bo' })).status, 404);
        assert.strictEqual((await call('DELETE', `/${t.id}`, { as: 'ada' })).status, 204);
        assert.strictEqual((await call('GET', `/${t.id}`)).status, 404);

        // ── the account export ──
        assert.ok(accountData.TABLES.some((x) => x.table === 'made_tools' && x.subject === 'owner_subject'), 'made_tools is exported and erased with the account');
    } finally {
        server.close();
    }
    console.log('made tools: made, refused in words, private stays private, runs paid by the runner, versioned, deleted');
    process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
