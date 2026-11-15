'use strict';
// ═══════════════════════════════════════════════════════════════
// Bring a val from Val Town (plan 2026-11-13 §AD.12: Val Town is winding down, read-only from 2026-12-10 and gone on
// 2027-01-10, and its people need a home for their small functions). A val becomes a code tool's draft, which the
// person checks, tries and makes on the make page like any other:
//
//   - its TypeScript is stripped to JavaScript (Node's own module.stripTypeScriptTypes, transform mode);
//   - its ES module becomes a script inside an async scope of its own (so its names never meet the wrapper's, and a
//     top-level await still works): node: imports become require(), exports plain declarations;
//   - a run(input) calls it the way Val Town did:
//       script    the exported function, one input per parameter (JSON text for objects and arrays is parsed)
//       http      the handler with a Request built from method, path and body; the answer is the Response's status,
//                 content type and body
//       interval  the function with { lastRunAt }; the tool's schedule (Run it on its own) runs it on its own
//
// The vals it imports (https://esm.town/v/<user>/<name>) come along, each a module in a scope of its own (at most 12
// vals, 4 deep, their latest versions). What a tool cannot have is said, not hidden: imports of packages (npm:, jsr:,
// other URLs: a tool runs with no packages), email vals, and JSX are refused with the reason; Deno.env answers undefined (a tool has no secrets); fetch() makes the tool
// one that uses the public internet (net: public). Nothing of the val is run here: the code is only compiled to check it.
// ═══════════════════════════════════════════════════════════════

const vm = require('vm');

const API = 'https://api.val.town/v1/alias';
const MAX_VAL_BYTES = 256 * 1024;
const NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

/** A val's reference from what a person pastes: its page or module URL, @user/name or user/name. → { user, name } | null */
function parseValRef(text) {
    const t = String(text || '').trim();
    let m = t.match(/^https?:\/\/(?:www\.)?val\.town\/(?:v|x)\/([^/?#]+)\/([^/?#.]+)/i)
        || t.match(/^https?:\/\/esm\.town\/v\/([^/?#]+)\/([^/?#.]+)/i)
        || t.match(/^@?([A-Za-z0-9_][A-Za-z0-9_-]*)[/.]([A-Za-z0-9_][A-Za-z0-9_-]*)$/);
    if (!m || !NAME.test(m[1]) || !NAME.test(m[2])) return null;
    return { user: m[1], name: m[2] };
}

/** The val from Val Town's public API (a fixed host; nothing else of the person's text is a URL). */
async function fetchVal({ user, name }, { fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
    let res;
    try {
        res = await fetchImpl(`${API}/${encodeURIComponent(user)}/${encodeURIComponent(name)}`, { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    } catch {
        throw fail(502, 'tools.made.val_unreachable', 'Val Town did not answer. Try again, or paste the val\'s code instead.');
    }
    if (res.status === 404) throw fail(404, 'tools.made.val_not_found', `No public val ${user}/${name} on Val Town. A private val's code can be pasted instead.`);
    if (!res.ok) throw fail(502, 'tools.made.val_unreachable', `Val Town answered ${res.status}. Try again, or paste the val's code instead.`);
    const text = await res.text();
    if (Buffer.byteLength(text) > MAX_VAL_BYTES) throw fail(422, 'tools.made.val_too_big', 'That val is bigger than a tool can be (64 KB of code).');
    let v;
    try { v = JSON.parse(text); } catch { throw fail(502, 'tools.made.val_unreachable', 'Val Town answered something other than a val.'); }
    if (!v || typeof v.code !== 'string') throw fail(502, 'tools.made.val_unreachable', 'Val Town answered a val without its code.');
    return { user: (v.author && v.author.username) || user, name: v.name || name, type: v.type || 'script', version: v.version || null, code: v.code, url: v.url || `https://www.val.town/v/${user}/${name}` };
}

function stripTypes(code) {
    const mod = require('module');
    if (typeof mod.stripTypeScriptTypes !== 'function') return code; // an older Node: plain JavaScript vals still come
    const warn = process.emitWarning;
    process.emitWarning = () => {}; // its "experimental" warning, once per process, says nothing to the person
    try {
        return mod.stripTypeScriptTypes(code, { mode: 'transform' });
    } catch (e) {
        throw fail(422, 'tools.made.val_unconvertible', `This val's TypeScript did not convert: ${String(e.message || e).split('\n')[0]}`);
    } finally {
        process.emitWarning = warn;
    }
}

/** One `import … from 'node:x'` clause as require(): default and namespace imports are the module, named ones destructured. */
function requireOf(clause, spec) {
    const m = clause.match(/^\s*([A-Za-z_$][\w$]*)?\s*,?\s*(?:\*\s+as\s+([A-Za-z_$][\w$]*)|\{([^}]*)\})?\s*$/);
    if (!m) return null;
    const req = `require(${JSON.stringify(spec)})`;
    const out = [];
    if (m[1]) out.push(`const ${m[1]} = ${req};`);
    if (m[2]) out.push(`const ${m[2]} = ${req};`);
    if (m[3]) {
        const names = m[3].split(',').map((s) => s.trim()).filter((s) => s && !/^type\s/.test(s))
            .map((s) => { const [a, b] = s.split(/\s+as\s+/); return b ? `${a.trim()}: ${b.trim()}` : a.trim(); });
        if (names.length) out.push(`const { ${names.join(', ')} } = ${req};`);
    }
    return out.join(' ');
}

/** The parameter names of the function whose `(` is at open (a destructured one is argN). */
function paramsAt(src, open) {
    let depth = 0;
    let quote = null;
    let i = open;
    for (; i < src.length; i++) {
        const c = src[i];
        if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
        if (c === '"' || c === "'" || c === '`') quote = c;
        else if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) break; }
    }
    const inner = src.slice(open + 1, i);
    const parts = [];
    let cur = '';
    depth = 0;
    quote = null;
    for (let k = 0; k < inner.length; k++) {
        const c = inner[k];
        if (quote) { cur += c; if (c === '\\') { cur += inner[++k] || ''; } else if (c === quote) quote = null; continue; }
        if (c === '"' || c === "'" || c === '`') quote = c;
        if (c === '(' || c === '[' || c === '{') depth++;
        if (c === ')' || c === ']' || c === '}') depth--;
        if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
        cur += c;
    }
    if (cur.trim()) parts.push(cur);
    return parts.map((p, n) => {
        const id = p.trim().replace(/^\.\.\./, '').match(/^([A-Za-z_$][\w$]*)/);
        return id ? id[1] : `arg${n + 1}`;
    });
}

/** Where `name` is defined as a function in src: its parameters, or null when it is not one (a value). */
function paramsOf(src, name) {
    const esc = name.replace(/\$/g, '\\$');
    const decl = new RegExp(`(?:^|[^\\w$.])(?:async\\s+)?function\\s*\\*?\\s*${esc}\\s*\\(`, 'm').exec(src);
    if (decl) return paramsAt(src, decl.index + decl[0].length - 1);
    const assign = new RegExp(`(?:const|let|var)\\s+${esc}\\s*=\\s*(?:async\\s*)?(?:function\\s*\\*?\\s*[\\w$]*\\s*)?(\\(|([A-Za-z_$][\\w$]*)\\s*=>)`, 'm').exec(src);
    if (!assign) return null;
    if (assign[2]) return [assign[2]];
    return paramsAt(src, assign.index + assign[0].length - 1);
}

/** One `import … from '<a val>'` clause, from the val's module (a promise of its exports). */
function awaitOf(clause, id) {
    const m = clause.match(/^\s*([A-Za-z_$][\w$]*)?\s*,?\s*(?:\*\s+as\s+([A-Za-z_$][\w$]*)|\{([^}]*)\})?\s*$/);
    if (!m) return null;
    const out = [];
    if (m[1]) out.push(`const ${m[1]} = (await ${id}).default;`);
    if (m[2]) out.push(`const ${m[2]} = await ${id};`);
    if (m[3]) {
        const names = m[3].split(',').map((s) => s.trim()).filter((s) => s && !/^type\s/.test(s))
            .map((s) => { const [a, b] = s.split(/\s+as\s+/); return b ? `${a.trim()}: ${b.trim()}` : a.trim(); });
        if (names.length) out.push(`const { ${names.join(', ')} } = await ${id};`);
    }
    return out.join(' ');
}

const valId = (ref) => `val_${ref.user}_${ref.name}`.replace(/[^\w$]/g, '_');

/**
 * A val's module, converted: { src, def, exported: [[as, local]], vals: [{ user, name }] } with its node: imports as
 * require() and its val imports awaiting that val's module (valId). Packages and other URLs are refused.
 */
function moduleOf(code, { name, user, url }) {
    if (Buffer.byteLength(code) > MAX_VAL_BYTES) throw fail(422, 'tools.made.val_too_big', 'That val is bigger than a tool can be (64 KB of code).');
    let src = stripTypes(code.replace(/\r\n?/g, '\n'));
    const others = [];
    const vals = [];
    const take = (spec) => {
        const ref = /^https:\/\/esm\.town\/v\//i.test(spec) ? parseValRef(spec) : null;
        if (ref) vals.push(ref);
        return ref;
    };
    src = src.replace(/^[ \t]*import\s+(?!type\s)([\s\S]*?)\s+from\s+(['"])([^'"]+)\2\s*;?/gm, (all, clause, q, spec) => {
        if (/^node:/.test(spec)) {
            const r = requireOf(clause, spec);
            if (r) return r;
        }
        const ref = take(spec);
        if (ref) {
            const r = awaitOf(clause, valId(ref));
            if (r) return r;
        }
        others.push(spec);
        return all;
    });
    src = src.replace(/^[ \t]*import\s+(['"])([^'"]+)\1\s*;?/gm, (all, q, spec) => (take(spec) ? `await ${valId(parseValRef(spec))};` : (others.push(spec), all)));
    if (others.length) {
        const list = [...new Set(others)].slice(0, 6).join(', ');
        throw fail(422, 'tools.made.val_imports', `${user ? `${user}/` : ''}${name} imports ${list}. A tool runs with no packages: paste a version that does without them (node: modules and other vals are fine).`);
    }
    if (/<[A-Za-z][\w.]*(\s[^<>]*)?\/?>[\s\S]*<\/?[A-Za-z]/.test(code) && /\.tsx|React|jsx/i.test(code + url)) {
        throw fail(422, 'tools.made.val_unconvertible', 'This val uses JSX (a page made of components); a tool answers data. Bring a val that returns data or text.');
    }
    src = src.replace(/\bimport\.meta\.url\b/g, JSON.stringify(url || `https://esm.town/v/${user}/${name}`));

    let def = null;
    const exported = [];
    src = src.replace(/^([ \t]*)export\s+default\s+(async\s+)?function\s*(\*?)\s*([A-Za-z_$][\w$]*)?\s*\(/m, (all, ws, asy, star, nm) => {
        def = nm || '__valDefault';
        return `${ws}${asy || ''}function${star} ${def}(`;
    });
    if (!def) src = src.replace(/^([ \t]*)export\s+default\s+([A-Za-z_$][\w$]*)\s*;?[ \t]*$/m, (all, ws, nm) => { def = nm; return ''; });
    if (!def) src = src.replace(/^([ \t]*)export\s+default\s+/m, (all, ws) => { def = '__valDefault'; return `${ws}const __valDefault = `; });
    src = src.replace(/^([ \t]*)export\s+(async\s+function\*?|function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm, (all, ws, kw, nm) => { exported.push([nm, nm]); return `${ws}${kw} ${nm}`; });
    src = src.replace(/^[ \t]*export\s*\{([^}]*)\}\s*;?/gm, (all, list) => {
        for (const part of list.split(',')) {
            const [local, as] = part.trim().split(/\s+as\s+/);
            if (!local) continue;
            if ((as || '').trim() === 'default') def = local.trim();
            else exported.push([(as || local).trim(), local.trim()]);
        }
        return '';
    });
    return { src, def, exported, vals };
}

/** The vals a module imports, fetched and converted, dependencies first (at most 12, 4 deep). */
async function modulesFor(root, getVal, rootRef = null) {
    const order = [];
    const done = new Map();
    async function visit(ref, depth, chain) {
        const id = valId(ref);
        if (done.has(id)) return;
        if (chain.includes(id)) throw fail(422, 'tools.made.val_imports', `The vals import each other in a circle (${chain.concat(id).join(' → ')}).`);
        if (depth > 4) throw fail(422, 'tools.made.val_imports', 'The vals it imports go more than 4 deep; a tool keeps to fewer.');
        if (done.size >= 12) throw fail(422, 'tools.made.val_imports', 'It imports more than 12 vals; a tool keeps to fewer.');
        const v = await getVal(ref);
        const mod = moduleOf(v.code, v);
        done.set(id, true);
        for (const dep of mod.vals) await visit(dep, depth + 1, chain.concat(id));
        order.push({ id, ref, mod });
    }
    const start = rootRef && rootRef.user ? valId(rootRef) : 'the val';
    for (const dep of root.vals) await visit(dep, 1, [start]);
    return order;
}

/**
 * A val's code as a code tool's draft (its imported vals fetched with getVal). → { draft: { kind, name, summary,
 * source, inputs, answer, fields }, net, notes, val } — draft is what POST /api/v1/made-tools/draft answers
 * (bodyFromDraft makes the tool's body of it).
 */
async function convertVal({ code, name = 'val', type = 'script', user = '', url = '' }, { getVal = null } = {}) {
    if (typeof code !== 'string' || !code.trim()) throw fail(422, 'tools.made.invalid', 'Paste the val\'s code, or its address on Val Town.');
    const kind = ['script', 'http', 'interval', 'email'].includes(type) ? type : 'script';
    if (kind === 'email') throw fail(422, 'tools.made.val_email', 'An email val runs when mail arrives; OpenVibe Tools has no email address for a tool yet.');
    const notes = [];
    const root = moduleOf(code, { name, user, url });
    if (root.vals.length && !getVal) throw fail(422, 'tools.made.val_imports', 'It imports other vals; bring it by its address on Val Town so they come along.');
    const deps = root.vals.length ? await modulesFor(root, getVal, { user, name }) : [];
    if (deps.length) notes.push(`It imports ${deps.length === 1 ? 'one val' : `${deps.length} vals`} (${deps.map((d) => `${d.ref.user}/${d.ref.name}`).join(', ')}): they come along, at their latest versions.`);
    const { src, def, exported } = root;
    const all = [root.src, ...deps.map((d) => d.mod.src)].join('\n');
    if (/\bimport\s*\(/.test(all)) notes.push('It loads code with import(), which a tool cannot do: that part will fail when it runs.');
    const named = exported.find(([as]) => as === name);
    const target = def || (named ? named[1] : exported.length ? exported[0][1] : null);
    if (!target) throw fail(422, 'tools.made.val_unconvertible', 'This val exports nothing for a tool to call.');
    if (!def && exported.length > 1) notes.push(`It exports ${exported.length} things; the tool calls ${target}.`);

    let pre = '';
    if (/\bDeno\./.test(all)) {
        pre = 'const Deno = { env: { get: () => undefined, has: () => false, toObject: () => ({}) } };\n';
        if (/\bDeno\.env\b/.test(all)) notes.push('It reads Deno.env (its secrets on Val Town). A tool has none: Deno.env.get answers undefined.');
        if (/\bDeno\.(?!env\b)\w+/.test(all)) notes.push('It uses Deno APIs other than env, which a tool does not have: those parts will fail.');
    }
    const net = /\bfetch\s*\(/.test(all) ? 'public' : 'deny';
    if (net === 'public') notes.push('It uses fetch(), so the tool reaches the public internet when it runs on a machine (not in this page\'s sandbox).');

    const params = paramsOf(src, target);
    const label = (p) => p.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
    const keyOf = (l, taken) => {
        let k = String(l || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'field';
        if (!/^[a-z]/.test(k)) k = `f_${k}`;
        let out = k;
        for (let n = 2; taken.has(out); n++) out = `${k}_${n}`;
        taken.add(out);
        return out;
    };
    let inputs;
    let answer = 'text';
    let fields = [];
    let call;
    if (kind === 'http') {
        inputs = [{ label: 'Method', kind: 'short' }, { label: 'Path', kind: 'short' }, { label: 'Body', kind: 'long' }];
        answer = 'fields';
        fields = [{ label: 'Status' }, { label: 'Content type' }, { label: 'Body' }];
        call = `    const method = String(input.method || 'GET').toUpperCase();
    const path = String(input.path || '/');
    const init = { method };
    if (input.body && method !== 'GET' && method !== 'HEAD') init.body = String(input.body);
    const res = await target(new Request(new URL(path.startsWith('/') ? path : '/' + path, ${JSON.stringify(`https://${user || 'val'}-${name}.val.openvibe.tools`)}), init));
    if (!res || typeof res.text !== 'function') return { status: '200', content_type: 'text/plain', body: typeof res === 'string' ? res : JSON.stringify(res) };
    return { status: String(res.status), content_type: (res.headers && res.headers.get('content-type')) || '', body: await res.text() };`;
    } else if (kind === 'interval') {
        inputs = [];
        call = `    const out = await target({ lastRunAt: input.last_run_at ? new Date(input.last_run_at) : undefined });
    return out === undefined ? 'Ran.' : out;`;
        notes.push('It ran on a schedule on Val Town: give the tool a schedule under "Run it on its own" once it is made.');
    } else if (params === null) {
        inputs = [];
        call = '    return typeof target === \'function\' ? await target() : target;';
    } else {
        const taken = new Set();
        inputs = params.slice(0, 12).map((p) => ({ label: label(p), kind: 'short' }));
        const keys = inputs.map((i) => keyOf(i.label, taken));
        call = `    return await target(${keys.map((k) => `arg(input[${JSON.stringify(k)}])`).join(', ')});`;
    }

    const head = `// From Val Town: ${user ? `${user}/` : ''}${name} (${kind} val), brought to OpenVibe Tools.\n`;
    const exportsOf = (m) => `{ ${[m.def ? `default: ${m.def}` : null, ...m.exported.map(([as, local]) => (as === local ? as : `${as}: ${local}`))].filter(Boolean).join(', ')} }`;
    const modules = deps.map((d) => `// ${d.ref.user}/${d.ref.name}, a val it imports.
const ${d.id} = (async () => {
${d.mod.src.replace(/\s+$/, '')}
return ${exportsOf(d.mod)};
})();
`).join('\n');
    const source = `${head}${pre}${modules ? `\n${modules}\n` : ''}// The val, in a scope of its own; run(input) below calls it the way Val Town did.
const valReady = (async () => {
${src.replace(/\s+$/, '')}
return ${target};
})();

// Text that holds JSON (an object or an array, true, false, null) is passed as that value.
function arg(v) {
    if (typeof v !== 'string') return v;
    const t = v.trim();
    if (/^[[{]/.test(t) || /^(true|false|null)$/.test(t)) {
        try { return JSON.parse(t); } catch (e) { /* the text as it is */ }
    }
    return v;
}

async function run(input) {
    const target = await valReady;
${call}
}
`;
    try {
        new vm.Script(source, { filename: `${name}.js` }); // compiled only, never run here
    } catch (e) {
        throw fail(422, 'tools.made.val_unconvertible', `This val did not convert: ${String(e.message || e).split('\n')[0]}`);
    }
    if (Buffer.byteLength(source) > 60 * 1024) throw fail(422, 'tools.made.val_too_big', 'That val is bigger than a tool can be (64 KB of code).');
    const nice = label(name).replace(/\s+/g, ' ');
    const summary = kind === 'http' ? `${nice}: answers a web request, from Val Town.` : kind === 'interval' ? `${nice}: runs on a schedule, from Val Town.` : `${nice}, from Val Town.`;
    return { draft: { kind: 'code', name: nice.slice(0, 80), summary: summary.slice(0, 200), source, inputs, answer, fields }, net, notes, val: { user, name, type: kind, url } };
}

module.exports = { parseValRef, fetchVal, convertVal, moduleOf, paramsOf };
