'use strict';
// POST /mcp (plan 2026-11-13 §AD.12 (a)): every tool to any agent over MCP's Streamable HTTP transport.
//   - initialize names the server and echoes a protocol it speaks; a notification gets 202 and no body;
//   - tools/list is find_tools, run_tool, run_tools, make_tool and bring_tool, then the signed-in person's own made tools by name;
//   - make_tool drafts a tool from words and saves it private, both as the caller; a taken slug gets a suffix;
//   - bring_tool converts a Val Town val or a Pipedream step and saves it private, as the caller, with its notes;
//   - automate_tool sets a schedule or a private link on any tool as the caller (the link's URL once); my_automations
//     lists them (one tool system, 11-15);
//   - find_tools finds catalogue and made tools for a need, with their input schemas (private tools only for their owner);
//   - run_tool and run_tools go through the run API over loopback with the caller's own Authorization, a made tool to
//     /api/v1/made-tools/:id/run; a failure is isError with the run's own words; an unknown method or tool is an error.
const assert = require('assert');
const http = require('http');
const express = require('express');
const { createToolsMcp } = require('../server/mcp');

const ADA = 'usr_01JCZ3NDEKTSV4RRFFQ69G5FAW';
const OWN = 'mtl_01JCZ3NDEKTSV4RRFFQ69G5FA1';
const PUB = 'mtl_01JCZ3NDEKTSV4RRFFQ69G5FA2';

(async () => {
    const runs = [];
    // The run API stand-in (the gateway's own routes over loopback).
    const api = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            runs.push({ path: req.url, auth: req.headers.authorization || null, body: JSON.parse(body || '{}') });
            const json = (status, b) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
            if (req.url === '/api/v1/tools/dns/run') return json(200, { state: 'succeeded', tool: 'dns', result: { data: { a: ['93.184.215.14'] } }, took_ms: 12 });
            if (req.url === '/api/v1/tools/hash/run') return json(200, { state: 'succeeded', tool: 'hash', result: { text: 'abc123' }, took_ms: 2 });
            if (req.url === '/api/v1/tools/broken/run') return json(422, { title: 'The input does not match', detail: 'input.domain is required' });
            if (req.url === `/api/v1/made-tools/${OWN}/run`) return json(200, { state: 'succeeded', tool: OWN, result: { data: { reply: 'Thanks!' } } });
            if (req.url === `/api/v1/made-tools/${PUB}/run`) return json(200, { state: 'failed', tool: PUB, error: { detail: 'The model did not answer with a JSON object' } });
            if (req.url === '/api/v1/made-tools/draft') {
                if (req.headers.authorization !== 'Bearer ada') return json(401, { title: 'Sign in with your OpenVibe account' });
                const d = JSON.parse(body);
                return json(200, { draft: { kind: d.kind, name: 'Price with tax' }, body: { slug: 'price-with-tax', name: 'Price with tax', summary: 'Adds tax.', kind: d.kind, input: { type: 'object', properties: { price: { type: 'number' } } }, output: { kind: 'text' }, source_code: 'function run(input) { return String(input.price * 1.1); }', visibility: 'private' } });
            }
            if (req.url === '/api/v1/made-tools/import/val' || req.url === '/api/v1/made-tools/import/pipedream') {
                if (req.headers.authorization !== 'Bearer ada') return json(401, { title: 'Sign in with your OpenVibe account' });
                const d = JSON.parse(body);
                if (d.url === 'https://www.val.town/v/ada/pkgs') return json(422, { code: 'tools.made.val_imports', detail: 'ada/pkgs imports npm:zod. A tool runs with no packages.' });
                return json(200, { draft: { kind: 'code', name: 'Greet' }, notes: ['It reads Deno.env (its secrets on Val Town).'], net: 'deny', body: { slug: 'greet', name: 'Greet', summary: 'Greets.', kind: 'code', net: 'deny', input: { type: 'object', properties: { name: { type: 'string' } } }, output: { kind: 'text' }, source_code: 'async function run(input) { return "hi"; }', visibility: 'private' } });
            }
            if (req.url === '/api/v1/tools/dns/triggers') {
                if (req.headers.authorization !== 'Bearer ada') return json(401, { title: 'Sign in with your OpenVibe account' });
                const b = JSON.parse(body);
                if (b.kind === 'link') return json(201, { id: 'mtt_01JCZ3NDEKTSV4RRFFQ69G5FA1', tool: 'dns', kind: 'link', says: 'A link …k3Zq', input: b.input, notify: false, next_run_at: null, url: 'https://openvibe.tools/hooks/mth_secret' });
                return json(201, { id: 'mtt_01JCZ3NDEKTSV4RRFFQ69G5FA2', tool: 'dns', kind: 'schedule', says: `Every ${b.every} at ${b.at} UTC`, input: b.input, notify: b.notify !== false, next_run_at: '2026-11-16T09:00:00.000Z' });
            }
            if (req.url === '/api/v1/tools/portscan/triggers') return json(422, { code: 'tools.trigger.unsupported', detail: 'This tool needs you signed in for each run, so it cannot run on its own yet' });
            if (req.url === '/api/v1/me/triggers') {
                if (req.headers.authorization !== 'Bearer ada') return json(401, { title: 'Sign in with your OpenVibe account' });
                return json(200, { triggers: [{ id: 'mtt_01JCZ3NDEKTSV4RRFFQ69G5FA2', tool: 'dns', tool_name: 'DNS lookup', tool_kind: 'catalogue', kind: 'schedule', says: 'Every day at 09:00 UTC', enabled: true, runs: 3, last_state: 'succeeded', next_run_at: '2026-11-16T09:00:00.000Z', page: 'https://openvibe.tools/make#automate=dns' }], count: 1 });
            }
            if (req.url === '/api/v1/made-tools') {
                const b = JSON.parse(body);
                if (b.slug === 'price-with-tax') return json(409, { title: 'You already have a tool called price-with-tax' });
                return json(201, { id: 'mtl_01JCZ3NDEKTSV4RRFFQ69G5FA9', slug: b.slug, name: b.name, summary: b.summary, kind: b.kind, visibility: b.visibility, input: b.input, output: b.output });
            }
            return json(404, { title: 'No such tool' });
        });
    }).listen(0, '127.0.0.1');
    await new Promise((ok) => api.once('listening', ok));

    const row = (id, owner, slug, name, summary, visibility) => ({ id, owner_subject: owner, slug, name, summary, visibility, kind: 'prompt', input_schema: { type: 'object', properties: { message: { type: 'string' } } }, output: { kind: 'text' }, prompt: { instructions: 'x', model: 'auto' }, code: null, net: 'deny', hosting: 'openvibe', version: 1, runs: 0, created_at: new Date(), updated_at: new Date() });
    const rows = [row(OWN, ADA, 'reply-kindly', 'Reply kindly', 'Drafts a short, kind reply to a message.', 'private'), row(PUB, 'usr_01JCZ3NDEKTSV4RRFFQ69G5FAY', 'email-summary', 'Email summary', 'Summarizes an email in three lines.', 'public')];
    const { present } = require('../server/made/store');
    const store = {
        present,
        listPublic: async ({ q }) => rows.filter((r) => r.visibility === 'public' && (!q || `${r.name} ${r.summary}`.toLowerCase().includes(String(q).toLowerCase().split(' ')[0]))),
        listMine: async (sub) => rows.filter((r) => r.owner_subject === sub),
    };
    const snapshot = () => ({ tools: [
        { id: 'dns', name: 'DNS lookup', summary: 'Look up the DNS records of a domain.', api: true, run: { path: '/api/v1/tools/dns/run' }, input: { type: 'object', properties: { domain: { type: 'string' } }, required: ['domain'] }, auth: { anonymous: true }, keywords: ['dns records', 'mx'] },
        { id: 'hash', name: 'Hash', summary: 'Hash text with SHA-256 and more.', api: true, run: { path: '/api/v1/tools/hash/run' }, input: { $ref: 'x' }, auth: { anonymous: true } },
        { id: 'yt', name: 'YouTube', summary: 'A page only.', api: false, run: null },
    ] });
    const mcp = createToolsMcp({
        address: () => api.address(), snapshot, store,
        verify: async (t) => (t === 'ada' ? { sub: ADA } : null),
        extractToken: (req) => (req.headers.authorization || '').replace(/^Bearer /, '') || null,
    });
    const app = express();
    app.post('/mcp', express.json(), (req, res) => mcp.handle(req, res));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((ok) => server.once('listening', ok));
    const base = `http://127.0.0.1:${server.address().port}/mcp`;
    let n = 0;
    const rpc = async (method, params, { as, notify = false } = {}) => {
        const res = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', ...(as ? { authorization: `Bearer ${as}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', method, ...(notify ? {} : { id: ++n }), ...(params ? { params } : {}) }) });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    const call = async (name, args, opts) => (await rpc('tools/call', { name, arguments: args }, opts)).body;
    const textOf = (b) => b.result.content[0].text;
    try {
        const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } });
        assert.deepStrictEqual([init.body.result.protocolVersion, init.body.result.serverInfo.name, !!init.body.result.capabilities.tools], ['2025-11-25', 'openvibe-tools', true]);
        assert.strictEqual((await rpc('initialize', { protocolVersion: '1999-01-01' })).body.result.protocolVersion, '2025-06-18', 'an unknown version gets ours');
        const note = await rpc('notifications/initialized', null, { notify: true });
        assert.deepStrictEqual([note.status, note.body], [202, null], 'a notification has no answer');
        assert.deepStrictEqual((await rpc('ping')).body.result, {});

        // tools/list: the three, then your own made tools by name.
        const anon = (await rpc('tools/list')).body.result.tools.map((t) => t.name);
        assert.deepStrictEqual(anon, ['find_tools', 'run_tool', 'run_tools', 'make_tool', 'bring_tool', 'automate_tool', 'my_automations', 'run_code']);
        const mine = (await rpc('tools/list', null, { as: 'ada' })).body.result.tools;
        assert.deepStrictEqual(mine.map((t) => t.name), ['find_tools', 'run_tool', 'run_tools', 'make_tool', 'bring_tool', 'automate_tool', 'my_automations', 'run_code', 'made_reply_kindly']);
        assert.deepStrictEqual(mine.find((t) => t.name === 'made_reply_kindly').inputSchema, { type: 'object', properties: { message: { type: 'string' } } }, 'your tool with its own input schema');

        // find_tools: the catalogue (with its schema) and the made tools; a private tool only for its owner.
        const dns = JSON.parse(textOf(await call('find_tools', { need: 'mx records for a domain' })));
        assert.strictEqual(dns[0].tool, 'dns');
        assert.deepStrictEqual(dns[0].input.required, ['domain']);
        assert.ok(!dns.some((t) => t.tool === 'yt'), 'a page-only tool is not offered');
        const summary = JSON.parse(textOf(await call('find_tools', { need: 'summarize an email' })));
        assert.ok(summary.some((t) => t.tool === PUB && t.made), 'a public tool someone made');
        const reply = JSON.parse(textOf(await call('find_tools', { need: 'kind reply' })));
        assert.ok(!Array.isArray(reply) || !reply.some((t) => t.tool === OWN), 'nobody else finds a private tool');
        const replyMine = JSON.parse(textOf(await call('find_tools', { need: 'kind reply' }, { as: 'ada' })));
        assert.ok(replyMine.some((t) => t.tool === OWN && t.yours), 'its owner does');
        assert.ok(JSON.parse(textOf(await call('find_tools', { need: 'teleport a cat' }))).none, 'nothing fits: says where to make one');

        // run_tool: through the run API with the caller's own credentials.
        const ran = await call('run_tool', { tool: 'dns', input: { domain: 'example.com' } }, { as: 'ada' });
        assert.deepStrictEqual(JSON.parse(textOf(ran)), { a: ['93.184.215.14'] });
        assert.deepStrictEqual([runs[0].path, runs[0].auth, runs[0].body.input.domain, runs[0].body.wait_ms], ['/api/v1/tools/dns/run', 'Bearer ada', 'example.com', 30000]);
        const refused = await call('run_tool', { tool: 'broken', input: {} });
        assert.deepStrictEqual([refused.result.isError, textOf(refused)], [true, 'input.domain is required'], 'the run\'s own words');
        const made = await call('run_tool', { tool: OWN, input: { message: 'hi' } }, { as: 'ada' });
        assert.strictEqual(textOf(made), '{"reply":"Thanks!"}');
        assert.strictEqual(runs[runs.length - 1].path, `/api/v1/made-tools/${OWN}/run`, 'a made tool runs at its own path');
        assert.strictEqual((await call('run_tool', { tool: '../../etc' })).result.isError, true, 'a tool id is checked before it reaches a path');

        // run_tools: in parallel, each answer under its call.
        const both = JSON.parse(textOf(await call('run_tools', { calls: [{ tool: 'dns', input: { domain: 'a.example' } }, { tool: 'hash', input: { text: 'x' } }, { tool: PUB, input: {} }] })));
        assert.deepStrictEqual(both.map((b) => [b.tool, b.ok]), [['dns', true], ['hash', true], [PUB, false]]);
        assert.strictEqual(both[1].result, 'abc123', 'a text result is its text');

        // Your own tool by name.
        assert.strictEqual(textOf(await call('made_reply_kindly', { message: 'hi' }, { as: 'ada' })), '{"reply":"Thanks!"}');
        assert.strictEqual((await call('made_reply_kindly', {})).result.isError, true, 'signed out: no own tools');

        // automate_tool: a schedule or a private link on any tool, as the caller; my_automations lists them.
        const daily = await call('automate_tool', { tool: 'dns', kind: 'schedule', every: 'day', at: '09:00', input: { domain: 'example.com' } }, { as: 'ada' });
        assert.ok(!daily.result.isError, textOf(daily));
        const dailyOut = JSON.parse(textOf(daily));
        assert.deepStrictEqual([dailyOut.automation.says, dailyOut.automation.notify, dailyOut.page], ['Every day at 09:00 UTC', true, 'https://openvibe.tools/make#automate=dns']);
        const sentTrigger = runs.filter((r) => r.path === '/api/v1/tools/dns/triggers').pop();
        assert.deepStrictEqual([sentTrigger.auth, sentTrigger.body], ['Bearer ada', { kind: 'schedule', every: 'day', at: '09:00', input: { domain: 'example.com' } }], 'as the caller, their input');
        const linkOut = JSON.parse(textOf(await call('automate_tool', { tool: 'dns', kind: 'link' }, { as: 'ada' })));
        assert.strictEqual(linkOut.url, 'https://openvibe.tools/hooks/mth_secret', 'the link, once');
        const probe = await call('automate_tool', { tool: 'portscan', kind: 'link' }, { as: 'ada' });
        assert.deepStrictEqual([probe.result.isError, /signed in/.test(textOf(probe))], [true, true], 'a refusal in its own words');
        assert.match(textOf(await call('automate_tool', { tool: 'dns', kind: 'link' })), /Sign in/, 'signed in only');
        assert.match(textOf(await call('automate_tool', { tool: '../etc', kind: 'link' }, { as: 'ada' })), /No tool is called/);
        const listed = JSON.parse(textOf(await call('my_automations', {}, { as: 'ada' })));
        assert.deepStrictEqual([listed.count, listed.automations[0].tool_name, listed.automations[0].runs], [1, 'DNS lookup', 3]);
        assert.match(textOf(await call('my_automations', {})), /Sign in/);

        // make_tool: drafted and saved as the caller, private; the slug they already use gets a suffix.
        const before = runs.length;
        const madeNew = await call('make_tool', { description: 'Add sales tax to a price', kind: 'code' }, { as: 'ada' });
        assert.ok(!madeNew.result.isError, textOf(madeNew));
        const told = JSON.parse(textOf(madeNew));
        assert.deepStrictEqual([told.made.id, told.made.kind, told.made.visibility, told.page], ['mtl_01JCZ3NDEKTSV4RRFFQ69G5FA9', 'code', 'private', 'https://openvibe.tools/make#mtl_01JCZ3NDEKTSV4RRFFQ69G5FA9']);
        const calls = runs.slice(before);
        assert.deepStrictEqual(calls.map((c) => [c.path, c.auth]), [['/api/v1/made-tools/draft', 'Bearer ada'], ['/api/v1/made-tools', 'Bearer ada'], ['/api/v1/made-tools', 'Bearer ada']], 'drafted, then saved twice (the slug was taken), all as the caller');
        assert.deepStrictEqual([calls[0].body, calls[2].body.visibility], [{ description: 'Add sales tax to a price', kind: 'code' }, 'private']);
        assert.match(calls[2].body.slug, /^price-with-tax-[a-z0-9]{1,4}$/);
        const anonMake = await call('make_tool', { description: 'Add sales tax to a price' });
        assert.deepStrictEqual([anonMake.result.isError, /Sign in/.test(textOf(anonMake))], [true, true], 'signed out: sign in to make one');
        assert.strictEqual((await call('make_tool', { description: 'short' }, { as: 'ada' })).result.isError, true, 'a description says something');

        // bring_tool: converted and saved as the caller, private, with what could not come along said.
        const b0 = runs.length;
        const brought = await call('bring_tool', { from: 'valtown', url: 'https://www.val.town/v/ada/greet' }, { as: 'ada' });
        assert.ok(!brought.result.isError, textOf(brought));
        const bt = JSON.parse(textOf(brought));
        assert.deepStrictEqual([bt.made.kind, bt.made.visibility, bt.notes.length], ['code', 'private', 1]);
        assert.deepStrictEqual(runs.slice(b0).map((c) => [c.path, c.auth]), [['/api/v1/made-tools/import/val', 'Bearer ada'], ['/api/v1/made-tools', 'Bearer ada']]);
        const pd = await call('bring_tool', { from: 'pipedream', code: 'export default defineComponent({ async run() { return 1; } })', name: 'one' }, { as: 'ada' });
        assert.ok(!pd.result.isError, textOf(pd));
        assert.strictEqual(runs[runs.length - 2].path, '/api/v1/made-tools/import/pipedream');
        const pk = await call('bring_tool', { from: 'valtown', url: 'https://www.val.town/v/ada/pkgs' }, { as: 'ada' });
        assert.deepStrictEqual([pk.result.isError, /npm:zod/.test(textOf(pk))], [true, true], 'a package it imports is named');
        assert.strictEqual((await call('bring_tool', { from: 'pipedream' }, { as: 'ada' })).result.isError, true, 'a step needs its code');
        const anonBring = await call('bring_tool', { from: 'valtown', url: 'https://www.val.town/v/ada/greet' });
        assert.deepStrictEqual([anonBring.result.isError, /Sign in/.test(textOf(anonBring))], [true, true]);

        assert.strictEqual((await rpc('resources/list')).body.error.code, -32601);
        assert.strictEqual((await call('nope', {})).error.code, -32602);
        const bad = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[]' });
        assert.strictEqual(bad.status, 400);

        // MCP 2026-07-28 (stateless; 2026-11-16, openvibe-sdk/mcp): the version and the method on every request,
        // server/discover, resultType on every result, the tool list (yours too) private; the handshake above still works.
        const mcpKit = require('openvibe-sdk/mcp');
        const modern = async (method, params = {}, extra = {}) => {
            const built = mcpKit.modernRequest({ id: 70, method, params, clientInfo: { name: 'test', version: '1' } });
            const r = await fetch(base, { method: 'POST', headers: { ...built.headers, ...extra }, body: JSON.stringify(built.body) });
            return { status: r.status, body: await r.json() };
        };
        let m = await modern('server/discover');
        assert.deepStrictEqual([m.status, m.body.result.resultType, m.body.result.cacheScope], [200, 'complete', 'public']);
        assert.ok(m.body.result.supportedVersions.includes('2026-07-28') && m.body.result.supportedVersions.includes('2025-11-25'));
        assert.match(m.body.result.instructions, /OpenVibe Tools/);
        // run_code (code mode, plan §AD.26): a script calls run() and find() as the caller and returns only what it needs.
        assert.match(textOf(await call('run_code', { code: 'return 1' })), /Sign in to run code/, 'a script needs a sign-in');
        let hasCodeMode = true;
        try { require.resolve('openvibe-sdk/code-mode'); } catch { hasCodeMode = false; }
        if (hasCodeMode) {
            const before = runs.length;
            const coded = await call('run_code', { code: "const d = await run('dns', { domain: 'example.com' }); const h = await run('hash', { text: 'x' }); let bad; try { await run('broken', {}); } catch (e) { bad = e.message; } const f = await find('dns lookup'); console.log('found', Array.isArray(f)); return { a: d.a[0], h, bad };" }, { as: 'ada' });
            const body = JSON.parse(textOf(coded));
            assert.deepStrictEqual(body.result, { a: '93.184.215.14', h: 'abc123', bad: 'input.domain is required' }, JSON.stringify(body));
            assert.deepStrictEqual(body.logs, ['found true']);
            assert.deepStrictEqual(runs.slice(before).map((r) => [r.path, r.auth]), [['/api/v1/tools/dns/run', 'Bearer ada'], ['/api/v1/tools/hash/run', 'Bearer ada'], ['/api/v1/tools/broken/run', 'Bearer ada']], 'each run as the caller, through the run API');
            assert.strictEqual(JSON.parse(textOf(await call('run_code', { code: 'return typeof process' }, { as: 'ada' }))).result, 'undefined', 'the sandbox holds');
            const thrown = await call('run_code', { code: "await run('broken', {});" }, { as: 'ada' });
            assert.deepStrictEqual([thrown.result.isError, JSON.parse(textOf(thrown)).error], [true, 'input.domain is required']);
        } else console.log('  (run_code\'s scripts run with openvibe-sdk 0.183.0)');
        m = await modern('tools/list');
        assert.deepStrictEqual([m.status, m.body.result.resultType, m.body.result.cacheScope], [200, 'complete', 'private']);
        assert.ok(m.body.result.tools.some((t) => t.name === 'find_tools'));
        m = await modern('tools/call', { name: 'find_tools', arguments: { need: 'qr code' } });
        assert.deepStrictEqual([m.status, m.body.result.resultType], [200, 'complete']);
        m = await modern('tools/call', { name: 'find_tools', arguments: { need: 'qr code' } }, { 'Mcp-Name': 'run_tool' });
        assert.deepStrictEqual([m.status, m.body.error.code], [400, -32020], 'a header that disagrees is refused');
        m = await modern('resources/list');
        assert.deepStrictEqual([m.status, m.body.error.code], [404, -32601], 'an unknown method is a 404');
    } finally {
        server.close(); api.close();
    }
    console.log('tools mcp: initialize, find_tools (catalogue and made, private stays private), run_tool and run_tools through the run API as the caller, make_tool drafts and saves as the caller, bring_tool converts and saves as the caller, own tools by name');
})().catch((err) => { console.error(err); process.exit(1); });
