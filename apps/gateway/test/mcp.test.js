'use strict';
// POST /mcp (plan 2026-11-13 §AD.12 (a)): every tool to any agent over MCP's Streamable HTTP transport.
//   - initialize names the server and echoes a protocol it speaks; a notification gets 202 and no body;
//   - tools/list is find_tools, run_tool and run_tools, then the signed-in person's own made tools by name;
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
        assert.deepStrictEqual(anon, ['find_tools', 'run_tool', 'run_tools']);
        const mine = (await rpc('tools/list', null, { as: 'ada' })).body.result.tools;
        assert.deepStrictEqual(mine.map((t) => t.name), ['find_tools', 'run_tool', 'run_tools', 'made_reply_kindly']);
        assert.deepStrictEqual(mine[3].inputSchema, { type: 'object', properties: { message: { type: 'string' } } }, 'your tool with its own input schema');

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

        assert.strictEqual((await rpc('resources/list')).body.error.code, -32601);
        assert.strictEqual((await call('nope', {})).error.code, -32602);
        const bad = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[]' });
        assert.strictEqual(bad.status, 400);
    } finally {
        server.close(); api.close();
    }
    console.log('tools mcp: initialize, find_tools (catalogue and made, private stays private), run_tool and run_tools through the run API as the caller, own tools by name');
})().catch((err) => { console.error(err); process.exit(1); });
