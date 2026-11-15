'use strict';
// Bring a val from Val Town (server/made/import-val.js, POST /api/v1/made-tools/import/val; plan §AD.12: Val Town closes
// 2027-01-10). Against a fake Val Town API:
//   - a script val in TypeScript becomes a code tool's draft: one input per parameter, and the converted tool, run the
//     way a Link runs it (entryOf, node, input on stdin), answers what the val answered;
//   - the vals it imports come along (each a module of its own); a package import, an email val and a circle refuse
//     with the reason; Deno.env answers undefined and says so; fetch() makes it a tool of the public internet;
//   - an http val answers a Request with the Response's status, type and body; an interval val notes its schedule;
//   - pasted code works without Val Town; the address must be a val's; signed out is refused; 20 a person at a time.
//
//   node test/made-import-val.test.js
const assert = require('assert');
const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createMadeToolRoutes } = require('../server/made/routes');
const { convertVal, parseValRef } = require('../server/made/import-val');
const { entryOf } = require('../server/made/code');

const ADA = 'usr_01HZY8M9J3K4N5P6Q7R8S9T0VW';
const ORIGIN = 'https://openvibe.tools';

/** The converted tool run the way a Link runs it: tool.js (entryOf), the input on stdin, one JSON value on stdout. */
function runTool(source, input) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-val-'));
    try {
        fs.writeFileSync(path.join(dir, 'tool.js'), entryOf(source));
        return JSON.parse(execFileSync(process.execPath, [path.join(dir, 'tool.js')], { input: JSON.stringify(input), timeout: 20000 }).toString());
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// Val Town's public API, faked: GET /v1/alias/<user>/<name> → the val.
const VALS = {
    'ada/greet': { type: 'script', code: `import { shout } from "https://esm.town/v/ada/shout";
import { createHash } from "node:crypto";
interface Options { excited?: boolean }
export async function greet(name: string, options: Options = {}): Promise<{ text: string; id: string }> {
    const text = \`Hello, \${name}\${options.excited ? '!' : '.'}\`;
    return { text: shout(text), id: createHash('sha256').update(name).digest('hex').slice(0, 8), key: Deno.env.get('KEY') ?? null };
}` },
    'ada/shout': { type: 'script', code: 'import { tail } from "https://esm.town/v/ada/tail?v=3";\nexport const shout = (s: string): string => s.toUpperCase() + tail;' },
    'ada/tail': { type: 'script', code: 'export const tail: string = " ~";' },
    'ada/web': { type: 'http', code: 'export default async function (req: Request): Promise<Response> {\n  const u = new URL(req.url);\n  return Response.json({ path: u.pathname, method: req.method, body: await req.text() });\n}' },
    'ada/tick': { type: 'interval', code: 'export default async function (interval: Interval) { return { ran: true, last: interval.lastRunAt ? interval.lastRunAt.toISOString() : null }; }' },
    'ada/pkgs': { type: 'script', code: 'import { z } from "npm:zod";\nexport const check = (x) => z.string().parse(x);' },
    'ada/mail': { type: 'email', code: 'export default async function (e: Email) { console.log(e.from); }' },
    'ada/loop1': { type: 'script', code: 'import { b } from "https://esm.town/v/ada/loop2";\nexport const a = () => b;' },
    'ada/loop2': { type: 'script', code: 'import { a } from "https://esm.town/v/ada/loop1";\nexport const b = () => a;' },
    'ada/fetcher': { type: 'script', code: 'export async function get(url: string) { return (await fetch(url)).status; }' },
};
const valFetch = async (url) => {
    const m = String(url).match(/^https:\/\/api\.val\.town\/v1\/alias\/([^/]+)\/([^/?]+)$/);
    const v = m && VALS[`${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`];
    if (!v) return new Response(JSON.stringify({ error: 'Could not find that val' }), { status: 404 });
    const [user, name] = [decodeURIComponent(m[1]), decodeURIComponent(m[2])];
    return new Response(JSON.stringify({ name, type: v.type, version: 3, code: v.code, url: `https://www.val.town/v/${user}/${name}`, author: { username: user } }), { status: 200 });
};

(async () => {
    // Addresses.
    assert.deepStrictEqual(parseValRef('https://www.val.town/v/ada/greet'), { user: 'ada', name: 'greet' });
    assert.deepStrictEqual(parseValRef('https://esm.town/v/ada/greet?v=4'), { user: 'ada', name: 'greet' });
    assert.deepStrictEqual(parseValRef('@ada/greet'), { user: 'ada', name: 'greet' });
    assert.strictEqual(parseValRef('https://evil.example/v/ada/greet'), null);
    assert.strictEqual(parseValRef('ada/../../etc'), null);

    // Pasted code, no Val Town: a TypeScript script val runs as a tool, its parameters the inputs.
    const add = await convertVal({ code: 'export function add(a: number, b: number): number { return Number(a) + Number(b); }', name: 'add' });
    assert.deepStrictEqual(add.draft.inputs.map((i) => i.label), ['A', 'B']);
    assert.strictEqual(add.net, 'deny');
    assert.strictEqual(runTool(add.draft.source, { a: '2', b: '40' }), 42);
    // A val that imports another val needs Val Town to bring it.
    await assert.rejects(convertVal({ code: VALS['ada/greet'].code, name: 'greet' }), (e) => e.code === 'tools.made.val_imports');

    const app = express();
    let server;
    app.use('/api/v1/made-tools', createMadeToolRoutes({
        store: {}, runner: null, origin: ORIGIN, // nothing is saved: a draft only log: { error() {}, log() {} },
        verify: async (t) => ({ ada: { sub: ADA, username: 'ada' } }[t] || null),
        extractToken: (req) => (req.headers.authorization || '').replace(/^Bearer /, '') || null,
        Ajv: require('ajv'), valFetch, address: () => server.address(),
    }));
    server = http.createServer(app).listen(0);
    const base = `http://127.0.0.1:${server.address().port}/api/v1/made-tools`;
    const bring = async (body, as = 'ada') => {
        const res = await fetch(`${base}/import/val`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${as}` } : {}) }, body: JSON.stringify(body) });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    try {
        assert.strictEqual((await bring({ url: 'https://www.val.town/v/ada/greet' }, null)).status, 401, 'signed out');

        // A script val with two vals it imports (one through another), node:crypto, an interface and Deno.env.
        const g = await bring({ url: 'https://www.val.town/v/ada/greet' });
        assert.strictEqual(g.status, 200, JSON.stringify(g.body));
        assert.deepStrictEqual(g.body.draft.inputs.map((i) => i.label), ['Name', 'Options']);
        assert.strictEqual(g.body.body.kind, 'code');
        assert.strictEqual(g.body.body.net, 'deny');
        assert.ok(g.body.notes.some((n) => /2 vals \(ada\/tail, ada\/shout\)/.test(n)), JSON.stringify(g.body.notes));
        assert.ok(g.body.notes.some((n) => /Deno\.env/.test(n)));
        const said = runTool(g.body.draft.source, { name: 'Bo', options: '{"excited":true}' });
        assert.deepStrictEqual(said, { text: 'HELLO, BO! ~', id: crypto.createHash('sha256').update('Bo').digest('hex').slice(0, 8), key: null });

        // An http val: a Request in, the Response's status, type and body out.
        const w = await bring({ url: '@ada/web' });
        assert.strictEqual(w.status, 200);
        assert.deepStrictEqual(w.body.draft.inputs.map((i) => i.label), ['Method', 'Path', 'Body']);
        assert.strictEqual(w.body.body.output.kind, 'json');
        const page = runTool(w.body.draft.source, { method: 'post', path: 'hello', body: 'hi' });
        assert.deepStrictEqual({ ...page, body: JSON.parse(page.body) }, { status: '200', content_type: 'application/json', body: { path: '/hello', method: 'POST', body: 'hi' } });

        // An interval val: run with lastRunAt, and a note about its schedule.
        const t = await bring({ url: 'ada/tick' });
        assert.strictEqual(t.status, 200);
        assert.ok(t.body.notes.some((n) => /schedule/.test(n)));
        assert.deepStrictEqual(runTool(t.body.draft.source, { last_run_at: '2026-11-15T10:00:00.000Z' }), { ran: true, last: '2026-11-15T10:00:00.000Z' });

        // fetch(): a tool of the public internet.
        const f = await bring({ url: 'ada/fetcher' });
        assert.strictEqual(f.body.body.net, 'public');

        // Refusals, each with its reason.
        const pk = await bring({ url: 'ada/pkgs' });
        assert.deepStrictEqual([pk.status, pk.body.code], [422, 'tools.made.val_imports']);
        assert.match(pk.body.detail, /npm:zod/);
        const ml = await bring({ url: 'ada/mail' });
        assert.deepStrictEqual([ml.status, ml.body.code], [422, 'tools.made.val_email']);
        const lp = await bring({ url: 'ada/loop1' });
        assert.deepStrictEqual([lp.status, lp.body.code], [422, 'tools.made.val_imports']);
        assert.match(lp.body.detail, /circle/);
        const nf = await bring({ url: 'ada/nothing' });
        assert.deepStrictEqual([nf.status, nf.body.code], [404, 'tools.made.val_not_found']);
        const bad = await bring({ url: 'https://example.com/whatever' });
        assert.deepStrictEqual([bad.status, bad.body.code], [422, 'tools.made.invalid']);

        // Pasted code through the API.
        const pasted = await bring({ code: 'export const double = (n: number) => n * 2;', name: 'double' });
        assert.strictEqual(pasted.status, 200);
        assert.strictEqual(runTool(pasted.body.draft.source, { n: 21 }), 42);

        // 20 a person each ten minutes: ten above, ten more pass, the next is refused.
        let last;
        for (let i = 0; i < 11; i++) last = await bring({ code: 'export const one = () => 1;', name: 'one' });
        assert.deepStrictEqual([last.status, last.body.code], [429, 'tools.made.slow_down']);
    } finally {
        server.close();
    }
    console.log('made-import-val: script, http and interval vals as code tools that run; imported vals inlined; packages, email and circles refused; Deno.env and fetch said; pasted code; signed out and too many refused');
})().catch((err) => { console.error(err); process.exit(1); });
