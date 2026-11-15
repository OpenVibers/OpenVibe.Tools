'use strict';
// ═══════════════════════════════════════════════════════════════
// Bring a Pipedream code step (plan 2026-11-13 §AD.12: Pipedream Workflows and String shut down on 2027-03-31; only
// Connect stays). A Node.js code step, pasted as it is in the workflow builder:
//
//   import { axios } from "@pipedream/platform";
//   export default defineComponent({
//     props: { city: { type: "string", label: "City" } },
//     async run({ steps, $ }) { $.export("greeting", `Hi ${this.city}`); return { … }; },
//   });
//
// becomes a code tool's draft: one input per prop (its label, its type: integer → number, object → JSON text), plus
// "Steps" (JSON) when the code reads steps; run(input) calls run({ steps, $ }) with the props as `this` (and the
// component's methods), and answers its return value, or { ...$.export()s, $return_value } when it exported any.
// $.flow.exit() ends it with what was exported. @pipedream/platform's axios(…) works through fetch (the tool then uses
// the public internet). What a tool cannot have is said: other packages and Python steps are refused; an app prop
// (a connected account) has no account here and is noted. Nothing of the step runs here: its props are read as a
// literal, its code only compiled.
// ═══════════════════════════════════════════════════════════════

const vm = require('vm');

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

const AXIOS = `// @pipedream/platform's axios($, config), through fetch: the answer's data, or an error with the status.
async function axios($, config) {
    const c = config || $ || {};
    const url = new URL(c.url, c.baseURL || undefined);
    for (const [k, v] of Object.entries(c.params || {})) url.searchParams.set(k, String(v));
    const headers = { ...(c.headers || {}) };
    let body;
    if (c.data != null) {
        body = typeof c.data === 'string' ? c.data : JSON.stringify(c.data);
        if (typeof c.data !== 'string' && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    }
    if (c.auth && c.auth.username != null) headers.Authorization = 'Basic ' + Buffer.from(c.auth.username + ':' + (c.auth.password || '')).toString('base64');
    const res = await fetch(url, { method: (c.method || 'GET').toUpperCase(), headers, body });
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch (e) { /* text */ }
    if (!res.ok) throw new Error('The request answered ' + res.status + (typeof data === 'string' ? ': ' + data.slice(0, 200) : ''));
    return c.returnFullResponse ? { status: res.status, headers: Object.fromEntries(res.headers), data } : data;
}
`;

/**
 * A JavaScript literal read without running anything (the person's code is never evaluated here): objects with plain or
 * quoted keys, arrays, strings (a template without ${…}), numbers, true, false, null. Anything else (a function, an
 * expression, a method) is skipped to the next comma or closing bracket and reads as undefined.
 */
function literalAt(src, at) {
    let i = at;
    const SKIP = Symbol('skip');
    const ws = () => {
        for (;;) {
            while (i < src.length && /\s/.test(src[i])) i++;
            if (src.startsWith('//', i)) { while (i < src.length && src[i] !== '\n') i++; continue; }
            if (src.startsWith('/*', i)) { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
            return;
        }
    };
    const str = () => {
        const q = src[i++];
        let out = '';
        while (i < src.length && src[i] !== q) {
            if (src[i] === '\\') { const n = src[i + 1]; out += n === 'n' ? '\n' : n === 't' ? '\t' : n; i += 2; continue; }
            if (q === '`' && src.startsWith('${', i)) return skipRest();
            out += src[i++];
        }
        i++;
        return out;
    };
    // Past an expression this reader does not read: to the next , } or ] at its own depth.
    const skipRest = () => {
        let depth = 0;
        let quote = null;
        for (; i < src.length; i++) {
            const c = src[i];
            if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
            if (c === '"' || c === "'" || c === '`') quote = c;
            else if (c === '(' || c === '[' || c === '{') depth++;
            else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; }
            else if (c === ',' && depth === 0) break;
        }
        return SKIP;
    };
    const value = () => {
        ws();
        const c = src[i];
        if (c === '{') {
            i++;
            const o = {};
            for (;;) {
                ws();
                if (src[i] === '}') { i++; return o; }
                if (i >= src.length) return o;
                let key = null;
                if (src[i] === '"' || src[i] === "'") key = str();
                else { const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 200)); if (m) { key = m[0]; i += key.length; } }
                ws();
                let v = SKIP;
                if (key !== null && src[i] === ':') { i++; v = value(); }
                else skipRest(); // a method, a spread, a computed key: not a literal
                if (key !== null && v !== SKIP) o[key] = v;
                ws();
                if (src[i] === ',') { i++; continue; }
                if (src[i] === '}') { i++; return o; }
                skipRest();
                if (src[i] === ',') i++;
            }
        }
        if (c === '[') {
            i++;
            const a = [];
            for (;;) {
                ws();
                if (src[i] === ']') { i++; return a; }
                if (i >= src.length) return a;
                const v = value();
                if (v !== SKIP) a.push(v);
                ws();
                if (src[i] === ',') { i++; continue; }
                if (src[i] === ']') { i++; return a; }
                skipRest();
            }
        }
        if (c === '"' || c === "'" || c === '`') {
            const v = str();
            ws();
            return /[,}\]]/.test(src[i] || '}') ? v : skipRest();
        }
        const m = /^(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|true|false|null)(?![\w$])/.exec(src.slice(i, i + 40));
        if (m) {
            i += m[0].length;
            ws();
            if (!/[,}\]]/.test(src[i] || '}')) return skipRest();
            return m[0] === 'true' ? true : m[0] === 'false' ? false : m[0] === 'null' ? null : Number(m[0]);
        }
        return skipRest();
    };
    const v = value();
    return v === SKIP ? undefined : v;
}

/** The prop definitions from the component's source: { key: { type, label, default, … } }, read as a literal. */
function propsOf(src) {
    const m = /\bprops\s*:\s*\{/.exec(src);
    if (!m) return {};
    const props = literalAt(src, m.index + m[0].length - 1);
    return props && typeof props === 'object' && !Array.isArray(props) ? props : {};
}

/** A Pipedream Node.js code step as a code tool's draft. → { draft, net, notes, val: { name, type: 'pipedream' } } */
function convertPipedream({ code, name = 'step' }) {
    if (typeof code !== 'string' || !code.trim()) throw fail(422, 'tools.made.invalid', 'Paste the code step, from export default defineComponent to its end.');
    if (Buffer.byteLength(code) > 64 * 1024) throw fail(422, 'tools.made.val_too_big', 'That step is bigger than a tool can be (64 KB of code).');
    if (/^\s*def\s+handler\s*\(/m.test(code)) throw fail(422, 'tools.made.pd_python', 'This is a Python step; OpenVibe Tools runs JavaScript. A Node.js step comes as it is.');
    if (!/\bdefineComponent\s*\(/.test(code)) throw fail(422, 'tools.made.invalid', 'Paste a Node.js code step: export default defineComponent({ … async run({ steps, $ }) { … } }).');
    const notes = [];
    let src = code.replace(/\r\n?/g, '\n');
    let usesAxios = false;
    const others = [];
    src = src.replace(/^[ \t]*import\s+([\s\S]*?)\s+from\s+(['"])([^'"]+)\2\s*;?/gm, (all, clause, q, spec) => {
        if (spec === '@pipedream/platform') {
            const names = (clause.match(/\{([^}]*)\}/) || [, ''])[1].split(',').map((s) => s.trim()).filter(Boolean);
            const bad = names.filter((n) => n.split(/\s+as\s+/)[0] !== 'axios');
            if (bad.length) { others.push(`@pipedream/platform (${bad.join(', ')})`); return all; }
            usesAxios = true;
            return names.filter((n) => /\s+as\s+/.test(n)).map((n) => `const ${n.split(/\s+as\s+/)[1]} = axios;`).join(' ');
        }
        if (/^node:/.test(spec) || ['crypto', 'url', 'util', 'path', 'buffer', 'querystring', 'zlib', 'events', 'assert', 'string_decoder'].includes(spec)) {
            const m = clause.match(/^\s*([A-Za-z_$][\w$]*)?\s*,?\s*(?:\*\s+as\s+([A-Za-z_$][\w$]*)|\{([^}]*)\})?\s*$/);
            if (m) {
                const req = `require(${JSON.stringify(spec.startsWith('node:') ? spec : `node:${spec}`)})`;
                const out = [];
                if (m[1]) out.push(`const ${m[1]} = ${req};`);
                if (m[2]) out.push(`const ${m[2]} = ${req};`);
                if (m[3]) out.push(`const { ${m[3].split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/\s+as\s+/, ': ')).join(', ')} } = ${req};`);
                return out.join(' ');
            }
        }
        others.push(spec);
        return all;
    });
    if (others.length) throw fail(422, 'tools.made.val_imports', `This step imports ${[...new Set(others)].slice(0, 6).join(', ')}. A tool runs with no packages: paste a version that does without them (axios from @pipedream/platform and node: modules are fine).`);
    if (!/^[ \t]*export\s+default\s+defineComponent\s*\(/m.test(src)) throw fail(422, 'tools.made.invalid', 'The step should be export default defineComponent({ … }).');
    src = src.replace(/^([ \t]*)export\s+default\s+defineComponent\s*\(/m, '$1const component = defineComponent(');

    const props = propsOf(src);
    const keys = Object.keys(props);
    const apps = keys.filter((k) => props[k] && props[k].type === 'app');
    if (apps.length) notes.push(`It uses ${apps.map((k) => props[k].app || k).join(', ')} through a connected account (this.${apps[0]}.$auth). A tool has no connected accounts: give it the key as an input instead.`);
    const inputs = [];
    const map = [];
    const taken = new Set();
    const keyOf = (l) => {
        let k = String(l || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'field';
        if (!/^[a-z]/.test(k)) k = `f_${k}`;
        let out = k;
        for (let n = 2; taken.has(out); n++) out = `${k}_${n}`;
        taken.add(out);
        return out;
    };
    for (const k of keys.filter((x) => !apps.includes(x)).slice(0, 11)) {
        const p = props[k] || {};
        const label = String(p.label || k).slice(0, 60);
        const type = String(p.type || 'string');
        inputs.push({ label, kind: type === 'integer' ? 'number' : type === 'object' || type === 'string[]' || /\[\]$/.test(type) ? 'long' : 'short' });
        map.push([k, keyOf(label), type, p.default]);
    }
    const readsSteps = /\bsteps\s*\./.test(src) || /\bsteps\s*\[/.test(src);
    if (readsSteps) { inputs.push({ label: 'Steps', kind: 'long' }); map.push(['__steps', keyOf('Steps'), 'object', {}]); notes.push('It reads earlier steps: give their data as Steps (JSON, like {"trigger":{"event":{…}}}).'); }
    const net = usesAxios || /\bfetch\s*\(/.test(src) ? 'public' : 'deny';
    if (net === 'public') notes.push('It calls other sites (axios or fetch), so the tool reaches the public internet when it runs on a machine.');
    if (/\$\.respond\s*\(/.test(src)) notes.push('It answers an HTTP trigger with $.respond(): the tool answers with what it returns instead.');

    const conv = map.map(([prop, key, type, dflt]) => {
        const val = `input[${JSON.stringify(key)}]`;
        const parse = type === 'integer' ? `Number(${val})` : type === 'boolean' ? `(${val} === true || ${val} === 'true')` : type === 'object' || /\[\]$/.test(type) ? `json(${val})` : val;
        return `    if (${val} !== undefined && ${val} !== '') props[${JSON.stringify(prop)}] = ${parse};${dflt !== undefined ? ` else props[${JSON.stringify(prop)}] = ${JSON.stringify(dflt)};` : ''}`;
    }).join('\n');

    const source = `// From Pipedream: a Node.js code step, brought to OpenVibe Tools. run(input) calls its run({ steps, $ }).
${usesAxios ? AXIOS : ''}function defineComponent(c) { return c; }
const stepReady = (async () => {
${src.replace(/\s+$/, '')}
return component;
})();

function json(v) {
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch (e) { return v; }
}

async function run(input) {
    const component = await stepReady;
    const props = {};
${conv}
    const steps = props.__steps || {};
    delete props.__steps;
    const exported = {};
    const EXIT = {};
    const $ = {
        export(k, v) { exported[k] = v; },
        flow: { exit(reason) { exported.$summary = reason || exported.$summary; throw EXIT; }, delay() { throw new Error('A tool cannot wait for later ($.flow.delay)'); } },
        respond(r) { exported.$response = r && r.body !== undefined ? r.body : r; },
        send: { http() {}, email() {} },
        get summary() { return exported.$summary; },
        set summary(s) { exported.$summary = s; },
    };
    const self = Object.assign(Object.create(null), component.methods || {}, props);
    let out;
    try {
        out = await component.run.call(self, { steps, $ });
    } catch (e) {
        if (e !== EXIT) throw e;
    }
    return Object.keys(exported).length ? { ...exported, $return_value: out === undefined ? null : out } : (out === undefined ? null : out);
}
`;
    try {
        new vm.Script(source, { filename: `${name}.js` }); // compiled only, never run here
    } catch (e) {
        throw fail(422, 'tools.made.val_unconvertible', `This step did not convert: ${String(e.message || e).split('\n')[0]}`);
    }
    const nice = String(name || 'Pipedream step').replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase()).slice(0, 80);
    return {
        draft: { kind: 'code', name: nice, summary: `${nice}, a code step from Pipedream.`.slice(0, 200), source, inputs, answer: 'text', fields: [] },
        net, notes, val: { name, type: 'pipedream' },
    };
}

module.exports = { convertPipedream, propsOf, literalAt };
