'use strict';
// Bring a Pipedream code step (server/made/import-pipedream.js, POST /api/v1/made-tools/import/pipedream; plan §AD.12:
// Pipedream Workflows close 2027-03-31):
//   - a Node.js step becomes a code tool's draft: one input per prop (integer → number, object → JSON text), Steps when
//     it reads earlier steps; the converted tool, run the way a Link runs it, calls run({ steps, $ }) with the props as
//     `this` and its methods, answers its return value or its $.export()s, and stops at $.flow.exit();
//   - @pipedream/platform's axios goes through fetch (the tool uses the public internet); other packages and Python
//     steps refuse; an app prop is noted; the props are read as a literal, never run (an expression in one is skipped);
//   - the route answers like /import/val; signed out is refused.
//
//   node test/made-import-pipedream.test.js
const assert = require('assert');
const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createMadeToolRoutes } = require('../server/made/routes');
const { convertPipedream, propsOf } = require('../server/made/import-pipedream');
const { entryOf } = require('../server/made/code');

function runTool(source, input) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-pd-'));
    try {
        fs.writeFileSync(path.join(dir, 'tool.js'), entryOf(source));
        return JSON.parse(execFileSync(process.execPath, [path.join(dir, 'tool.js')], { input: JSON.stringify(input), timeout: 20000 }).toString());
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

const STEP = `import { createHash } from "crypto";
export default defineComponent({
  props: {
    slack: { type: "app", app: "slack" },
    city: { type: "string", label: "City", default: "Lisbon" },
    count: { type: "integer", label: "How many", default: 2 },
    extra: { type: "object", label: "Extra" },
  },
  methods: {
    greet(name) { return \`Hello, \${name}\`; },
  },
  async run({ steps, $ }) {
    $.export("id", createHash("sha256").update(this.city).digest("hex").slice(0, 6));
    $.summary = "greeted " + this.city;
    return { text: this.greet(this.city).repeat(this.count), extra: this.extra, from: steps.trigger && steps.trigger.event.who };
  },
})`;

(async () => {
    // The props, read as a literal: an expression is skipped, never run.
    let ran = false;
    global.__pdRan = () => { ran = true; };
    const props = propsOf('defineComponent({ props: { a: { type: "string", default: (() => global.__pdRan())() }, b: { type: "integer", label: "B", default: 4 } } })');
    assert.deepStrictEqual(props, { a: { type: 'string' }, b: { type: 'integer', label: 'B', default: 4 } });
    assert.strictEqual(ran, false, 'nothing in the props ran');

    const out = convertPipedream({ code: STEP, name: 'greet-city' });
    assert.deepStrictEqual(out.draft.inputs, [{ label: 'City', kind: 'short' }, { label: 'How many', kind: 'number' }, { label: 'Extra', kind: 'long' }, { label: 'Steps', kind: 'long' }]);
    assert.strictEqual(out.net, 'deny');
    assert.ok(out.notes.some((n) => /slack through a connected account/.test(n)), JSON.stringify(out.notes));
    const said = runTool(out.draft.source, { city: 'Porto', how_many: 2, extra: '{"x":1}', steps: '{"trigger":{"event":{"who":"bo"}}}' });
    assert.deepStrictEqual(said, { id: require('crypto').createHash('sha256').update('Porto').digest('hex').slice(0, 6), $summary: 'greeted Porto', $return_value: { text: 'Hello, PortoHello, Porto', extra: { x: 1 }, from: 'bo' } });
    // A default stands in for an input left out.
    assert.strictEqual(runTool(out.draft.source, {}).$return_value.text, 'Hello, LisbonHello, Lisbon');

    // $.flow.exit() ends it with what was exported.
    const exit = convertPipedream({ code: 'export default defineComponent({ async run({ steps, $ }) { $.export("a", 1); return $.flow.exit("nothing to do"); } })' });
    assert.deepStrictEqual(runTool(exit.draft.source, {}), { a: 1, $summary: 'nothing to do', $return_value: null });

    // axios from @pipedream/platform: through fetch, so the public internet.
    const ax = convertPipedream({ code: 'import { axios } from "@pipedream/platform";\nexport default defineComponent({ async run({ $ }) { return await axios($, { url: "https://example.com" }); } })' });
    assert.strictEqual(ax.net, 'public');
    assert.match(ax.draft.source, /async function axios\(\$, config\)/);

    // Refusals.
    assert.throws(() => convertPipedream({ code: 'import _ from "lodash";\nexport default defineComponent({ async run() { return _.chunk([1, 2], 1); } })' }), (e) => e.code === 'tools.made.val_imports' && /lodash/.test(e.message));
    assert.throws(() => convertPipedream({ code: 'def handler(pd: "pipedream"):\n    return 1' }), (e) => e.code === 'tools.made.pd_python');
    assert.throws(() => convertPipedream({ code: 'console.log(1)' }), (e) => e.code === 'tools.made.invalid');

    // The route.
    const app = express();
    app.use('/api/v1/made-tools', createMadeToolRoutes({
        store: {}, runner: null, origin: 'https://openvibe.tools', log: { error() {}, log() {} },
        verify: async (t) => (t === 'ada' ? { sub: 'usr_01HZY8M9J3K4N5P6Q7R8S9T0VW', username: 'ada' } : null),
        extractToken: (req) => (req.headers.authorization || '').replace(/^Bearer /, '') || null,
        Ajv: require('ajv'),
    }));
    const server = http.createServer(app).listen(0);
    try {
        const call = async (as) => {
            const res = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/made-tools/import/pipedream`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(as ? { Authorization: `Bearer ${as}` } : {}) }, body: JSON.stringify({ code: STEP, name: 'greet city' }) });
            return { status: res.status, body: await res.json().catch(() => null) };
        };
        assert.strictEqual((await call(null)).status, 401);
        const r = await call('ada');
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual([r.body.body.kind, r.body.body.net, r.body.draft.name], ['code', 'deny', 'Greet city']);
    } finally {
        server.close();
    }
    console.log('made-import-pipedream: props as inputs (read, never run), run({ steps, $ }) with this and methods, exports, flow.exit and defaults; axios through fetch; packages and Python refused; the route');
})().catch((err) => { console.error(err); process.exit(1); });
