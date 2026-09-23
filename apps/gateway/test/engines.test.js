'use strict';
// Server engines for browser tools (ADR-027): every descriptor with api true that is answered inline
// without a server route (execution client) names an engine that plain Node can require and run.
//   • a fresh `node` process, with no DOM and no polyfills, requires each engines module and runs each
//     tool's example input; its answer has the descriptor's output kind and matches its output schema
//   • the engines are the pages' own code: a few spot checks that the API answers what the page shows
//   • the engines refuse what they must (a diff too long, JSON that does not parse)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-engines-'));
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const reg = require('../server/registry/descriptors');

const ajv = new Ajv2020({ strict: true, strictRequired: false, allowUnionTypes: true, allErrors: true });
addFormats(ajv);

const snap = reg.snapshot();
const engineTools = snap.tools.filter(d => d.api && d.execution === 'client');
assert.ok(engineTools.length >= 40, `browser tools with a server engine: ${engineTools.length}`);

// Which module and which export: every such tool names one, and the module is one of the known engine files.
const jobsFor = engineTools.map(d => {
    const s = reg.internal(d.id);
    assert.ok(s.engines, `${d.id}: its app has an engines module`);
    assert.ok(s.spec.engine, `${d.id}: names its engine`);
    return { id: d.id, module: s.engines, name: s.spec.engine, input: s.spec.example.input };
});
// Client tools without an API have no engine; nothing else names one.
for (const d of snap.tools.filter(x => !(x.api && x.execution === 'client'))) assert.ok(!reg.internal(d.id).spec.engine, `${d.id}: only API browser tools name an engine`);

// ── Plain Node: require every engines module and run every example in a fresh process ──
const child = `
const jobs = JSON.parse(process.argv[1]);
(async () => {
    const out = {};
    for (const j of jobs) {
        try {
            const mod = require(j.module);
            const fn = (mod.ENGINES || {})[j.name];
            if (typeof fn !== 'function') { out[j.id] = { missing: true }; continue; }
            out[j.id] = { result: await fn(JSON.parse(JSON.stringify(j.input))) };
        } catch (err) { out[j.id] = { error: err.message }; }
    }
    process.stdout.write(JSON.stringify(out));
})();`;
const r = spawnSync(process.execPath, ['-e', child, JSON.stringify(jobsFor)], { encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 30_000 });
assert.strictEqual(r.status, 0, r.stderr);
const results = JSON.parse(r.stdout);
for (const d of engineTools) {
    const got = results[d.id];
    assert.ok(got && !got.missing, `${d.id}: the engine exists`);
    assert.ok(!got.error, `${d.id}: the example runs (${got.error})`);
    if (d.output.kind === 'text') {
        assert.ok(typeof got.result.text === 'string' && !('data' in got.result), `${d.id}: answers { text }`);
    } else {
        assert.strictEqual(d.output.kind, 'json');
        assert.ok(got.result.data && typeof got.result.data === 'object' && !('text' in got.result), `${d.id}: answers { data }`);
        const validate = ajv.compile(d.output.schema);
        assert.ok(validate(got.result.data), `${d.id}: output matches its schema: ${JSON.stringify(validate.errors)}`);
    }
}

// ── The pages run the same engines (so the page and the API cannot drift apart) ──
{
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'dev.html'), 'utf8');
    const engineTag = html.indexOf('<script src="/js/dev-engine.js"></script>');
    assert.ok(engineTag > 0 && engineTag < html.indexOf("const API='https://openvibe.tools/api/dev'"), 'dev.html loads the engine before its own script');
    for (const d of engineTools.filter(x => x.family === 'dev')) {
        const at = html.search(new RegExp(`^P\\.${d.id}=`, 'm'));
        const block = at < 0 ? '' : html.slice(at, html.indexOf('\nP.', at + 1));
        assert.match(block, /DevEngine\./, `dev.html's P.${d.id} runs DevEngine`);
    }
    const { HOSTNAME_MAP } = require('../../text/server/hosts');
    for (const d of engineTools.filter(x => x.family === 'text')) {
        const page = fs.readFileSync(path.join(__dirname, '..', '..', 'text', 'public', HOSTNAME_MAP[`${d.id}.openvibe.tools`]), 'utf8');
        assert.ok(/<script src="\/js\/(text|format)-engine\.js"><\/script>/.test(page), `${d.id}: its page loads the engine the API runs`);
    }
}

// ── The pages' own transforms: spot checks ──
const dev = require('../server/dev/engines').ENGINES;
const text = require('../../text/server/engines').ENGINES;
(async () => {
    assert.strictEqual(dev.jsonminify({ text: '{\n "a": [1, 2]\n}' }).text, '{"a":[1,2]}');
    assert.strictEqual(dev.base64({ text: 'hé ✓', mode: 'encode' }).text, 'aMOpIOKckw==');
    assert.strictEqual(dev.base64({ text: 'aMOpIOKckw==', mode: 'decode' }).text, 'hé ✓');
    assert.strictEqual(dev.cssminify({ text: '.a { color: #aabbcc; margin: 0px; }' }).text, '.a{color:#abc;margin:0}');
    assert.strictEqual((await dev.hash({ text: 'abc', algorithm: 'SHA-256' })).data.hex, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.deepStrictEqual(dev.csv({ text: 'a,b\n"1,2",3' }).data.rows, [{ a: '1,2', b: '3' }]);
    assert.deepStrictEqual(dev.jsonvalidate({ text: '{"a":1,}' }).data.valid, false, 'invalid JSON is an answer, not a failure');
    assert.match(dev.jsonvalidate({ text: '{"a":1,}' }).data.error, /trailing comma/);
    assert.throws(() => dev.jsonminify({ text: '{' }), /Line 1/, 'a transform that cannot read its input throws (the run fails with the message)');
    assert.strictEqual(dev.jwt({ token: 'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjF9.x' }).data.expired, true);
    assert.strictEqual(dev.uuid({ mode: 'validate', text: '123e4567-e89b-42d3-a456-426614174000' }).data.valid, true);
    assert.strictEqual(dev.uuid({ count: 3 }).data.uuids.length, 3);
    assert.strictEqual(dev.yaml({ text: 'a: 1\nb: true' }).text, '{\n  "a": 1,\n  "b": true\n}');
    assert.strictEqual(dev.minify({ text: '<a>  <b>x</b> </a>', language: 'html' }).text, '<a><b>x</b></a>');

    assert.strictEqual(text.case({ text: 'hello big world', to: 'camel' }).text, 'helloBigWorld');
    assert.strictEqual(text.slug({ text: 'Crème Brûlée, 2 ways!' }).text, 'creme-brulee-2-ways');
    assert.strictEqual(text.braille({ text: text.braille({ text: 'hi 42!' }).text, mode: 'decode' }).text, 'hi 42!', 'braille round trip');
    assert.strictEqual(text.binary({ text: 'Az', to: 'hex' }).text, '41 7A');
    assert.strictEqual(text.escape({ text: '<b>&</b>', transform: 'htmlEscape' }).text, '&lt;b&gt;&amp;&lt;/b&gt;');
    assert.strictEqual(text.clean({ text: 'a\u200b  “b”' }).text, 'a "b"', 'the cleaner\'s default steps');
    assert.strictEqual(text.clean({ text: 'a\u200b', invisible: false }).text, 'a\u200b');
    assert.deepStrictEqual(text.fancy({ text: 'ab', styles: ['bold'] }).data.styles, [{ id: 'bold', name: 'Bold', text: '𝐚𝐛' }]);
    assert.strictEqual(text.bubble({ text: 'x' }).data.styles.length, 5);
    assert.strictEqual(text.json({ text: '{"b":1,"a":{"d":2,"c":3}}', mode: 'sort-keys', indent: 0 }).text, '{"a":{"c":3,"d":2},"b":1}');
    assert.deepStrictEqual(text.compare({ a: 'x\ny', b: 'x\nz' }).data, { lines: [{ type: 'same', text: 'x' }, { type: 'del', text: 'y' }, { type: 'add', text: 'z' }], added: 1, removed: 1, unchanged: 1 });
    assert.throws(() => text.compare({ a: 'x\n'.repeat(2500), b: 'y' }), (e) => e.status === 422 && /at most 2000 lines/.test(e.message), 'a diff too big for the server is refused');
    assert.deepStrictEqual(text.unicode({ text: '\u200b' }).data.characters[0], { char: '\u200b', codePoint: 'U+200B', hex: '0x200B', utf8Bytes: 3, category: 'Invisible', invisible: true });
    assert.deepStrictEqual(Object.keys(text.kaomoji({ mood: 'shrug' }).data.moods), ['shrug']);

    fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
    console.log(`engines: ${engineTools.length} browser tools run in plain Node (${engineTools.filter(d => d.family === 'dev').length} dev, ${engineTools.filter(d => d.family === 'text').length} text), outputs match their schemas`);
})().catch((err) => { console.error(err); process.exit(1); });
