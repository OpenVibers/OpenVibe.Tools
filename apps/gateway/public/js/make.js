/* Make a tool (openvibe.tools/make; plan 2026-11-13 §AD.7 step 3): a person tells a model what to do, names what it
 * takes and what it gives back, picks any model on OpenVibe.Exchange, tries it and shares it. The API is
 * /api/v1/made-tools (tools.made-tool@1). Every text people typed is set with textContent, never as markup. */
(function () {
    'use strict';
    var root = document.getElementById('mk-app');
    if (!root) return;

    // ── Small helpers ──────────────────────────────────────────
    function h(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }
    function btn(label, kind, onClick, type) {
        var b = h('button', 'ovk-btn ovk-btn--' + (kind || 'quiet'), label);
        b.type = type || 'button';
        if (onClick) b.addEventListener('click', onClick);
        return b;
    }
    function api(path, opts) {
        opts = opts || {};
        var headers = { Accept: 'application/json' };
        if (opts.body) headers['Content-Type'] = 'application/json';
        return fetch('/api/v1/made-tools' + path, { method: opts.method || 'GET', credentials: 'same-origin', headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined })
            .then(function (r) {
                return r.text().then(function (t) { var j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { j = null; } return { status: r.status, ok: r.ok, body: j }; });
            })
            .catch(function () { return { status: 0, ok: false, body: null }; });
    }
    function words(res, fallback) {
        var b = res && res.body;
        if (b && (b.detail || b.title)) return String(b.detail || b.title);
        if (res && res.status === 0) return 'Tools could not be reached. Check your connection and try again.';
        return fallback;
    }
    var VIS = [['private', 'Only me', 'Yours alone'], ['unlisted', 'Anyone with the link', 'Not listed anywhere'], ['public', 'Everyone', 'Listed here and in agents’ tools']];
    var visLabel = function (v) { for (var i = 0; i < VIS.length; i++) if (VIS[i][0] === v) return VIS[i][1]; return v; };
    var KINDS = [['short', 'Short text'], ['long', 'Long text'], ['number', 'Number']];
    function keyOf(label, taken) {
        var k = String(label || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'field';
        if (!/^[a-z]/.test(k)) k = 'f_' + k;
        var out = k, n = 2;
        while (taken[out]) out = k + '_' + (n++);
        taken[out] = true;
        return out;
    }
    function slugOf(name) {
        var s = String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
        if (!/^[a-z]/.test(s)) s = ('tool-' + s).slice(0, 40);
        return s.length >= 2 ? s.replace(/-+$/, '') : 'my-tool';
    }
    var money = function (v) { return v == null ? null : '$' + (v >= 1 ? v.toFixed(2) : v >= 0.01 ? v.toFixed(2) : v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')); };

    // ── Code tools (§AD.12 (c)) ────────────────────────────────
    var CODE_TEMPLATE = '// run(input) gets the inputs below and returns the answer (it may be async).\n' +
        '// It runs without a network: work with the input only.\n' +
        'function run(input) {\n' +
        '  const text = String(input.text || \'\');\n' +
        '  const words = text.trim().split(/\\s+/).filter(Boolean);\n' +
        '  return { words: words.length, characters: text.length };\n' +
        '}\n';
    /** A code tool's run(input) in /made-sandbox: an opaque-origin frame (no cookies, no storage, no way to this page)
     *  whose own policy allows no network, running the code in a Worker; the frame is removed after the time limit. */
    function runInSandbox(source, input, timeoutMs) {
        return new Promise(function (resolve) {
            var frame = document.createElement('iframe');
            frame.setAttribute('sandbox', 'allow-scripts');
            frame.setAttribute('aria-hidden', 'true');
            frame.setAttribute('tabindex', '-1');
            frame.style.cssText = 'position:absolute;width:1px;height:1px;border:0;opacity:0;pointer-events:none';
            var t = Math.random().toString(36).slice(2);
            var done = false, timer = 0;
            function finish(r) { if (done) return; done = true; window.removeEventListener('message', onMsg); clearTimeout(timer); frame.remove(); resolve(r); }
            function onMsg(e) {
                if (e.source !== frame.contentWindow) return;
                var d = e.data || {};
                if (d.sandbox === 'ready') { frame.contentWindow.postMessage({ t: t, source: String(source), input: input }, '*'); return; }
                if (d.t !== t) return;
                finish(d.ok ? { ok: true, out: d.out } : { ok: false, error: d.error || 'It failed' });
            }
            window.addEventListener('message', onMsg);
            timer = setTimeout(function () { finish({ ok: false, error: 'It took longer than ' + Math.round(timeoutMs / 1000) + ' s and was stopped' }); }, timeoutMs);
            frame.src = '/made-sandbox';
            document.body.append(frame);
        });
    }

    // ── Chains (§AD.12 (e)) ────────────────────────────────────
    var schemaCache = {};
    /** A tool's input schema and its answer's fields (null when it answers text), for a step's fields and chips. */
    function schemaFor(toolId) {
        if (schemaCache[toolId]) return Promise.resolve(schemaCache[toolId]);
        var p = /^mtl_/.test(toolId)
            ? api('/' + encodeURIComponent(toolId)).then(function (r) { var t = r.body || {}; return { input: t.input || { type: 'object' }, output: t.output && t.output.kind === 'json' && t.output.schema ? t.output.schema : null }; })
            : fetch('/api/v1/tools/' + encodeURIComponent(toolId) + '/schema', { headers: { Accept: 'application/json' } }).then(function (r) { return r.ok ? r.json() : null; })
                .then(function (d) { var o = d && d.$defs && d.$defs.output; return { input: (d && d.$defs && d.$defs.input) || { type: 'object' }, output: o && o.type === 'object' && o.properties ? o : null }; })
                .catch(function () { return { input: { type: 'object' }, output: null }; });
        return p.then(function (s) { schemaCache[toolId] = s; return s; });
    }
    function findTools(need) {
        return fetch('/mcp', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'find_tools', arguments: { need: need, limit: 12 } } }) })
            .then(function (r) { return r.json(); })
            .then(function (d) { try { var v = JSON.parse(d.result.content[0].text); return Array.isArray(v) ? v : []; } catch (e) { return []; } })
            .catch(function () { return []; });
    }
    var picker = h('dialog', 'ovk-sheet mk-sheet');
    picker.setAttribute('aria-labelledby', 'mk-picker-t');
    (function () {
        var head = h('div', 'ovk-sheet-head');
        var t = h('h2', null, 'Pick a tool'); t.id = 'mk-picker-t';
        var close = h('button', 'ovk-icon-btn mk-icon', '×'); close.type = 'button'; close.setAttribute('aria-label', 'Close');
        close.addEventListener('click', function () { picker.close(); });
        head.append(t, close);
        var body = h('div', 'ovk-sheet-body');
        var find = h('input', 'mk-find'); find.type = 'search'; find.placeholder = 'What should this step do? (dns, qr code, summarize…)'; find.setAttribute('aria-label', 'Find a tool');
        var list = h('div', 'mk-models');
        body.append(find, list);
        picker.append(head, body);
        picker.addEventListener('click', function (e) { if (e.target === picker) picker.close(); });
        var timer = 0, seq = 0;
        find.addEventListener('input', function () {
            clearTimeout(timer);
            var q = find.value.trim();
            timer = setTimeout(function () {
                var my = ++seq;
                if (q.length < 2) { list.textContent = ''; return; }
                findTools(q).then(function (tools) {
                    if (my !== seq) return;
                    list.textContent = '';
                    if (!tools.length) { list.append(h('p', 'mk-hint', 'No tool fits that. Try other words.')); return; }
                    tools.forEach(function (tl) {
                        var b = h('button', 'mk-opt'); b.type = 'button';
                        var top = h('span', 'mk-opt-top'); top.append(h('b', null, tl.name || tl.tool));
                        if (tl.made) top.append(h('span', 'mk-badge', tl.yours ? 'Yours' : 'Made by someone'));
                        b.append(top, h('small', null, tl.summary || ''));
                        b.addEventListener('click', function () { if (picker.onPick) picker.onPick(tl); picker.close(); });
                        list.append(b);
                    });
                });
            }, 200);
        });
        picker.pick = function (onPick) { picker.onPick = onPick; find.value = ''; list.textContent = ''; if (typeof picker.showModal === 'function') picker.showModal(); else picker.setAttribute('open', ''); setTimeout(function () { find.focus(); }, 30); };
    })();
    document.body.append(picker);

    // ── State ──────────────────────────────────────────────────
    function blank() {
        return { id: null, kind: 'prompt', steps: [{ tool: '', name: '', input: {} }, { tool: '', name: '', input: {} }], source: CODE_TEMPLATE, slug: '', name: '', summary: '', instructions: '', model: 'auto', modelName: 'Auto', inputs: [{ label: 'Text', kind: 'long' }], answer: 'text', fields: [{ label: 'Answer' }], visibility: 'private', version: 0 };
    }
    var state = { signedIn: null, mine: [], form: blank(), models: null, saving: false };

    /** A saved tool back into the form. */
    function formOf(t) {
        var props = (t.input && t.input.properties) || {};
        var inputs = Object.keys(props).map(function (k) {
            var p = props[k] || {};
            return { label: p.title || k, key: k, kind: p.type === 'number' || p.type === 'integer' ? 'number' : (p.maxLength && p.maxLength <= 500 ? 'short' : 'long') };
        });
        var out = t.output || { kind: 'text' };
        var fields = out.kind === 'json' ? Object.keys((out.schema && out.schema.properties) || {}).map(function (k) { var p = out.schema.properties[k] || {}; return { label: p.title || k, key: k }; }) : [{ label: 'Answer' }];
        return { id: t.id, slug: t.slug, name: t.name, summary: t.summary, instructions: (t.prompt && t.prompt.instructions) || '', model: (t.prompt && t.prompt.model) || 'auto', modelName: (t.prompt && t.prompt.model) === 'auto' || !t.prompt ? 'Auto' : t.prompt.model, inputs: inputs.length ? inputs : [{ label: 'Text', kind: 'long' }], answer: out.kind === 'json' ? 'fields' : 'text', fields: fields.length ? fields : [{ label: 'Answer' }], visibility: t.visibility, version: t.version, kind: t.kind, runs: t.runs, source: t.kind === 'code' ? null : CODE_TEMPLATE,
            steps: t.kind === 'chain' && t.chain ? t.chain.steps.map(function (s) { return { tool: s.tool, name: s.name || s.tool, input: Object.assign({}, s.input) }; }) : [{ tool: '', name: '', input: {} }, { tool: '', name: '', input: {} }] };
    }

    /** The form as the API's body. */
    function bodyOf(f) {
        var taken = {}, props = {}, required = [];
        f.inputs.forEach(function (i) {
            var key = keyOf(i.label, taken);
            props[key] = i.kind === 'number' ? { type: 'number', title: i.label } : { type: 'string', title: i.label, maxLength: i.kind === 'short' ? 500 : 20000 };
            required.push(key);
        });
        var output = { kind: 'text' };
        if (f.answer === 'fields') {
            var t2 = {}, op = {}, oreq = [];
            f.fields.forEach(function (x) { var k = keyOf(x.label, t2); op[k] = { type: 'string', title: x.label }; oreq.push(k); });
            output = { kind: 'json', schema: { type: 'object', required: oreq, properties: op } };
        }
        var base = { slug: f.slug || slugOf(f.name), name: f.name.trim(), summary: f.summary.trim(), input: { type: 'object', required: required, properties: props }, output: output, visibility: f.visibility };
        if (f.kind === 'code') return Object.assign(base, { kind: 'code', source_code: f.source || '', net: 'deny', hosting: 'openvibe' });
        if (f.kind === 'chain') {
            return Object.assign(base, { kind: 'chain', chain: { steps: f.steps.map(function (s) {
                var input = {};
                Object.keys(s.input || {}).forEach(function (k) { var v = s.input[k]; if (v !== '' && v != null) input[k] = /^-?\d+(\.\d+)?$/.test(String(v)) ? Number(v) : v; });
                return { tool: s.tool, name: (s.name || s.tool).slice(0, 80), input: input };
            }) } });
        }
        return Object.assign(base, { kind: 'prompt', prompt: { instructions: f.instructions.trim(), model: f.model || 'auto' } });
    }

    // ── The page ───────────────────────────────────────────────
    var grid = h('div', 'mk-grid');
    var formCol = h('div', 'mk-col');
    var side = h('div', 'mk-col mk-side');
    grid.append(formCol, side);
    var status = h('p', 'mk-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');

    function say(text, kind) { status.textContent = text || ''; status.className = 'mk-status' + (kind ? ' is-' + kind : ''); }

    function field(labelText, control, hint) {
        var l = h('label', 'mk-field');
        l.append(h('span', 'mk-label', labelText), control);
        if (hint) l.append(h('small', 'mk-hint', hint));
        return l;
    }
    function seg(name, options, value, onChange, label) {
        var s = h('span', 'ovk-seg');
        s.setAttribute('role', 'radiogroup');
        if (label) s.setAttribute('aria-label', label);
        options.forEach(function (o) {
            var l = h('label'); var i = h('input'); i.type = 'radio'; i.name = name; i.value = o[0]; i.checked = o[0] === value;
            i.addEventListener('change', function () { if (i.checked) onChange(o[0]); });
            l.append(i, h('span', null, o[1])); s.append(l);
        });
        return s;
    }
    function section(title, sub) {
        var s = h('section', 'mk-sec mk-enter');
        s.append(h('h2', null, title));
        if (sub) s.append(h('p', 'mk-sub', sub));
        return s;
    }
    function iconButton(label, glyph, onClick) {
        var b = h('button', 'mk-icon'); b.type = 'button'; b.setAttribute('aria-label', label); b.title = label;
        b.textContent = glyph; b.addEventListener('click', onClick); return b;
    }

    function drawForm() {
        var f = state.form;
        formCol.textContent = '';
        var form = h('form', 'ovk-form mk-form'); form.noValidate = true;

        // Describe it (§AD.12 (d); the owner, 11-15: "create a tool for you completely end to end"): a model drafts the
        // whole form from a sentence or two, as you (your allowance pays); you check it, try it and make it.
        var sd = null;
        if (!f.id && f.kind !== 'chain') {
            sd = section('Describe it', f.kind === 'code' ? 'Say what you want. A model writes the code below; you check it, try it and make it.' : 'Say what you want. A model drafts the tool below; you check it, try it and make it.');
            sd.classList.add('mk-describe');
            var ta = h('textarea'); ta.rows = 3; ta.maxLength = 2000; ta.value = state.describe || '';
            ta.placeholder = 'A tool that turns a messy meeting note into a summary, the decisions, and the action items with who does each.';
            ta.addEventListener('input', function () { state.describe = ta.value; });
            var dnote = h('p', 'mk-hint'); dnote.setAttribute('role', 'status');
            var go = btn('Draft it', 'primary', function () {
                var text = ta.value.trim();
                if (text.length < 8) { dnote.textContent = 'Say in a sentence or two what it should do.'; return; }
                go.disabled = true; go.textContent = 'Drafting…'; dnote.textContent = '';
                api('/draft', { method: 'POST', body: { description: text, kind: f.kind === 'code' ? 'code' : 'prompt' } }).then(function (res) {
                    go.disabled = false; go.textContent = 'Draft it';
                    if (!res.ok || !res.body || !res.body.draft) { dnote.textContent = words(res, 'It could not draft that. Try other words.'); return; }
                    var d = res.body.draft;
                    var keep = state.form;
                    state.form = Object.assign(blank(), { kind: d.kind === 'code' ? 'code' : keep.kind, source: d.source || keep.source, name: d.name, summary: d.summary, instructions: d.instructions || '',
                        inputs: d.inputs.map(function (x) { return { label: x.label, kind: x.kind }; }), answer: d.answer,
                        fields: d.fields.map(function (x) { return { label: x.label }; }), model: keep.model, modelName: keep.modelName, modelSub: keep.modelSub, visibility: keep.visibility });
                    drawForm();
                    say('Drafted' + (res.body.model ? ' by ' + res.body.model : '') + '. Check it, then Make it.', 'good');
                    var first = formCol.querySelectorAll('.mk-sec')[1];
                    if (first) first.scrollIntoView({ behavior: 'smooth', block: 'start' });
                });
            });
            go.classList.add('mk-draft-go');
            sd.append(field('What should it do?', ta), go, dnote);
        }

        var s1 = section('What it is');
        var name = h('input'); name.maxLength = 80; name.value = f.name; name.placeholder = 'Reply kindly'; name.required = true; name.autocomplete = 'off';
        name.addEventListener('input', function () { f.name = name.value; });
        var summary = h('input'); summary.maxLength = 200; summary.value = f.summary; summary.placeholder = 'Drafts a short, kind reply to a message.'; summary.required = true;
        summary.addEventListener('input', function () { f.summary = summary.value; });
        s1.append(field('Name', name), field('What it does, in one sentence', summary, 'People and agents read this to decide when to use it.'));

        // How it works: a model (a prompt) or your own code (run(input)); a tool keeps its kind once made.
        var sk = null;
        if (!f.id) {
            sk = section('How it works');
            sk.append(seg('kind', [['prompt', 'A model'], ['code', 'My code'], ['chain', 'Tools in a row']], f.kind, function (v) { f.kind = v; drawForm(); }, 'How it works'));
        }
        var s2c = null;
        if (f.kind === 'code') {
            s2c = section('The code', 'run(input) gets the inputs below and returns the answer. It runs in a sandbox with no network: on this page in the browser now, on Link machines for agents and the API next.');
            var ed = h('textarea', 'mk-code'); ed.rows = 12; ed.spellcheck = false; ed.autocapitalize = 'off'; ed.setAttribute('autocorrect', 'off'); ed.maxLength = 65536;
            ed.setAttribute('aria-label', 'The code');
            if (f.source == null) {
                ed.value = 'Loading the code…'; ed.disabled = true;
                fetch('/api/v1/made-tools/' + encodeURIComponent(f.id) + '/source', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.text() : ''; }).then(function (t) { f.source = t || ''; drawForm(); });
            } else ed.value = f.source;
            ed.addEventListener('input', function () { f.source = ed.value; });
            ed.addEventListener('keydown', function (e) {
                if (e.key !== 'Tab' || e.shiftKey) return;
                e.preventDefault();
                var a = ed.selectionStart, b = ed.selectionEnd;
                ed.value = ed.value.slice(0, a) + '  ' + ed.value.slice(b); ed.selectionStart = ed.selectionEnd = a + 2; f.source = ed.value;
            });
            s2c.append(ed);
        }
        // A chain: steps, each a tool and its input (literal words, the chain's input, or an earlier step's answer).
        var s2ch = null;
        if (f.kind === 'chain') {
            s2ch = section('The steps', 'Each step runs one tool, in order. Its input can be words, the chain\'s own input, or an earlier step\'s answer.');
            var inputKeys = (function () { var t = {}; return f.inputs.map(function (i) { return keyOf(i.label, t); }); })();
            f.steps.forEach(function (st, n) {
                var card = h('div', 'mk-step');
                var headRow = h('div', 'mk-step-head');
                headRow.append(h('span', 'mk-step-n', String(n + 1)));
                var pickBtn = h('button', 'mk-model mk-step-tool'); pickBtn.type = 'button';
                var mine = st.tool && state.mine.some(function (x) { return x.id === st.tool; });
                pickBtn.append(h('span', 'mk-model-name', st.tool ? (st.name || st.tool) : 'Pick a tool'),
                    h('span', 'mk-model-sub', !st.tool ? 'Search the catalogue and the tools people made' : /^mtl_/.test(st.tool) ? (mine ? 'A tool you made' : 'A tool someone made') : 'openvibe.tools/' + st.tool));
                pickBtn.addEventListener('click', function () { picker.pick(function (tl) { st.tool = tl.tool; st.name = tl.name || tl.tool; st.input = {}; drawForm(); }); });
                headRow.append(pickBtn);
                if (f.steps.length > 2) headRow.append(iconButton('Remove this step', '×', function () { f.steps.splice(n, 1); drawForm(); }));
                card.append(headRow);
                if (st.tool) {
                    var fieldsBox = h('div', 'mk-step-fields'); fieldsBox.append(h('p', 'mk-hint', 'Loading what it takes…'));
                    card.append(fieldsBox);
                    // The answers of the steps before this one, field by field (a text answer is one chip).
                    var earlier = f.steps.slice(0, n).map(function (prev) { return prev.tool ? schemaFor(prev.tool) : Promise.resolve({ output: null }); });
                    Promise.all([schemaFor(st.tool)].concat(earlier)).then(function (all) {
                        var schema = all[0].input, prevOut = all.slice(1).map(function (x) { return x.output; });
                        fieldsBox.textContent = '';
                        var props = (schema && schema.properties) || {};
                        var req = (schema && schema.required) || [];
                        var keys = Object.keys(props);
                        if (!keys.length) { fieldsBox.append(h('p', 'mk-hint', 'It takes nothing.')); return; }
                        keys.slice(0, 8).forEach(function (k) {
                            var p = props[k] || {};
                            var inp = h('input'); inp.value = st.input[k] == null ? '' : String(st.input[k]); inp.placeholder = (p.description || p.title || k).slice(0, 80);
                            // What a template takes, in words, under the field.
                            var says = h('small', 'mk-hint mk-takes');
                            var plain = function () {
                                var m = /^\s*\{\{\s*(input|steps)\.([A-Za-z0-9_.-]+)\s*\}\}\s*$/.exec(inp.value);
                                if (!m) { says.textContent = ''; return; }
                                if (m[1] === 'input') { var i = inputKeys.indexOf(m[2]); says.textContent = 'Takes the chain\'s ' + (i >= 0 ? (f.inputs[i].label || m[2]) : m[2]); return; }
                                var parts = m[2].split('.'); says.textContent = 'Takes step ' + (Number(parts[0]) + 1) + '\'s ' + (parts.slice(1).join('.') || 'answer');
                            };
                            plain();
                            inp.addEventListener('input', function () { st.input[k] = inp.value; plain(); });
                            var chips = h('div', 'mk-chips');
                            inputKeys.forEach(function (ik, i) { chips.append(btn('Input: ' + (f.inputs[i].label || ik), 'quiet', function () { inp.value = '{{input.' + ik + '}}'; st.input[k] = inp.value; plain(); })); });
                            prevOut.forEach(function (out, m) {
                                var outKeys = out && out.properties ? Object.keys(out.properties).slice(0, 6) : [];
                                if (!outKeys.length) { chips.append(btn('Step ' + (m + 1) + '\'s answer', 'quiet', function () { inp.value = '{{steps.' + m + '}}'; st.input[k] = inp.value; plain(); })); return; }
                                outKeys.forEach(function (ok) { chips.append(btn('Step ' + (m + 1) + ': ' + ((out.properties[ok] && out.properties[ok].title) || ok), 'quiet', function () { inp.value = '{{steps.' + m + '.' + ok + '}}'; st.input[k] = inp.value; plain(); })); });
                            });
                            fieldsBox.append(field((p.title || k) + (req.indexOf(k) >= 0 ? '' : ' (optional)'), inp), says, chips);
                        });
                    });
                }
                s2ch.append(card);
            });
            if (f.steps.length < 8) s2ch.append(btn('Add a step', 'quiet', function () { f.steps.push({ tool: '', name: '', input: {} }); drawForm(); }));
        }
        var s2 = section('What the model does');
        var ins = h('textarea'); ins.maxLength = 8000; ins.rows = 5; ins.value = f.instructions; ins.required = true;
        ins.placeholder = 'Write a short, kind reply to the message. Keep it under three sentences.';
        ins.addEventListener('input', function () { f.instructions = ins.value; });
        var pick = h('button', 'mk-model'); pick.type = 'button';
        pick.append(h('span', 'mk-model-name', f.modelName || f.model), h('span', 'mk-model-sub', f.model === 'auto' ? 'The cheapest model that does the job' : (f.modelSub || f.model)));
        pick.setAttribute('aria-label', 'Model: ' + (f.modelName || f.model) + '. Change it');
        pick.addEventListener('click', openModels);
        s2.append(field('Instructions', ins, 'The input follows as data. Whoever runs the tool pays for the model from their own allowance.'), h('span', 'mk-label', 'Model'), pick);

        var s3 = section('What it takes', 'Each input is a field people fill in, or an agent sends.');
        var list = h('div', 'mk-rows');
        f.inputs.forEach(function (inp, idx) {
            var row = h('div', 'mk-row');
            var t = h('input'); t.value = inp.label; t.maxLength = 60; t.placeholder = 'Message'; t.setAttribute('aria-label', 'Input ' + (idx + 1) + ' name');
            t.addEventListener('input', function () { inp.label = t.value; });
            row.append(t, seg('kind-' + idx, KINDS, inp.kind, function (v) { inp.kind = v; }, 'Input ' + (idx + 1) + ' type'));
            if (f.inputs.length > 1) row.append(iconButton('Remove this input', '×', function () { f.inputs.splice(idx, 1); drawForm(); }));
            list.append(row);
        });
        s3.append(list);
        if (f.inputs.length < 12) s3.append(btn('Add an input', 'quiet', function () { f.inputs.push({ label: '', kind: 'short' }); drawForm(); var last = formCol.querySelectorAll('.mk-sec')[2].querySelectorAll('.mk-row input:not([type])'); if (last.length) last[last.length - 1].focus(); }));

        var s4 = section('What it gives back');
        s4.append(seg('answer', [['text', 'Text'], ['fields', 'Named fields']], f.answer, function (v) { f.answer = v; drawForm(); }, 'What it gives back'));
        if (f.answer === 'fields') {
            var fl = h('div', 'mk-rows');
            f.fields.forEach(function (x, idx) {
                var row = h('div', 'mk-row');
                var t = h('input'); t.value = x.label; t.maxLength = 60; t.placeholder = 'Reply'; t.setAttribute('aria-label', 'Field ' + (idx + 1) + ' name');
                t.addEventListener('input', function () { x.label = t.value; });
                row.append(t);
                if (f.fields.length > 1) row.append(iconButton('Remove this field', '×', function () { f.fields.splice(idx, 1); drawForm(); }));
                fl.append(row);
            });
            s4.append(fl);
            if (f.fields.length < 12) s4.append(btn('Add a field', 'quiet', function () { f.fields.push({ label: '' }); drawForm(); }));
        }

        var s5 = section('Who can use it');
        var vis = h('div', 'mk-vis'); vis.setAttribute('role', 'radiogroup'); vis.setAttribute('aria-label', 'Who can use it');
        VIS.forEach(function (o) {
            var l = h('label', 'mk-vis-opt'); var i = h('input'); i.type = 'radio'; i.name = 'visibility'; i.value = o[0]; i.checked = o[0] === f.visibility;
            i.addEventListener('change', function () { if (i.checked) f.visibility = o[0]; });
            l.append(i, h('b', null, o[1]), h('small', null, o[2])); vis.append(l);
        });
        s5.append(vis);

        var bar = h('p', 'ovk-save mk-save');
        var save = btn(f.id ? 'Save changes' : 'Make it', 'primary', null, 'submit');
        save.disabled = state.saving;
        bar.append(save);
        if (f.id) bar.append(btn('New tool', 'quiet', function () { state.form = blank(); drawAll(); }));

        if (sk) form.append(sk);
        if (sd) form.append(sd);
        form.append(s1);
        form.append(f.kind === 'code' ? s2c : f.kind === 'chain' ? s3 : s2, f.kind === 'chain' ? s2ch : s3, s4, s5, status, bar);
        if (f.id) form.append(deleteRow(f));
        form.addEventListener('submit', function (e) { e.preventDefault(); submit(); });
        formCol.append(form);
    }

    function deleteRow(f) {
        var p = h('p', 'mk-danger');
        var d = btn('Delete this tool', 'quiet', function () {
            if (d.dataset.sure !== '1') { d.dataset.sure = '1'; d.textContent = 'Delete it for good?'; d.classList.add('is-sure'); return; }
            api('/' + encodeURIComponent(f.id), { method: 'DELETE' }).then(function (res) {
                if (!res.ok) return say(words(res, 'It was not deleted. Try again.'), 'bad');
                state.mine = state.mine.filter(function (t) { return t.id !== f.id; });
                state.form = blank(); say('Deleted.', 'good'); drawAll();
            });
        });
        p.append(d);
        return p;
    }

    function check(f) {
        if (!f.name.trim()) return 'Give it a name.';
        if (!f.summary.trim()) return 'Say what it does, in one sentence.';
        if (f.kind === 'chain') { if (f.steps.length < 2 || f.steps.some(function (s) { return !s.tool; })) return 'A chain needs at least two steps, each with a tool.'; }
        else if (f.kind === 'code' ? !/\brun\b/.test(f.source || '') : !f.instructions.trim()) return f.kind === 'code' ? 'Write a run(input) function that returns the answer.' : 'Tell the model what to do.';
        if (f.inputs.some(function (i) { return !String(i.label).trim(); })) return 'Name every input (or remove the empty one).';
        if (f.answer === 'fields' && f.fields.some(function (x) { return !String(x.label).trim(); })) return 'Name every field (or remove the empty one).';
        return '';
    }

    function submit() {
        var f = state.form;
        var problem = check(f);
        if (problem) return say(problem, 'bad');
        state.saving = true; say(f.id ? 'Saving…' : 'Making it…');
        var body = bodyOf(f);
        var req = f.id ? api('/' + encodeURIComponent(f.id), { method: 'PATCH', body: body }) : api('', { method: 'POST', body: body });
        req.then(function (res) {
            state.saving = false;
            if (res.status === 409 && !f.id) { f.slug = slugOf(f.name).slice(0, 34) + '-' + Math.random().toString(36).slice(2, 6); return submit(); }
            if (!res.ok || !res.body) return say(words(res, 'It was not saved. Try again.'), 'bad');
            var t = res.body;
            state.mine = [t].concat(state.mine.filter(function (x) { return x.id !== t.id; }));
            state.form = formOf(t); state.form.modelName = f.modelName; state.form.modelSub = f.modelSub;
            drawAll();
            say(f.id ? 'Saved: version ' + t.version + '.' : 'Made. Try it below.', 'good');
            var tryBox = document.getElementById('mk-try');
            if (tryBox && window.matchMedia('(max-width: 959px)').matches) tryBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    }

    // ── Run it on its own (§AD.12 (g)): a private link, or a schedule ──
    function ago(iso) {
        if (!iso) return '';
        var s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
        return s < 90 ? 'just now' : s < 5400 ? Math.round(s / 60) + ' min ago' : s < 129600 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' days ago';
    }
    function whenNext(iso) {
        if (!iso) return '';
        var d = new Date(iso);
        var hm = String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
        var today = new Date(); var same = d.toISOString().slice(0, 10) === today.toISOString().slice(0, 10);
        return 'next ' + (same ? 'today' : d.toISOString().slice(0, 10)) + ' ' + hm + ' UTC';
    }
    function preview(r) {
        if (!r) return '';
        if (r.error) return r.error;
        if (r.text != null) return String(r.text);
        return JSON.stringify(r.data !== undefined ? r.data : r);
    }
    /** The tool's input fields, for a trigger's fixed input (empty ones are left out). */
    function inputFields(t, box) {
        var props = (t.input && t.input.properties) || {};
        var controls = {};
        Object.keys(props).forEach(function (k) {
            var p = props[k] || {};
            var c = p.type === 'string' && (!p.maxLength || p.maxLength > 500) ? h('textarea') : h('input');
            if (c.tagName === 'TEXTAREA') c.rows = 2;
            if (p.type === 'number' || p.type === 'integer') { c.type = 'number'; c.inputMode = 'decimal'; }
            controls[k] = c;
            box.append(field(p.title || k, c));
        });
        return function () {
            var out = {};
            Object.keys(controls).forEach(function (k) { var v = controls[k].value; if (v !== '') out[k] = controls[k].type === 'number' ? Number(v) : v; });
            return out;
        };
    }
    function drawAuto(t) {
        var box = h('section', 'mk-card mk-enter mk-auto'); box.id = 'mk-auto';
        box.append(h('h2', null, 'Run it on its own'));
        box.append(h('p', 'mk-sub', 'From a private link (a webhook, a form, a shortcut) or on a schedule. Every run is yours: your allowance pays.'));
        var list = h('div', 'mk-trigs');
        var adders = h('p', 'mk-auto-add');
        var panel = h('div', 'mk-auto-panel');
        var say2 = h('p', 'mk-status'); say2.setAttribute('role', 'status'); say2.setAttribute('aria-live', 'polite');
        box.append(list, panel, adders, say2);
        var base = '/' + encodeURIComponent(t.id) + '/triggers';
        function row(tr) {
            var r = h('div', 'mk-trig');
            var ic = h('span', 'mk-trig-ic'); ic.setAttribute('aria-hidden', 'true');
            var g = h('i'); g.setAttribute('data-ov-icon', tr.kind === 'link' ? 'link' : 'clock'); ic.append(g);
            var main = h('div', 'mk-trig-main');
            main.append(h('strong', null, tr.says));
            var bits = [];
            if (tr.last_run_at) bits.push((tr.last_state === 'succeeded' ? 'Ran ' : 'Failed ') + ago(tr.last_run_at));
            else bits.push('Not run yet');
            if (tr.kind === 'schedule' && tr.enabled) bits.push(whenNext(tr.next_run_at));
            if (!tr.enabled) bits.push('paused');
            else if (tr.kind === 'schedule' && tr.notify) bits.push('tells you');
            if (tr.runs) bits.push(tr.runs + (tr.runs === 1 ? ' run' : ' runs'));
            main.append(h('small', null, bits.join(' · ')));
            if (tr.last_result) {
                var d = h('details', 'mk-trig-last'); var sm = h('summary', null, 'Last answer'); d.append(sm, h('pre', null, preview(tr.last_result).slice(0, 1200)));
                main.append(d);
            }
            var sw = h('input', 'ovk-switch'); sw.type = 'checkbox'; sw.setAttribute('role', 'switch'); sw.checked = tr.enabled;
            sw.setAttribute('aria-label', (tr.enabled ? 'Pause ' : 'Turn on ') + tr.says);
            sw.addEventListener('change', function () {
                sw.disabled = true;
                api(base + '/' + tr.id, { method: 'PATCH', body: { enabled: sw.checked } }).then(function (res) { sw.disabled = false; if (!res.ok) { sw.checked = !sw.checked; say2.textContent = words(res, 'That did not change. Try again.'); return; } load(); });
            });
            var del = btn('', 'quiet', function () {
                del.disabled = true;
                api(base + '/' + tr.id, { method: 'DELETE' }).then(function (res) { if (!res.ok) { del.disabled = false; say2.textContent = words(res, 'It was not deleted. Try again.'); return; } load(); });
            });
            del.classList.add('mk-trig-del'); del.setAttribute('aria-label', 'Delete ' + tr.says);
            var x = h('i'); x.setAttribute('data-ov-icon', 'trash'); del.append(x);
            r.append(ic, main, sw, del);
            return r;
        }
        function load() {
            api(base).then(function (res) {
                list.textContent = ''; adders.textContent = '';
                if (!res.ok || !res.body) { list.append(h('p', 'mk-sub', words(res, 'Its triggers did not load.'))); return; }
                if (res.body.unsupported) { list.append(h('p', 'mk-sub', res.body.unsupported + '.')); return; }
                (res.body.triggers || []).forEach(function (tr) { list.append(row(tr)); });
                adders.append(btn('Add a link', 'quiet', function () { openLink(); }), btn('Add a schedule', 'quiet', function () { openSchedule(); }));
                if (window.OVGlyphs && typeof window.OVGlyphs.swap === 'function') { try { window.OVGlyphs.swap(box); } catch (e) { /* the navbar draws them later */ } }
            });
        }
        function openLink() {
            panel.textContent = '';
            var f = h('form', 'ovk-form mk-auto-form'); f.noValidate = true;
            f.append(h('p', 'mk-hint', 'Anything you fill in here is always sent; what a request sends goes on top. A webhook\'s own payload fills a tool with one text field.'));
            var read = inputFields(t, f);
            var bar = h('p', 'mk-auto-bar');
            bar.append(btn('Make the link', 'primary', null, 'submit'), btn('Cancel', 'quiet', function () { panel.textContent = ''; }));
            f.append(bar);
            f.addEventListener('submit', function (e) {
                e.preventDefault();
                api(base, { method: 'POST', body: { kind: 'link', input: read() } }).then(function (res) {
                    if (!res.ok || !res.body) { say2.textContent = words(res, 'The link was not made. Try again.'); return; }
                    panel.textContent = '';
                    var made = h('div', 'mk-auto-new');
                    made.append(h('strong', null, 'Your link: copy it now, it is shown once'));
                    var u = h('input', 'mk-auto-url'); u.readOnly = true; u.value = res.body.url; u.setAttribute('aria-label', 'The link');
                    var copy = btn('Copy', 'primary', function () {
                        u.select();
                        if (navigator.clipboard) navigator.clipboard.writeText(res.body.url).then(function () { copy.textContent = 'Copied'; }, function () {});
                    });
                    var keys = Object.keys((t.input && t.input.properties) || {});
                    var sample = {}; keys.slice(0, 2).forEach(function (k) { sample[k] = '…'; });
                    var curl = h('pre', 'mk-auto-curl', "curl -X POST '" + res.body.url + "' -H 'Content-Type: application/json' -d '" + JSON.stringify(sample) + "'");
                    var urlRow = h('p', 'mk-auto-urlrow'); urlRow.append(u, copy);
                    made.append(urlRow, curl, btn('Done', 'quiet', function () { panel.textContent = ''; }));
                    panel.append(made);
                    load();
                });
            });
            panel.append(f);
        }
        function openSchedule() {
            panel.textContent = '';
            var f = h('form', 'ovk-form mk-auto-form'); f.noValidate = true;
            var every = 'day';
            var at = h('input'); at.type = 'time'; at.value = '09:00'; at.step = 60;
            var atField = field('At (UTC)', at, 'Your time now is ' + new Date().toISOString().slice(11, 16) + ' UTC.');
            f.append(field('Every', seg('mk-every', [['hour', 'Hour'], ['day', 'Day']], every, function (v) { every = v; atField.querySelector('.mk-label').textContent = v === 'hour' ? 'At minute (the hour does not matter)' : 'At (UTC)'; }, 'How often')), atField);
            var read = inputFields(t, f);
            var tell = h('label', 'mk-auto-tell');
            var tellSw = h('input', 'ovk-switch'); tellSw.type = 'checkbox'; tellSw.setAttribute('role', 'switch'); tellSw.checked = true;
            tell.append(h('span', null, 'Tell me what it answered, each time'), tellSw);
            f.append(tell);
            var bar = h('p', 'mk-auto-bar');
            bar.append(btn('Make the schedule', 'primary', null, 'submit'), btn('Cancel', 'quiet', function () { panel.textContent = ''; }));
            f.append(bar);
            f.addEventListener('submit', function (e) {
                e.preventDefault();
                api(base, { method: 'POST', body: { kind: 'schedule', every: every, at: at.value || '00:00', input: read(), notify: tellSw.checked } }).then(function (res) {
                    if (!res.ok) { say2.textContent = words(res, 'The schedule was not made. Try again.'); return; }
                    panel.textContent = ''; say2.textContent = res.body.says + ': ' + whenNext(res.body.next_run_at) + '.';
                    load();
                });
            });
            panel.append(f);
        }
        load();
        return box;
    }

    // ── Try it ─────────────────────────────────────────────────
    function drawTry(t) {
        var box = h('section', 'mk-card mk-enter'); box.id = 'mk-try';
        box.append(h('h2', null, 'Try ' + t.name));
        var form = h('form', 'ovk-form'); form.noValidate = true;
        var props = (t.input && t.input.properties) || {};
        var controls = {};
        Object.keys(props).forEach(function (k) {
            var p = props[k] || {};
            var c = p.type === 'string' && (!p.maxLength || p.maxLength > 500) ? h('textarea') : h('input');
            if (p.type === 'number' || p.type === 'integer') { c.type = 'number'; c.inputMode = 'decimal'; }
            if (p.maxLength) c.maxLength = p.maxLength;
            if (c.tagName === 'TEXTAREA') c.rows = 3;
            controls[k] = c;
            form.append(field(p.title || k, c));
        });
        var out = h('div', 'mk-answer'); out.setAttribute('aria-live', 'polite');
        var run = btn('Run', 'primary', null, 'submit');
        form.append(run, out);
        form.addEventListener('submit', function (e) {
            e.preventDefault();
            var input = {};
            Object.keys(controls).forEach(function (k) {
                var v = controls[k].value;
                input[k] = controls[k].type === 'number' ? (v === '' ? 0 : Number(v)) : v;
            });
            run.disabled = true; out.textContent = ''; out.className = 'mk-answer is-busy'; out.append(h('span', 'mk-dots', 'Running'));
            var started = Date.now();
            var go = t.kind === 'code'
                ? fetch('/api/v1/made-tools/' + encodeURIComponent(t.id) + '/source', { credentials: 'same-origin' })
                    .then(function (r) { return r.ok ? r.text() : Promise.reject(new Error('The code could not be read')); })
                    .then(function (src) { return runInSandbox(src, input, 10000); })
                    .then(function (r) { return r.ok ? { status: 200, ok: true, body: { state: 'succeeded', result: (r.out && typeof r.out === 'object' && !Array.isArray(r.out)) ? { data: r.out } : { text: typeof r.out === 'string' ? r.out : JSON.stringify(r.out) }, model: 'your browser', took_ms: Date.now() - started } } : { status: 200, ok: true, body: { state: 'failed', error: { detail: r.error } } }; },
                        function (err) { return { status: 0, ok: false, body: { detail: (err && err.message) || 'It did not run' } }; })
                : api('/' + encodeURIComponent(t.id) + '/run', { method: 'POST', body: { input: input } });
            go.then(function (res) {
                run.disabled = false; out.className = 'mk-answer mk-enter'; out.textContent = '';
                var b = res.body || {};
                if (res.status === 401) { out.append(h('p', 'mk-bad', 'Sign in to run it: the run is paid from your own allowance.')); return; }
                if (!res.ok) { out.append(h('p', 'mk-bad', words(res, 'It did not run. Try again.'))); return; }
                if (b.state !== 'succeeded') { out.append(h('p', 'mk-bad', (b.error && (b.error.detail || b.error.title)) || 'It did not run. Try again.')); return; }
                if (b.result && b.result.data && typeof b.result.data === 'object') {
                    var dl = h('dl', 'mk-fields');
                    var oprops = (t.output && t.output.schema && t.output.schema.properties) || {};
                    Object.keys(b.result.data).forEach(function (k) {
                        dl.append(h('dt', null, (oprops[k] && oprops[k].title) || k));
                        var v = b.result.data[k];
                        dl.append(h('dd', null, typeof v === 'string' ? v : JSON.stringify(v)));
                    });
                    out.append(dl);
                } else out.append(h('p', 'mk-text', (b.result && b.result.text) || ''));
                var meta = [];
                if (b.model) meta.push(b.model);
                if (b.usage && b.usage.cost_usd != null) meta.push(b.usage.cost_usd < 0.0001 ? 'under $0.0001' : '$' + Number(b.usage.cost_usd).toFixed(4));
                if (b.took_ms != null) meta.push((b.took_ms / 1000).toFixed(1) + ' s');
                if (meta.length) out.append(h('small', 'mk-meta', meta.join(' · ')));
            });
        });
        box.append(form);
        if (t.visibility !== 'private') {
            var share = h('p', 'mk-share');
            var link = location.origin + '/make#' + t.id;
            var code = h('code', null, link);
            share.append(code, btn('Copy link', 'quiet', function (e) {
                var b = e.currentTarget;
                if (navigator.clipboard) navigator.clipboard.writeText(link).then(function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy link'; }, 1600); }, function () {});
            }));
            box.append(share);
        }
        return box;
    }

    // ── Lists ──────────────────────────────────────────────────
    function rowOf(t, onOpen, mine) {
        var b = h('button', 'mk-tool'); b.type = 'button';
        var meta = mine ? [visLabel(t.visibility), (t.runs || 0) + (t.runs === 1 ? ' run' : ' runs'), 'v' + t.version] : [(t.runs || 0) + (t.runs === 1 ? ' run' : ' runs')];
        b.append(h('b', null, t.name), h('span', null, t.summary), h('small', null, meta.join(' · ')));
        b.addEventListener('click', function () { onOpen(t); });
        return b;
    }

    function drawSide() {
        side.textContent = '';
        var f = state.form;
        if (f.id) {
            var t = state.mine.filter(function (x) { return x.id === f.id; })[0];
            if (t) side.append(drawTry(t), drawAuto(t));
        }
        if (state.signedIn) {
            var yours = h('section', 'mk-card mk-enter');
            yours.append(h('h2', null, 'Your tools'));
            if (!state.mine.length) yours.append(h('p', 'mk-sub', 'Nothing yet. The tools you make show here, ready to change, try and share.'));
            var ul = h('div', 'mk-tools');
            state.mine.forEach(function (x) { ul.append(rowOf(x, function (tool) { state.form = formOf(tool); drawAll(); window.scrollTo({ top: root.offsetTop - 70, behavior: 'smooth' }); }, true)); });
            yours.append(ul);
            side.append(yours);
        }
        side.append(publicList());
    }

    function publicList() {
        var sec = h('section', 'mk-card mk-enter');
        sec.append(h('h2', null, 'Tools people made'));
        var box = h('div', 'mk-tools'); box.append(h('p', 'mk-sub', 'Loading…'));
        sec.append(box);
        api('').then(function (res) {
            box.textContent = '';
            var tools = (res.body && res.body.tools) || [];
            if (!tools.length) { box.append(h('p', 'mk-sub', 'None shared yet. Make one and pick Everyone to be the first.')); return; }
            tools.forEach(function (t) {
                box.append(rowOf(t, function (tool) {
                    var open = sec.querySelector('#mk-try');
                    if (open) open.remove();
                    var tr = drawTry(tool); sec.insertBefore(tr, box);
                    tr.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }, false));
            });
        });
        return sec;
    }

    // ── The model sheet ────────────────────────────────────────
    var sheet = h('dialog', 'ovk-sheet mk-sheet');
    sheet.setAttribute('aria-labelledby', 'mk-sheet-t');
    (function () {
        var head = h('div', 'ovk-sheet-head');
        var t = h('h2', null, 'Pick a model'); t.id = 'mk-sheet-t';
        var close = h('button', 'ovk-icon-btn mk-icon', '×'); close.type = 'button'; close.setAttribute('aria-label', 'Close');
        close.addEventListener('click', function () { sheet.close(); });
        head.append(t, close);
        var body = h('div', 'ovk-sheet-body');
        var find = h('input', 'mk-find'); find.type = 'search'; find.placeholder = 'Find a model or a provider'; find.setAttribute('aria-label', 'Find a model');
        var count = h('p', 'mk-hint');
        var list = h('div', 'mk-models');
        body.append(find, count, list);
        sheet.append(head, body);
        sheet.addEventListener('click', function (e) { if (e.target === sheet) sheet.close(); });
        function choose(id, name, sub) { state.form.model = id; state.form.modelName = name; state.form.modelSub = sub; sheet.close(); drawForm(); }
        function option(id, name, sub, badge, on) {
            var b = h('button', 'mk-opt' + (on ? ' is-on' : '')); b.type = 'button';
            var top = h('span', 'mk-opt-top'); top.append(h('b', null, name));
            if (badge) top.append(h('span', 'mk-badge' + (badge === 'Runs here' ? ' is-here' : ''), badge));
            b.append(top, h('small', null, sub));
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
            b.addEventListener('click', function () { choose(id, name, sub); });
            return b;
        }
        function draw() {
            list.textContent = '';
            var q = find.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
            var all = (state.models && state.models.models) || [];
            var hits = all.filter(function (m) { var s = (m.name + ' ' + m.provider + ' ' + m.id).toLowerCase(); return q.every(function (w) { return s.indexOf(w) >= 0; }); });
            if (!q.length) list.append(option('auto', 'Auto', 'The cheapest model that does the job', 'Recommended', state.form.model === 'auto'));
            hits.slice(0, 120).forEach(function (m) {
                var price = m.in == null ? 'Price not listed' : money(m.in) + ' in · ' + money(m.out) + ' out per million tokens';
                list.append(option(m.id, m.name, (m.provider ? m.provider + ' · ' : '') + price, m.here ? 'Runs here' : 'Your key', state.form.model === m.id));
            });
            count.textContent = state.models ? (q.length ? hits.length + ' of ' + all.length + ' models' : all.length + ' models on OpenVibe.Exchange. “Runs here” models need no key of your own.') : 'Loading the models…';
        }
        find.addEventListener('input', draw);
        sheet.redraw = draw;
        sheet.focusFind = function () { find.value = ''; draw(); setTimeout(function () { find.focus(); }, 30); };
    })();
    document.body.append(sheet);
    function openModels() {
        if (typeof sheet.showModal === 'function') sheet.showModal(); else sheet.setAttribute('open', '');
        sheet.focusFind();
        if (!state.models) api('/models').then(function (res) { state.models = (res.body && Array.isArray(res.body.models)) ? res.body : { models: [] }; sheet.redraw(); });
    }

    // ── Start ──────────────────────────────────────────────────
    function drawAll() { drawForm(); drawSide(); }

    function signedOut() {
        formCol.textContent = '';
        var card = h('section', 'mk-card mk-enter mk-gate');
        card.append(h('h2', null, 'Sign in to make your own tools'), h('p', 'mk-sub', 'One OpenVibe account. Your tools are yours: change them, share them, delete them.'));
        var a = h('a', 'ovk-btn ovk-btn--primary', 'Sign in'); a.href = '/auth/login?next=' + encodeURIComponent('/make' + location.hash);
        card.append(a);
        formCol.append(card);
        drawSide();
    }

    root.textContent = '';
    root.append(grid);
    // Signed out, the page never asks for "your tools" (a 401 is a console error the browser check counts): /auth/me first.
    fetch('/auth/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : { user: null }; })
        .catch(function () { return { user: null }; })
        .then(function (me) { return me && me.user ? api('?mine=1') : { status: 401, ok: false, body: null }; })
        .then(function (res) {
        if (res.status === 401) { state.signedIn = false; signedOut(); }
        else {
            state.signedIn = true;
            state.mine = (res.body && res.body.tools) || [];
            var want = location.hash.slice(1);
            var own = state.mine.filter(function (t) { return t.id === want; })[0];
            if (own) state.form = formOf(own);
            drawAll();
            if (!res.ok) say(words(res, 'Your tools could not be read just now.'), 'bad');
        }
        // A shared link (#mtl_…) opens that tool's Try it.
        var id = location.hash.slice(1);
        if (/^mtl_[0-9A-HJKMNP-TV-Z]{26}$/.test(id) && !state.mine.some(function (t) { return t.id === id; })) {
            api('/' + id).then(function (r2) { if (r2.ok && r2.body) side.prepend(drawTry(r2.body)); });
        }
    });
})();
