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

    // ── State ──────────────────────────────────────────────────
    function blank() {
        return { id: null, slug: '', name: '', summary: '', instructions: '', model: 'auto', modelName: 'Auto', inputs: [{ label: 'Text', kind: 'long' }], answer: 'text', fields: [{ label: 'Answer' }], visibility: 'private', version: 0 };
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
        return { id: t.id, slug: t.slug, name: t.name, summary: t.summary, instructions: (t.prompt && t.prompt.instructions) || '', model: (t.prompt && t.prompt.model) || 'auto', modelName: (t.prompt && t.prompt.model) === 'auto' || !t.prompt ? 'Auto' : t.prompt.model, inputs: inputs.length ? inputs : [{ label: 'Text', kind: 'long' }], answer: out.kind === 'json' ? 'fields' : 'text', fields: fields.length ? fields : [{ label: 'Answer' }], visibility: t.visibility, version: t.version, kind: t.kind, runs: t.runs };
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
        return {
            slug: f.slug || slugOf(f.name), name: f.name.trim(), summary: f.summary.trim(), kind: 'prompt',
            input: { type: 'object', required: required, properties: props },
            output: output, prompt: { instructions: f.instructions.trim(), model: f.model || 'auto' }, visibility: f.visibility,
        };
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

        var s1 = section('What it is');
        var name = h('input'); name.maxLength = 80; name.value = f.name; name.placeholder = 'Reply kindly'; name.required = true; name.autocomplete = 'off';
        name.addEventListener('input', function () { f.name = name.value; });
        var summary = h('input'); summary.maxLength = 200; summary.value = f.summary; summary.placeholder = 'Drafts a short, kind reply to a message.'; summary.required = true;
        summary.addEventListener('input', function () { f.summary = summary.value; });
        s1.append(field('Name', name), field('What it does, in one sentence', summary, 'People and agents read this to decide when to use it.'));

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

        form.append(s1, s2, s3, s4, s5, status, bar);
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
        if (!f.instructions.trim()) return 'Tell the model what to do.';
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
            api('/' + encodeURIComponent(t.id) + '/run', { method: 'POST', body: { input: input } }).then(function (res) {
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
            if (t) side.append(drawTry(t));
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
