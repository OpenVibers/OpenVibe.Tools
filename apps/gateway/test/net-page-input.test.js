'use strict';
// net.html builds each run's input from the tool's descriptor (plan T8 review): every net tool's input
// schema has additionalProperties: false, so the page must send only what that schema declares — no
// `types` to mx./txt./ns./spf./dkim./dmarc. (their descriptor adds the query), no `count` to latency.,
// and the plain domain to dkim. and dmarc. (the descriptor's route builds _dmarc.<d> and
// <selector>._domainkey.<d>; a page that prefixed too asked for _dmarc._dmarc.<d>). The page's own
// runFields/runInput are evaluated here against every descriptor's real schema with the run API's Ajv.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { SPECS } = require('../server/net/descriptors');
const { schemaDoc } = require('../../_shared/tools/descriptor');
const { ajvFrom, createInputValidator } = require('../../_shared/tools/run');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'net.html'), 'utf8');
const slice = (from, to) => { const a = html.indexOf(from), b = html.indexOf(to, a); assert.ok(a >= 0 && b > a, `net.html: ${from}`); return html.slice(a, b); };
const TOOLS = new Function(`${slice('const TOOLS = {', 'const CATS = {')}; return TOOLS;`)();
const { runFields, runInput } = new Function(`${slice('function runFields(', '// ── Run the active tool')}; return { runFields, runInput };`)();

const { Ajv, addFormats } = ajvFrom(require);
const validate = createInputValidator(Ajv, addFormats);

let checked = 0;
for (const d of SPECS) {
    if (!d.api || !d.input) continue;
    const tool = TOOLS[d.id];
    assert.ok(tool, `net.html has ${d.id}`);
    // Everything the page's options could hold for this tool (the UI's own values).
    const ui = {
        target: 'example.com',
        types: tool.dnsTypes ? ['A', 'MX'] : undefined,
        selector: d.id === 'dkim' ? 's1' : undefined,
        propType: tool.propTypes ? 'MX' : undefined,
        smtpPort: tool.smtpPorts ? '587' : undefined,
        robotsPath: tool.robotsTest ? '/private' : undefined,
        robotsUa: tool.robotsTest ? 'GPTBot' : undefined,
    };
    const input = runInput(schemaDoc(d).$defs.input, runFields(tool, ui));
    assert.deepStrictEqual(validate(d, input), [], `${d.id}: the page's input ${JSON.stringify(input)} passes its schema`);
    if (d.input.required && d.input.required.includes('target')) assert.strictEqual(input.target, 'example.com', `${d.id}: the plain target (the descriptor builds any prefix)`);
    checked++;
}
assert.ok(checked > 25, `every net tool with an API (${checked})`);

// The specific cases the old page got wrong.
const one = (id, ui) => runInput(schemaDoc(SPECS.find((d) => d.id === id)).$defs.input, runFields(TOOLS[id], { target: 'example.com', ...ui }));
assert.deepStrictEqual(one('mx', {}), { target: 'example.com' }, 'mx: no types (the descriptor adds MX)');
assert.deepStrictEqual(one('spf', {}), { target: 'example.com' });
assert.deepStrictEqual(one('dmarc', {}), { target: 'example.com' }, 'dmarc: not _dmarc.example.com (the route adds it)');
assert.deepStrictEqual(one('dkim', { selector: 'google' }), { target: 'example.com', selector: 'google' }, 'dkim: the selector as its own field');
assert.deepStrictEqual(one('latency', {}), { target: 'example.com' }, 'latency: no count (the route asks for 10)');
assert.deepStrictEqual(one('dig', { types: ['TXT'] }), { target: 'example.com', types: ['TXT'] }, 'dig keeps the chosen types');
assert.deepStrictEqual(one('smtp', { smtpPort: '587' }), { target: 'example.com', port: 587 });
assert.deepStrictEqual(runInput(null, { target: 'example.com', types: ['A'] }), { target: 'example.com' }, 'no schema (the fetch failed): the target only');
const route = SPECS.find((d) => d.id === 'dmarc').route;
assert.strictEqual(route.target, '_dmarc.{target}', 'the descriptor still owns the prefix');
assert.ok(!/_dmarc\.\$\{|\._domainkey\.\$\{/.test(html), 'the page builds no _dmarc./_domainkey. target itself');

console.log(`net page input: ${checked} tools' inputs built from their descriptors pass their schemas; dkim/dmarc unprefixed, no types/count where undeclared: all checks passed`);
