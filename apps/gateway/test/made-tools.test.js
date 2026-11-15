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
    // A catalogue tool a chain can call (the run API's shape): upper-cases text; 'refuse' fails.
    const stepRuns = [];
    app.post('/api/v1/tools/:id/run', express.json(), (req, res) => {
        stepRuns.push({ tool: req.params.id, input: req.body.input, auth: req.headers.authorization || null });
        if (req.params.id === 'refuse') return res.status(422).json({ title: 'The input does not match', detail: 'input.text is required' });
        res.json({ state: 'succeeded', tool: req.params.id, result: { data: { text: String(req.body.input.text || '').toUpperCase() } } });
    });
    let server;
    app.use('/api/v1/made-tools', createMadeToolRoutes({
        store, runner, origin: ORIGIN, log: { error() {}, log() {} },
        verify: async (t) => ({ ada: { sub: ADA, username: 'ada' }, bo: { sub: BO, username: 'bo' } }[t] || null),
        extractToken: (req) => (req.headers.authorization || '').replace(/^Bearer /, '') || (req.cookies && req.cookies.ov_token) || null,
        // A first-party service (Actor's agents): tools.made.run, acting for X-OV-Subject (Contracts 0.437.0).
        verifyService: async (t) => { const c = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()); return c.sig === 'good' ? { ok: true, claims: c } : { ok: false, code: 'token.bad_signature' }; },
        ...ajvFrom(require),
        address: () => server.address(),
    }));
    server = http.createServer(app).listen(0);
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

        // ── Describe it: a model drafts the form, as the person; nothing is saved ──
        aiAnswer = JSON.stringify({ name: 'Meeting notes', summary: 'Turns a meeting note into a summary, decisions and actions.', instructions: 'Read the note. Write a short summary, the decisions, and the action items with their owners.', inputs: [{ label: 'Note', kind: 'long' }], answer: 'fields', fields: [{ label: 'Summary' }, { label: 'Decisions' }, { label: 'Actions' }] });
        const before = (await call('GET', '/?mine=1', { as: 'ada' })).body.count;
        const drafted = await call('POST', '/draft', { as: 'ada', body: { description: 'Turn my meeting notes into decisions and action items' } });
        assert.strictEqual(drafted.status, 200, JSON.stringify(drafted.body));
        assert.deepStrictEqual([drafted.body.draft.name, drafted.body.draft.answer, drafted.body.draft.fields.length, drafted.body.draft.inputs[0].kind], ['Meeting notes', 'fields', 3, 'long']);
        assert.deepStrictEqual(aiCalls[aiCalls.length - 1].body.on_behalf_of, { type: 'user', id: ADA }, 'the drafting is paid by the person');
        assert.strictEqual((await call('GET', '/?mine=1', { as: 'ada' })).body.count, before, 'a draft saves nothing');
        assert.strictEqual((await call('POST', '/draft', { body: { description: 'something useful please' } })).status, 401);
        assert.strictEqual((await call('POST', '/draft', { as: 'ada', body: { description: 'short' } })).status, 422);
        // A code tool's draft: the run(input) source too, checked like a maker's own.
        aiAnswer = JSON.stringify({ name: 'Word count', summary: 'Counts words.', inputs: [{ label: 'Text', kind: 'long' }], answer: 'fields', fields: [{ label: 'Words' }], source: 'function run(input) {\n  return { words: String(input.text || "").split(/\\s+/).filter(Boolean).length };\n}' });
        const codeDraft = await call('POST', '/draft', { as: 'ada', body: { description: 'Count the words in a text', kind: 'code' } });
        assert.strictEqual(codeDraft.status, 200, JSON.stringify(codeDraft.body));
        assert.deepStrictEqual([codeDraft.body.draft.kind, /function run/.test(codeDraft.body.draft.source), codeDraft.body.draft.instructions], ['code', true, undefined]);
        // The draft as the body POST / takes: keys from the labels, private, and it makes the tool as it is.
        assert.deepStrictEqual([codeDraft.body.body.slug, codeDraft.body.body.kind, codeDraft.body.body.visibility, Object.keys(codeDraft.body.body.input.properties), Object.keys(codeDraft.body.body.output.schema.properties)], ['word-count', 'code', 'private', ['text'], ['words']]);
        const fromDraft = await call('POST', '/', { as: 'ada', body: codeDraft.body.body });
        assert.strictEqual(fromDraft.status, 201, JSON.stringify(fromDraft.body));
        assert.strictEqual((await call('DELETE', `/${fromDraft.body.id}`, { as: 'ada' })).status, 204);
        assert.match(aiCalls[aiCalls.length - 1].body.input.messages[0].content, /plain JavaScript/, 'the code drafter\'s own instructions');
        aiAnswer = JSON.stringify({ name: 'Broken', summary: 'x', inputs: [], answer: 'text', fields: [], source: 'const x = 1;' });
        const badDraft = await call('POST', '/draft', { as: 'ada', body: { description: 'Something that will not hold up', kind: 'code' } });
        assert.deepStrictEqual([badDraft.status, badDraft.body.code], [422, 'tools.made.bad_answer']);
        assert.strictEqual((await call('POST', '/draft', { as: svc(['tools.made.run']), subject: ADA, body: { description: 'an agent drafting a tool' } })).status, 403, 'an agent does not draft through this');
        // ── an agent makes a tool for the person (tools.made.write, Contracts 0.439.0): drafted and saved as theirs, private ──
        const maker = svc(['tools.made.write']);
        aiAnswer = JSON.stringify({ name: 'Word count', summary: 'Counts words.', inputs: [{ label: 'Text', kind: 'long' }], answer: 'fields', fields: [{ label: 'Words' }], source: 'function run(input) {\n  return { words: String(input.text || "").split(/\\s+/).filter(Boolean).length };\n}' });
        const agentDraft = await call('POST', '/draft', { as: maker, subject: ADA, body: { description: 'Count the words in a text', kind: 'code' } });
        assert.strictEqual(agentDraft.status, 200, JSON.stringify(agentDraft.body));
        assert.deepStrictEqual(aiCalls[aiCalls.length - 1].body.on_behalf_of, { type: 'user', id: ADA }, 'the person the agent works for pays for the draft');
        const agentMade = await call('POST', '/', { as: maker, subject: ADA, body: { slug: 'word-count', name: 'Word count', summary: 'Counts words.', kind: 'code', input: { type: 'object', properties: { text: { type: 'string' } } }, output: { kind: 'json', schema: { type: 'object' } }, source_code: agentDraft.body.draft.source, visibility: 'public' } });
        assert.strictEqual(agentMade.status, 201, JSON.stringify(agentMade.body));
        assert.deepStrictEqual([agentMade.body.owner.subject, agentMade.body.visibility], [ADA, 'private'], 'the person owns it, and it stays private until they publish it');
        assert.ok((await call('GET', '/?mine=1', { as: 'ada' })).body.tools.some((x) => x.id === agentMade.body.id), 'it is in their own list');
        assert.strictEqual((await call('PATCH', `/${agentMade.body.id}`, { as: maker, subject: ADA, body: { visibility: 'public' } })).status, 403, 'an agent never changes one');
        assert.strictEqual((await call('DELETE', `/${agentMade.body.id}`, { as: maker, subject: ADA })).status, 403, 'or deletes one');
        assert.strictEqual((await call('POST', `/${t.id}/run`, { as: maker, subject: BO, body: { input: { message: 'x' } } })).status, 403, 'making is not running (tools.made.run)');
        assert.strictEqual((await call('POST', '/', { as: maker, body: { ...reply, slug: 'nobody' } })).status, 401, 'without the person it works for');
        aiAnswer = '{"reply":"Thank you, that is kind of you."}';
        aiAnswer = '{"reply":"Thank you, that is kind of you."}';
        // ── code tools from source (§AD.12 (c)): the source in, the entry's digest out, both served ──
        const crypto = require('crypto');
        const { entryOf } = require('../server/made/code');
        const SRC = "function run(input) {\n  return { upper: String(input.text || '').toUpperCase() };\n}\n";
        const shout = await call('POST', '/', { as: 'ada', body: { slug: 'shout', name: 'Shout', summary: 'Upper-cases text.', kind: 'code', input: { type: 'object', properties: { text: { type: 'string' } } }, output: { kind: 'json', schema: { type: 'object' } }, source_code: SRC, visibility: 'unlisted' } });
        assert.strictEqual(shout.status, 201, JSON.stringify(shout.body));
        const digest = crypto.createHash('sha256').update(entryOf(SRC)).digest('hex');
        assert.deepStrictEqual([shout.body.code.sha256, shout.body.code.entry, shout.body.code.source], [digest, 'tool.js', `https://openvibe.tools/api/v1/made-tools/${shout.body.id}/code`], 'the entry\'s digest and where it is');
        const srcRes = await fetch(`${base}/${shout.body.id}/source`);
        assert.strictEqual(await srcRes.text(), SRC, 'the source, for the page\'s sandbox');
        const entryText = await (await fetch(`${base}/${shout.body.id}/code`)).text();
        assert.strictEqual(crypto.createHash('sha256').update(entryText).digest('hex'), digest, 'the entry a runner gets has the digest the tool names');
        const badCode = await call('POST', '/', { as: 'ada', body: { slug: 'nope-code', name: 'Nope', summary: 'x', kind: 'code', input: { type: 'object' }, output: { kind: 'text' }, source_code: 'const x = 1;' } });
        assert.deepStrictEqual([badCode.status, badCode.body.errors[0].pointer], [422, '/source_code']);
        assert.match(badCode.body.detail, /run\(input\) function/);
        assert.strictEqual((await call('POST', '/', { as: 'ada', body: { ...reply, slug: 'prompt-with-src', source_code: SRC } })).status, 422, 'a prompt tool has no code');
        const ranCode = await call('POST', `/${shout.body.id}/run`, { as: 'bo', body: { input: { text: 'hi' } } });
        assert.deepStrictEqual([ranCode.status, ranCode.body.code], [501, 'tools.made.code_not_ready']);
        assert.match(ranCode.body.detail, /on its page, in your browser/);
        const privateCode = await call('PATCH', `/${shout.body.id}`, { as: 'ada', body: { visibility: 'private', source_code: SRC.replace('toUpperCase', 'toLowerCase') } });
        assert.strictEqual(privateCode.body.version, 2);
        assert.notStrictEqual(privateCode.body.code.sha256, digest, 'new code, a new digest');
        assert.strictEqual((await fetch(`${base}/${shout.body.id}/source`)).status, 404, 'a private tool\'s code is its owner\'s alone');
        assert.strictEqual((await call('GET', `/${shout.body.id}/source`, { as: 'ada' })).status, 200);

        // ── chains (§AD.12 (e)): a catalogue tool, then a made tool, as the person who runs it ──
        aiAnswer = '{"reply":"Thanks for the kind words!"}';
        const chainBody = { slug: 'shout-then-reply', name: 'Shout, then reply', summary: 'Upper-cases a message, then drafts a kind reply to it.', kind: 'chain',
            input: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } }, output: { kind: 'json', schema: { type: 'object', required: ['reply'], properties: { reply: { type: 'string' } } } },
            chain: { steps: [{ tool: 'upper', name: 'Shout it', input: { text: '{{input.text}}' } }, { tool: t.id, name: 'Reply', input: { message: 'They said: {{steps.0.text}}' } }] }, visibility: 'public' };
        const chainMade = await call('POST', '/', { as: 'ada', body: chainBody });
        assert.strictEqual(chainMade.status, 201, JSON.stringify(chainMade.body));
        assert.deepStrictEqual([chainMade.body.kind, chainMade.body.chain.steps.length, chainMade.body.chain.output_from, chainMade.body.prompt, chainMade.body.code], ['chain', 2, 'last', null, null]);
        const nAi = aiCalls.length;
        const chained = await call('POST', `/${chainMade.body.id}/run`, { as: 'bo', body: { input: { text: 'you rock' } } });
        assert.strictEqual(chained.status, 200, JSON.stringify(chained.body));
        assert.deepStrictEqual([chained.body.state, chained.body.result.data.reply, chained.body.steps.map((s) => s.name)], ['succeeded', 'Thanks for the kind words!', ['Shout it', 'Reply']]);
        assert.deepStrictEqual([stepRuns[stepRuns.length - 1].tool, stepRuns[stepRuns.length - 1].input, stepRuns[stepRuns.length - 1].auth], ['upper', { text: 'you rock' }, 'Bearer bo'], 'step 1 ran as the caller with the chain\'s input');
        assert.strictEqual(JSON.parse(aiCalls[nAi].body.input.messages[1].content).message, 'They said: YOU ROCK', 'step 2 read step 1\'s answer');
        assert.deepStrictEqual(aiCalls[nAi].body.on_behalf_of, { type: 'user', id: BO }, 'the person who runs the chain pays for every step');
        const brokenChain = await call('POST', '/', { as: 'ada', body: { ...chainBody, slug: 'broken-chain', chain: { steps: [{ tool: 'refuse', input: {} }, { tool: t.id, input: { message: '{{steps.0.text}}' } }] } } });
        const failedChain = await call('POST', `/${brokenChain.body.id}/run`, { as: 'bo', body: { input: { text: 'x' } } });
        assert.deepStrictEqual([failedChain.body.state, failedChain.body.error.step], ['failed', 0]);
        assert.match(failedChain.body.error.detail, /Step 1 \(refuse\): input.text is required/);
        const forward = await call('POST', '/', { as: 'ada', body: { ...chainBody, slug: 'reads-ahead', chain: { steps: [{ tool: 'upper', input: { text: '{{steps.1.text}}' } }, { tool: 'upper', input: {} }] } } });
        assert.deepStrictEqual([forward.status, forward.body.errors[0].pointer], [422, '/chain/steps/0/input'], 'a step reads only steps before it');
        assert.strictEqual((await call('POST', '/', { as: 'ada', body: { ...chainBody, slug: 'one-step', chain: { steps: [{ tool: 'upper', input: {} }] } } })).status, 422, 'two steps at least');
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
