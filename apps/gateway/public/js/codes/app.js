/* Barcode & QR tools (codes.html): one page for the family, a view per tool. Drawing is bwip-js (window.bwipjs) and
   draw.js; reading is read.js (ZXing in WebAssembly, or the browser's BarcodeDetector); smart.js knows what a text is.
   Everything happens in the browser: nothing typed, uploaded or scanned leaves it. */
(function () {
    'use strict';
    const S = window.OVCodesSmart, D = window.OVCodesDraw, R = window.OVCodesRead;
    const $ = (id) => document.getElementById(id);
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const icon = (name) => `<svg class="ic" aria-hidden="true"><use href="#i-${name}"/></svg>`;
    const store = { get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } } };
    const readCfg = $('codes-read');
    if (readCfg) { R.cfg.zxing = readCfg.dataset.zxing; R.cfg.zxingWasm = readCfg.dataset.zxingWasm; }

    // ── The tools: view, host, title, preset ─────────────────────────────────────────────────────────────────────────
    const TOOLS = {
        codes: { view: 'hub', host: 'barcodes', h1: 'Barcode & QR Tools', lead: 'Make, scan and check every kind of code, in your browser. Nothing you type or scan is uploaded.' },
        qr: { view: 'qr', host: 'qr-code-generator', tab: 'QR code', icon: 'qr', h1: 'QR Code Generator', lead: 'Links, Wi-Fi, contacts, events and more, styled your way and test-scanned before you download.', type: 'url' },
        wifiqr: { view: 'qr', host: 'wifi-qr-code', icon: 'wifi', h1: 'Wi-Fi QR Code', lead: 'Guests point their camera at it and join your network. The password never leaves this page.', type: 'wifi' },
        vcardqr: { view: 'qr', host: 'vcard-qr-code', icon: 'user', h1: 'Contact QR Code', lead: 'A vCard that every phone saves in one tap: for business cards, badges and signatures.', type: 'contact' },
        barcode: { view: 'barcode', host: 'barcode-generator', tab: 'Barcode', icon: 'barcode', h1: 'Barcode Generator', lead: 'More than a hundred symbologies. Type anything: the right one is suggested and its check digit verified.' },
        datamatrix: { view: 'barcode', host: 'data-matrix-generator', tab: 'Data Matrix', icon: 'matrix', h1: 'Data Matrix Generator', lead: 'Square or rectangular Data Matrix, and GS1 DataMatrix with checked Application Identifiers.', sym: 'datamatrix', sample: '(01)09506000134352(17)271231(10)ABC123' },
        code128: { view: 'barcode', host: 'code-128-generator', icon: 'barcode', h1: 'Code 128 Generator', lead: 'Dense, universal barcodes for labels, inventory and tickets.', sym: 'code128', sample: 'OV-2026-0042' },
        ean13: { view: 'barcode', host: 'ean-13-generator', icon: 'barcode', h1: 'EAN-13 Barcode Generator', lead: 'Type 12 digits and the check digit is added, or 13 and it is verified.', sym: 'ean13', sample: '400638133393' },
        upc: { view: 'barcode', host: 'upc-barcode-generator', icon: 'barcode', h1: 'UPC Barcode Generator', lead: 'UPC-A and UPC-E for North American retail, check digit included.', sym: 'upca', sample: '03600029145' },
        pdf417: { view: 'barcode', host: 'pdf417-generator', icon: 'id', h1: 'PDF417 Generator', lead: 'The stacked barcode on IDs, boarding passes and shipping labels.', sym: 'pdf417', sample: 'PDF417 carries up to about 1,800 characters.' },
        aztec: { view: 'barcode', host: 'aztec-code-generator', icon: 'ticket', h1: 'Aztec Code Generator', lead: 'The compact 2D code on train and plane tickets: no quiet zone needed.', sym: 'azteccode', sample: 'TICKET 4471 SEAT 12A' },
        isbn: { view: 'barcode', host: 'isbn-barcode-generator', icon: 'book', h1: 'ISBN Barcode Generator', lead: 'A book\'s back-cover barcode from its ISBN, with the ISBN above and an optional price add-on.', sym: 'isbn', sample: '978-0-306-40615-7' },
        scan: { view: 'scan', host: 'barcode-scanner', tab: 'Scan', icon: 'scan', h1: 'Barcode & QR Scanner', lead: 'Your camera, or a picture or screenshot: every code is read and explained. Nothing is opened until you choose.' },
        gs1: { view: 'check', host: 'gtin-check-digit', tab: 'Check', icon: 'check', h1: 'GTIN Check Digit & GS1 Parser', lead: 'Name any product, book or shipping number, fix its check digit, and read GS1 labels field by field.' },
        bulkbarcodes: { view: 'bulk', host: 'bulk-barcode-generator', tab: 'Bulk', icon: 'layers', h1: 'Bulk Barcodes & Labels', lead: 'A list, a CSV or a numbered sequence in; a ZIP of codes or a printable label sheet out.' },
    };
    const TABS = ['qr', 'barcode', 'datamatrix', 'scan', 'gs1', 'bulkbarcodes'];
    const params = new URLSearchParams(location.search);
    const META = (document.querySelector('meta[name="ov-tool"]') || {}).content || '';
    const ID = TOOLS[META] ? META : TOOLS[params.get('tool')] ? params.get('tool') : 'codes';
    const T = TOOLS[ID];
    const local = !/\.openvibe\.tools$/.test(location.hostname);
    /** A tool's address, carrying text over when there is some (?text=). */
    function toolUrl(id, extra) {
        const q = new URLSearchParams(extra || {});
        if (local) { q.set('tool', id); return `${location.pathname}?${q}`; }
        const s = q.toString();
        return `https://${TOOLS[id].host}.openvibe.tools/${s ? `?${s}` : ''}`;
    }

    // ── Shared bits ──────────────────────────────────────────────────────────────────────────────────────────────────
    let toastTimer = null;
    function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200); }
    function download(blob, name) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }
    const slug = (s) => String(s || 'code').toLowerCase().replace(/^[a-z]+:\/*/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'code';
    async function copyPng(blob) {
        try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); toast('Copied the image'); } catch { toast('Copying images is not allowed here: use Download'); }
    }
    async function copyText(s) { try { await navigator.clipboard.writeText(s); toast('Copied'); } catch { toast('Copy failed'); } }
    const canvasBlob = (c) => new Promise((res) => c.toBlob(res, 'image/png'));
    /** An SVG string on a canvas of `w` px (white under it unless `keepAlpha`). */
    function svgToCanvas(svg, w, keepAlpha) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
            img.onload = () => {
                const h = Math.round((w * (img.naturalHeight || img.height)) / (img.naturalWidth || img.width || 1)) || w;
                const c = document.createElement('canvas'); c.width = w; c.height = h;
                const g = c.getContext('2d');
                if (!keepAlpha) { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); }
                g.imageSmoothingEnabled = false;
                g.drawImage(img, 0, 0, w, h);
                URL.revokeObjectURL(url);
                resolve(c);
            };
            img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('The picture could not be drawn')); };
            img.src = url;
        });
    }
    /** bwip-js error text without its "bwipp.ean13badLength#2394:" prefix. */
    const bwipError = (e) => String((e && e.message) || e).replace(/^bwip(?:p|-js)\.[\w-]+#?\d*:\s*/, '');
    function seg(el, items, value, onPick) {
        el.innerHTML = items.map(([v, label, title]) => `<button type="button" data-v="${esc(v)}" aria-pressed="${v === value}"${title ? ` title="${esc(title)}"` : ''}>${label}</button>`).join('');
        el.onclick = (e) => { const b = e.target.closest('button[data-v]'); if (!b) return; el.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); onPick(b.dataset.v); };
    }
    function bindColor(pickId, textId, onChange) {
        const p = $(pickId), t = $(textId);
        p.addEventListener('input', () => { t.value = p.value; onChange(p.value); });
        t.addEventListener('input', () => { const v = t.value.trim(); if (/^#[0-9a-f]{6}$/i.test(v)) { p.value = v; onChange(v); } });
        return { set(v) { p.value = v; t.value = v; } };
    }
    function bindRange(id, outId, fmt, onChange) {
        const r = $(id), o = $(outId);
        const paint = () => { o.textContent = fmt(Number(r.value)); };
        r.addEventListener('input', () => { paint(); onChange(Number(r.value)); });
        paint();
        return r;
    }
    function debounce(fn, ms) { let t = null; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
    function verdict(el, state, text) { el.className = `verdict ${state}`; el.innerHTML = `<span class="dot"></span><span>${text}</span>`; }
    function facts(el, rows) { el.innerHTML = rows.map(([v, k]) => `<div><b title="${esc(v)}">${esc(v)}</b><span>${esc(k)}</span></div>`).join(''); }
    function note(kind, html, act) { return `<div class="note ${kind}">${icon(kind === 'ok' ? 'check' : kind === 'bad' ? 'x' : kind === 'warn' ? 'warn' : 'spark')}<span>${html}</span>${act || ''}</div>`; }
    const norm = (s) => String(s || '').replace(/[^0-9A-Za-z]/g, '').replace(/^0+(?=\d)/, '');
    /** Read a canvas back and compare with what was meant: { ok, label, text } or null when there is nothing to read with. */
    async function checkScan(canvas, expected) {
        const g = canvas.getContext('2d');
        const data = g.getImageData(0, 0, canvas.width, canvas.height);
        const found = await R.readZxing(data, { tryHarder: true, max: 4 });
        if (!found.length) return { ok: false };
        const hit = found.find((f) => f.text === expected || norm(f.text) === norm(expected)) || found[0];
        return { ok: hit.text === expected || norm(hit.text) === norm(expected), label: hit.label, text: hit.text };
    }

    // ── Frame ────────────────────────────────────────────────────────────────────────────────────────────────────────
    document.title = ID === 'codes' ? document.title : document.title;
    $('h1').textContent = T.h1;
    $('lead').textContent = T.lead;
    const tabFor = (id) => (TOOLS[id].view === 'qr' ? 'qr' : TOOLS[id].view === 'barcode' ? (id === 'datamatrix' ? 'datamatrix' : 'barcode') : id === 'gs1' ? 'gs1' : id);
    $('tabs').innerHTML = TABS.map((id) => `<a href="${esc(toolUrl(id))}" data-tool="${id}"${tabFor(ID) === id ? ' aria-current="page"' : ''}>${icon(TOOLS[id].icon)}${esc(TOOLS[id].tab)}</a>`).join('');
    // A tab carries what is typed over to the next tool.
    $('tabs').addEventListener('click', (e) => {
        const a = e.target.closest('a[data-tool]'); if (!a) return;
        const text = currentText();
        if (text && text.length < 800) { e.preventDefault(); location.href = toolUrl(a.dataset.tool, { text }); }
    });
    let currentText = () => '';
    $(`view-${T.view}`).hidden = false;

    // ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
    // Hub: one box that picks the code, and every tool
    // ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
    function hub() {
        const groups = [
            ['Make', ['qr', 'barcode', 'datamatrix', 'wifiqr', 'vcardqr', 'bulkbarcodes']],
            ['Read & check', ['scan', 'gs1']],
            ['One type, done well', ['code128', 'ean13', 'upc', 'isbn', 'pdf417', 'aztec']],
        ];
        $('hub-tiles').innerHTML = groups.map(([h, ids]) => `<div class="group-h">${esc(h)}</div><div class="tiles">${ids.map((id) => `<a class="tile" href="${esc(toolUrl(id))}"><span class="ti">${icon(TOOLS[id].icon)}</span><span><b>${esc(TOOLS[id].h1)}</b><small>${esc(TOOLS[id].lead)}</small></span></a>`).join('')}</div>`).join('');
        const input = $('hub-text'), stage = $('hub-stage'), why = $('hub-why'), open = $('hub-open');
        const run = debounce(() => {
            const text = input.value.trim();
            if (!text) { stage.innerHTML = '<div class="empty">Your code appears here</div>'; why.textContent = ''; open.href = toolUrl('qr'); return; }
            const rec = S.recommend(text);
            const sym = rec.symbology;
            const encode = rec.encode || rec.fixed || text;
            try {
                if (sym === 'qrcode') {
                    stage.innerHTML = `<div class="art svg">${D.qrSvg(bwipjs.raw({ bcid: 'qrcode', text, eclevel: 'M' }), { style: 'rounded', eyes: 'rounded', color: '#0b1220' }).svg}</div>`;
                    open.href = toolUrl('qr', { text });
                } else {
                    const c = document.createElement('canvas');
                    bwipjs.toCanvas(c, { bcid: sym, text: encode, scale: 3, ...(TWO_D.test(sym) ? {} : { height: 12, ...textOpts(sym) }), backgroundcolor: 'ffffff', paddingwidth: 8, paddingheight: 6 });
                    c.className = 'art'; stage.replaceChildren(c);
                    open.href = toolUrl(sym === 'datamatrix' || sym === 'gs1datamatrix' ? 'datamatrix' : 'barcode', { text: encode, sym });
                }
                const name = (bwipjs.symbolList.find((s) => s.bcid === sym) || {}).desc || sym;
                why.innerHTML = `<b>${esc(name)}</b> · ${esc(rec.why)}${rec.fixed ? ` <span class="st-bad">Check digit corrected: ${esc(rec.fixed)}</span>` : ''}`;
            } catch (e) {
                stage.innerHTML = `<div class="err">${esc(bwipError(e))}</div>`;
                why.textContent = '';
            }
        }, 180);
        input.addEventListener('input', run);
        const start = params.get('text');
        if (start) { input.value = start; run(); }
        currentText = () => input.value.trim();
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
    // QR studio
    // ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
    function qr() {
        const TYPES = [
            ['url', 'Link', 'link'], ['text', 'Text', 'spark'], ['wifi', 'Wi-Fi', 'wifi'], ['contact', 'Contact', 'user'], ['email', 'Email', 'link'],
            ['sms', 'SMS', 'link'], ['phone', 'Phone', 'link'], ['geo', 'Place', 'link'], ['event', 'Event', 'ticket'],
        ];
        const FIELDS = {
            url: [['url', 'Link', 'url', 'https://openvibe.live']],
            text: [['text', 'Text', 'textarea', 'Anything up to about 2,900 characters']],
            wifi: [['ssid', 'Network name (SSID)', 'text', 'Cafe Guest'], ['password', 'Password', 'text', ''], ['security', 'Security', 'seg', [['WPA', 'WPA / WPA2 / WPA3'], ['WEP', 'WEP'], ['nopass', 'None']]], ['hidden', 'Hidden network', 'check']],
            contact: [['first', 'First name', 'text'], ['last', 'Last name', 'text'], ['phone', 'Phone', 'tel'], ['email', 'Email', 'email'], ['org', 'Organisation', 'text'], ['title', 'Job title', 'text'], ['url', 'Website', 'url'], ['address', 'Address', 'text']],
            email: [['to', 'To', 'email', 'hello@example.com'], ['subject', 'Subject', 'text'], ['body', 'Message', 'textarea']],
            sms: [['phone', 'Phone number', 'tel', '+1 555 010 9999'], ['message', 'Message', 'textarea']],
            phone: [['phone', 'Phone number', 'tel', '+1 555 010 9999']],
            geo: [['lat', 'Latitude', 'number', '51.5007'], ['lng', 'Longitude', 'number', '-0.1246'], ['label', 'Label (optional)', 'text']],
            event: [['title', 'Title', 'text', 'Launch party'], ['start', 'Starts', 'datetime-local'], ['end', 'Ends', 'datetime-local'], ['location', 'Where', 'text'], ['notes', 'Notes', 'textarea']],
        };
        const st = {
            type: T.type || 'url', fields: { url: { url: '' }, wifi: { security: 'WPA' } }, style: 'rounded', eyes: 'rounded',
            color: '#0b1220', eyeColor: '#0b1220', bg: '#ffffff', grad: false, gradTo: '#3472d8', transparent: false,
            logo: null, logoSize: 22, ecc: 'auto', quiet: 4, px: 1024, caption: '', dpi: 300,
        };
        const saved = store.get('ov_codes_qr_style', null);
        if (saved) for (const k of ['style', 'eyes', 'color', 'eyeColor', 'bg', 'grad', 'gradTo', 'transparent', 'ecc', 'quiet', 'px', 'dpi']) if (saved[k] !== undefined) st[k] = saved[k];
        const start = params.get('text');
        if (start) { if (/^WIFI:/i.test(start)) st.type = 'wifi'; else if (/^https?:\/\//i.test(start)) { st.type = 'url'; st.fields.url = { url: start }; } else { st.type = 'text'; st.fields.text = { text: start }; } }

        const typesEl = $('qr-types');
        typesEl.innerHTML = TYPES.map(([v, l, i]) => `<button type="button" class="chip" data-v="${v}" aria-pressed="${v === st.type}">${icon(i)}${l}</button>`).join('');
        typesEl.onclick = (e) => { const b = e.target.closest('[data-v]'); if (!b) return; st.type = b.dataset.v; typesEl.querySelectorAll('.chip').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); fields(); update(); };

        function fields() {
            const f = st.fields[st.type] || (st.fields[st.type] = {});
            const box = $('qr-fields');
            box.innerHTML = FIELDS[st.type].map(([k, label, kind, ph]) => {
                if (kind === 'seg') return `<div class="field"><span class="lbl">${esc(label)}</span><div class="seg" data-k="${k}" role="group" aria-label="${esc(label)}">${ph.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${(f[k] || ph[0][0]) === v}">${esc(l)}</button>`).join('')}</div></div>`;
                if (kind === 'check') return `<label class="check" style="margin:2px 0 10px"><input type="checkbox" data-k="${k}"${f[k] ? ' checked' : ''}> ${esc(label)}</label>`;
                const v = esc(f[k] || '');
                const input = kind === 'textarea' ? `<textarea data-k="${k}" rows="3" placeholder="${esc(ph || '')}">${v}</textarea>` : `<input type="${kind}" data-k="${k}" value="${v}" placeholder="${esc(ph || '')}"${kind === 'number' ? ' step="any"' : ''} autocomplete="off">`;
                return `<label class="field"><span>${esc(label)}</span>${input}</label>`;
            }).join('') + (st.type === 'geo' ? `<button type="button" class="btn small" id="qr-here">${icon('link')}Use my location</button>` : '') + (st.type === 'wifi' ? '<small class="muted">Special characters in the name or password are escaped the way phones expect.</small>' : '');
            box.oninput = (e) => { const k = e.target.dataset.k; if (!k) return; f[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; update(); };
            box.onclick = (e) => {
                const b = e.target.closest('.seg[data-k] button'); if (b) { const k = b.parentElement.dataset.k; f[k] = b.dataset.v; b.parentElement.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); update(); }
                if (e.target.closest('#qr-here') && navigator.geolocation) navigator.geolocation.getCurrentPosition((p) => { f.lat = p.coords.latitude.toFixed(6); f.lng = p.coords.longitude.toFixed(6); fields(); update(); }, () => toast('Location is not available'));
            };
            const first = box.querySelector('input,textarea');
            if (first && document.activeElement === document.body && ID !== 'codes') first.focus({ preventScroll: true });
        }

        seg($('qr-style'), [['square', 'Square'], ['rounded', 'Rounded'], ['dots', 'Dots'], ['fluid', 'Fluid']], st.style, (v) => { st.style = v; update(); });
        seg($('qr-eyes'), [['square', 'Square'], ['rounded', 'Rounded'], ['circle', 'Circle'], ['leaf', 'Leaf']], st.eyes, (v) => { st.eyes = v; update(); });
        const cFg = bindColor('qr-color', 'qr-color-t', (v) => { st.color = v; update(); });
        const cEye = bindColor('qr-eye', 'qr-eye-t', (v) => { st.eyeColor = v; update(); });
        const cBg = bindColor('qr-bg', 'qr-bg-t', (v) => { st.bg = v; update(); });
        const cTo = bindColor('qr-grad-to', 'qr-grad-to-t', (v) => { st.gradTo = v; update(); });
        cFg.set(st.color); cEye.set(st.eyeColor); cBg.set(st.bg); cTo.set(st.gradTo);
        $('qr-grad').checked = st.grad; $('qr-grad-box').hidden = !st.grad; $('qr-transparent').checked = st.transparent;
        $('qr-grad').onchange = (e) => { st.grad = e.target.checked; $('qr-grad-box').hidden = !st.grad; update(); };
        $('qr-transparent').onchange = (e) => { st.transparent = e.target.checked; update(); };
        const accent = (getComputedStyle(document.documentElement).getPropertyValue('--accent-strong') || '#3472d8').trim();
        const PRESETS = [
            ['Classic', '#000000', '#000000', '#ffffff', null], ['Ink', '#0b1220', '#0b1220', '#ffffff', null], ['OpenVibe', /^#[0-9a-f]{6}$/i.test(accent) ? accent : '#3472d8', '#0b1220', '#ffffff', null],
            ['Ocean', '#0b4f6c', '#0b4f6c', '#ffffff', '#0284c7'], ['Sunset', '#b91c1c', '#7c2d12', '#fffbeb', '#d97706'], ['Forest', '#14532d', '#14532d', '#f0fdf4', '#15803d'], ['Grape', '#4c1d95', '#4c1d95', '#faf5ff', '#be185d'],
        ];
        $('qr-presets').innerHTML = PRESETS.map(([n, c, , bg, g], i) => `<button type="button" class="chip" data-i="${i}"><span style="width:14px;height:14px;border-radius:4px;background:${g ? `linear-gradient(135deg,${c},${g})` : c};outline:2px solid ${bg};outline-offset:-1px"></span>${esc(n)}</button>`).join('');
        $('qr-presets').onclick = (e) => {
            const b = e.target.closest('[data-i]'); if (!b) return;
            const [, c, eye, bg, g] = PRESETS[+b.dataset.i];
            Object.assign(st, { color: c, eyeColor: eye, bg, grad: !!g, gradTo: g || st.gradTo, transparent: false });
            cFg.set(c); cEye.set(eye); cBg.set(bg); cTo.set(st.gradTo); $('qr-grad').checked = st.grad; $('qr-grad-box').hidden = !st.grad; $('qr-transparent').checked = false;
            update();
        };
        // Logo: read, shrunk to 512 px, kept as a data URL inside the SVG.
        $('qr-logo').onchange = (e) => {
            const file = e.target.files && e.target.files[0]; if (!file) return;
            const img = new Image();
            img.onload = () => {
                const k = Math.min(1, 512 / Math.max(img.width, img.height));
                const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
                c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
                st.logo = c.toDataURL('image/png');
                URL.revokeObjectURL(img.src);
                $('qr-logo-name').textContent = file.name; $('qr-logo-clear').hidden = false;
                update();
            };
            img.onerror = () => toast('That file is not a picture this browser can read');
            img.src = URL.createObjectURL(file);
        };
        $('qr-logo-clear').onclick = () => { st.logo = null; $('qr-logo').value = ''; $('qr-logo-name').textContent = ''; $('qr-logo-clear').hidden = true; update(); };
        bindRange('qr-logo-size', 'qr-logo-size-o', (v) => `${v}%`, (v) => { st.logoSize = v; update(); });
        seg($('qr-ecc'), [['auto', 'Auto'], ['L', 'L 7%'], ['M', 'M 15%'], ['Q', 'Q 25%'], ['H', 'H 30%']], st.ecc, (v) => { st.ecc = v; update(); });
        $('qr-quiet').value = st.quiet; $('qr-px').value = st.px; $('qr-dpi').value = String(st.dpi);
        bindRange('qr-quiet', 'qr-quiet-o', (v) => `${v} module${v === 1 ? '' : 's'}`, (v) => { st.quiet = v; update(); });
        bindRange('qr-px', 'qr-px-o', (v) => `${v} px`, (v) => { st.px = v; printNote(); save(); });
        $('qr-caption').oninput = (e) => { st.caption = e.target.value; update(); };
        $('qr-dpi').onchange = (e) => { st.dpi = +e.target.value; printNote(); save(); };

        const eccFor = () => (st.ecc !== 'auto' ? st.ecc : st.logo ? 'H' : st.style === 'dots' || st.style === 'fluid' ? 'Q' : 'M');
        const payload = () => S.qrPayload(st.type, st.fields[st.type] || {});
        let last = null;   // { svg, n, text }
        let gen = 0;
        const save = debounce(() => store.set('ov_codes_qr_style', { style: st.style, eyes: st.eyes, color: st.color, eyeColor: st.eyeColor, bg: st.bg, grad: st.grad, gradTo: st.gradTo, transparent: st.transparent, ecc: st.ecc, quiet: st.quiet, px: st.px, dpi: st.dpi }), 400);
        function printNote() {
            const mm = D.pxToMm(st.px, st.dpi);
            $('qr-print-note').querySelector('span').innerHTML = `${st.px} px prints <b>${mm.toFixed(1)} mm</b> wide at ${st.dpi} DPI, comfortable to scan from about <b>${Math.round(mm)} cm</b> away.`;
        }
        function svgFor(size) {
            const ecc = eccFor();
            const raw = bwipjs.raw({ bcid: 'qrcode', text: last.text, eclevel: ecc });
            return D.qrSvg(raw, { style: st.style, eyes: st.eyes, color: st.color, eyeColor: st.eyeColor !== st.color ? st.eyeColor : undefined, background: st.transparent ? 'transparent' : st.bg, gradient: st.grad ? { to: st.gradTo, angle: 45 } : null, quiet: st.quiet, logo: st.logo ? { href: st.logo, size: st.logoSize / 100 } : null, caption: st.caption, size }).svg;
        }
        const check = debounce(async (g, svg, text) => {
            try {
                const c = await svgToCanvas(svg, 720, false);
                const r = await checkScan(c, text);
                if (g !== gen) return;
                if (r.ok) verdict($('qr-verdict'), 'ok', `Test-scanned: reads back exactly${st.logo ? ', logo included' : ''}`);
                else if (r.text) verdict($('qr-verdict'), 'bad', `Reads as something else: ${esc(r.text.slice(0, 60))}`);
                else verdict($('qr-verdict'), 'bad', 'Did not scan in the test: raise error correction, shrink the logo or add contrast');
            } catch (e) {
                if (g === gen) verdict($('qr-verdict'), '', `Not checked: ${esc(e.message || 'the reader did not load')}`);
            }
        }, 350);
        function update() {
            save();
            const text = payload();
            const stage = $('qr-stage');
            const notes = [];
            gen++;
            if (!text || text === 'https://' || /^(WIFI:T:\w+;S:;|mailto:$|SMSTO::|tel:$)/.test(text)) {
                stage.innerHTML = '<div class="empty">Fill in the fields to make your code</div>'; last = null;
                verdict($('qr-verdict'), '', '—'); facts($('qr-facts'), []); $('qr-notes').innerHTML = '';
                return;
            }
            try {
                last = { text };
                const ecc = eccFor();
                const raw = bwipjs.raw({ bcid: 'qrcode', text, eclevel: ecc });
                const n = D.matrixOf(raw).n;
                const svg = svgFor(null);
                stage.innerHTML = `<div class="art svg" role="img" aria-label="QR code preview">${svg}</div>`;
                const bytes = new TextEncoder().encode(text).length;
                facts($('qr-facts'), [[`${(n - 17) / 4}`, 'Version'], [`${n}×${n}`, 'Modules'], [`${ecc} · ${bytes} B`, 'ECC · data']]);
                $('qr-ecc-note').textContent = st.ecc === 'auto' ? `Auto picked ${ecc}${st.logo ? ' because of the logo' : st.style === 'dots' || st.style === 'fluid' ? ' for the rounder modules' : ''}.` : '';
                const fg = st.color, bg = st.transparent ? '#ffffff' : st.bg;
                const ratio = S.contrast(fg, bg);
                if (ratio < 3) notes.push(note('warn', `Low contrast (${ratio.toFixed(1)}:1). Scanners want dark modules on a light background, ideally 4:1 or more.`));
                const lum = (h) => S.contrast(h, '#000000');
                if (lum(fg) > lum(bg)) notes.push(note('warn', 'Light modules on a dark background: many phone cameras cannot read inverted codes.'));
                if (st.transparent) notes.push(note('', 'Transparent background: print it on something light, with clear space around it.'));
                if (n > 57 && st.type === 'contact') notes.push(note('warn', 'A dense code: leave out fields people do not need, or print it larger than 3 cm.'));
                if (st.type === 'url' && /^https?:\/\//i.test(text) && text.length > 200) notes.push(note('', 'A long link makes a dense code. A shorter address scans faster.'));
                $('qr-notes').innerHTML = notes.join('');
                verdict($('qr-verdict'), 'wait', 'Test-scanning…');
                check(gen, svg, text);
                printNote();
            } catch (e) {
                last = null;
                stage.innerHTML = `<div class="err">${esc(bwipError(e))}</div>`;
                verdict($('qr-verdict'), 'bad', 'Too much for one QR code');
                facts($('qr-facts'), []);
            }
        }
        const name = () => `qr-${slug(st.type === 'url' ? (st.fields.url || {}).url : st.type)}`;
        $('qr-svg').onclick = () => { if (!last) return toast('Nothing to download yet'); download(new Blob([svgFor(st.px)], { type: 'image/svg+xml' }), `${name()}.svg`); };
        const png = async () => { const c = await svgToCanvas(svgFor(null), st.px, st.transparent); const b = await canvasBlob(c); return new Blob([D.pngWithDpi(new Uint8Array(await b.arrayBuffer()), st.dpi)], { type: 'image/png' }); };
        $('qr-png').onclick = async () => { if (!last) return toast('Nothing to download yet'); download(await png(), `${name()}.png`); };
        $('qr-copy').onclick = async () => { if (!last) return toast('Nothing to copy yet'); copyPng(await png()); };
        fields();
        update();
        currentText = () => (last ? last.text : '');
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
    // Barcode studio (every symbology; the single-type pages start on theirs)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
    const GROUPS = [
        ['Retail (EAN / UPC / ISBN)', ['ean13', 'ean8', 'upca', 'upce', 'isbn', 'issn', 'ismn', 'ean5', 'ean2']],
        ['Industrial & logistics', ['code128', 'code39', 'code39ext', 'code93', 'code93ext', 'interleaved2of5', 'itf14', 'code11', 'rationalizedCodabar', 'msi', 'plessey', 'telepen', 'telepennumeric', 'code2of5', 'industrial2of5', 'matrix2of5', 'iata2of5', 'datalogic2of5', 'coop2of5', 'bc412', 'channelcode', 'posicode', 'codablockf', 'code16k', 'code49']],
        ['GS1', ['gs1-128', 'ean14', 'sscc18', 'gs1datamatrix', 'gs1datamatrixrectangular', 'gs1qrcode', 'gs1dotcode', 'databaromni', 'databarstacked', 'databarstackedomni', 'databartruncated', 'databarlimited', 'databarexpanded', 'databarexpandedstacked', 'gs1northamericancoupon', 'gs1dldatamatrix', 'gs1dlqrcode']],
        ['2D', ['qrcode', 'microqrcode', 'rectangularmicroqrcode', 'swissqrcode', 'datamatrix', 'datamatrixrectangular', 'datamatrixrectangularextension', 'pdf417', 'pdf417compact', 'micropdf417', 'azteccode', 'azteccodecompact', 'aztecrune', 'maxicode', 'dotcode', 'hanxin', 'codeone', 'ultracode']],
        ['Postal', ['onecode', 'postnet', 'planet', 'royalmail', 'mailmark', 'auspost', 'kix', 'japanpost', 'identcode', 'leitcode', 'daft', 'flattermarken']],
        ['Healthcare & pharma', ['pharmacode', 'pharmacode2', 'code32', 'pzn', 'hibccode39', 'hibccode128', 'hibcdatamatrix', 'hibcdatamatrixrectangular', 'hibcpdf417', 'hibcmicropdf417', 'hibcqrcode', 'hibccodablockf', 'hibcazteccode']],
    ];
    const TWO_D = /qrcode|datamatrix|aztec|pdf417|maxicode|dotcode|hanxin|codeone|ultracode|codablockf|code16k|code49|mailmark|rune/;
    const READABLE = /^(qrcode|microqrcode|rectangularmicroqrcode|swissqrcode|gs1qrcode|hibcqrcode|datamatrix|datamatrixrectangular|gs1datamatrix|gs1datamatrixrectangular|hibcdatamatrix|hibcdatamatrixrectangular|azteccode|azteccodecompact|aztecrune|hibcazteccode|pdf417|pdf417compact|micropdf417|hibcpdf417|hibcmicropdf417|maxicode|ean13|ean8|upca|upce|isbn|issn|ismn|code128|gs1-128|ean14|sscc18|hibccode128|code39|code39ext|hibccode39|code32|pzn|code93|code93ext|interleaved2of5|itf14|rationalizedCodabar|databaromni|databarstacked|databarstackedomni|databartruncated|databarlimited|databarexpanded|databarexpandedstacked|telepen|telepennumeric)$/;
    const NO_TEXT = /pharmacode|postnet|planet|royalmail|auspost|kix|japanpost|onecode|flattermarken|mailmark|daft/;
    const RETAIL = /^(ean13|ean8|upca|upce|isbn|ismn|issn)$/;
    /** includetext for a barcode: retail symbologies place their digits themselves, the rest centre one line. */
    const textOpts = (sym) => (NO_TEXT.test(sym) ? {} : RETAIL.test(sym) ? { includetext: true, guardwhitespace: true } : { includetext: true, textxalign: 'center', textyoffset: 3 });
    function symbolOptions(select, current, filter) {
        const all = new Map(bwipjs.symbolList.map((s) => [s.bcid, s]));
        const used = new Set();
        const f = String(filter || '').toLowerCase();
        const match = (s) => !f || s.bcid.toLowerCase().includes(f) || s.desc.toLowerCase().includes(f);
        let html = '';
        for (const [label, ids] of GROUPS) {
            const opts = ids.filter((id) => all.has(id) && match(all.get(id))).map((id) => { used.add(id); return `<option value="${id}"${id === current ? ' selected' : ''}>${esc(all.get(id).desc)}</option>`; });
            if (opts.length) html += `<optgroup label="${esc(label)}">${opts.join('')}</optgroup>`;
        }
        const rest = [...all.values()].filter((s) => !used.has(s.bcid) && !['raw', 'symbol'].includes(s.bcid) && !/composite|gs1-cc/.test(s.bcid) && match(s));
        if (rest.length) html += `<optgroup label="More">${rest.map((s) => `<option value="${s.bcid}"${s.bcid === current ? ' selected' : ''}>${esc(s.desc)}</option>`).join('')}</optgroup>`;
        select.innerHTML = html || '<option disabled>No symbology matches</option>';
    }

    /** bwip-js options for the barcode studio's state (`dots` px per module). */
    function bwipOpts(st, text, dots) {
        const twoD = TWO_D.test(st.sym);
        const o = { bcid: st.sym, text, scale: dots, barcolor: st.color.slice(1), backgroundcolor: st.bg.slice(1), rotate: st.rotate, paddingwidth: twoD ? Math.min(st.quiet, 10) : st.quiet, paddingheight: twoD ? Math.min(st.quiet, 10) : Math.max(4, Math.min(st.quiet, 6)) };
        if (!twoD) {
            // bwip-js reads height in mm at 72 dpi times the scale: this makes the bars st.height mm at st.dpi.
            o.height = (st.height * st.dpi) / (72 * dots);
            // Retail symbologies lay out their own digits (the first one outside the bars, then the groups).
            const retail = RETAIL.test(st.sym);
            if (st.showText && !NO_TEXT.test(st.sym)) { o.includetext = true; if (!retail) { o.textxalign = 'center'; o.textyoffset = 3; } }
            if (retail) o.guardwhitespace = true;
        }
        Object.assign(o, st.extra);
        if (st.sym === 'ean13' && st.isbnLine) o.extratext = st.isbnLine;
        return o;
    }

    function barcode() {
        const st = {
            sym: T.sym || params.get('sym') || 'auto', color: '#000000', bg: '#ffffff', rotate: 'N', quiet: 10, height: 15, x: 0.33, dpi: 300, showText: true, extra: {}, isbnLine: null,
        };
        const auto = !T.sym && !params.get('sym');
        const input = $('bc-text');
        input.value = params.get('text') || T.sample || '';
        if (auto && !input.value) input.value = '4006381333931';
        const select = $('bc-type');
        const pickSym = () => (st.sym === 'auto' ? S.recommend(input.value).symbology : st.sym);
        if (st.sym === 'auto') st.sym = pickSym();
        if (st.sym === 'isbn') { st.isbnPage = true; }
        symbolOptions(select, st.sym === 'isbn' ? 'ean13' : st.sym);
        $('bc-find').oninput = (e) => symbolOptions(select, st.sym, e.target.value);
        select.onchange = () => { st.sym = select.value; st.isbnPage = false; extras(); update(); };
        $('bc-sample').onclick = () => { const s = bwipjs.symbolList.find((x) => x.bcid === st.sym); if (s) { input.value = s.text; update(); } };
        seg($('bc-rotate'), [['N', '0°'], ['R', '90°'], ['I', '180°'], ['L', '270°']], st.rotate, (v) => { st.rotate = v; update(); });
        const cB = bindColor('bc-color', 'bc-color-t', (v) => { st.color = v; update(); });
        const cG = bindColor('bc-bg', 'bc-bg-t', (v) => { st.bg = v; update(); });
        cB.set(st.color); cG.set(st.bg);
        bindRange('bc-height', 'bc-height-o', (v) => `${v} mm`, (v) => { st.height = v; update(); });
        bindRange('bc-x', 'bc-x-o', (v) => `${v.toFixed(2)} mm`, (v) => { st.x = v; update(); });
        bindRange('bc-quiet', 'bc-quiet-o', (v) => `${v}`, (v) => { st.quiet = v; update(); });
        $('bc-showtext').onchange = (e) => { st.showText = e.target.checked; update(); };
        $('bc-dpi').onchange = (e) => { st.dpi = +e.target.value; update(); };
        input.addEventListener('input', () => { if (auto && !st.touched) { const r = S.recommend(input.value).symbology; if (r !== st.sym) { st.sym = r; symbolOptions(select, st.sym); extras(); } } update(); });
        select.addEventListener('change', () => { st.touched = true; });

        // Symbology-specific controls.
        function extras() {
            const box = $('bc-extra');
            st.extra = {};
            const s = st.isbnPage ? 'isbn' : st.sym;
            const desc = (bwipjs.symbolList.find((x) => x.bcid === st.sym) || {}).desc || st.sym;
            $('bc-type-desc').textContent = `${desc}${READABLE.test(st.sym) ? ' · test-scanned as you type' : ''}`;
            $('bc-height-f').hidden = TWO_D.test(st.sym);
            $('bc-text-f').hidden = TWO_D.test(st.sym) || NO_TEXT.test(st.sym);
            let html = '';
            if (/^(qrcode|microqrcode|gs1qrcode|swissqrcode|hibcqrcode)$/.test(s)) html = '<div class="field"><span class="lbl">Error correction</span><div class="seg" id="bx-ecc"></div></div>';
            else if (/pdf417/.test(s)) html = '<div class="row"><label class="field grow"><span>Columns</span><select id="bx-cols"><option value="">Auto</option>' + Array.from({ length: 30 }, (_, i) => `<option>${i + 1}</option>`).join('') + '</select></label><label class="field grow"><span>Error correction</span><select id="bx-pecc"><option value="">Auto</option>' + Array.from({ length: 9 }, (_, i) => `<option>${i}</option>`).join('') + '</select></label></div>';
            else if (/aztec/.test(s) && s !== 'aztecrune') html = '<div class="field"><span class="lbl">Error correction</span><div class="range"><input type="range" id="bx-aecc" min="5" max="95" value="23" aria-label="Aztec error correction"><output id="bx-aecc-o">23%</output></div></div>';
            else if (/datamatrix/.test(s)) html = '<div class="row" style="align-items:center;gap:16px"><div class="seg" id="bx-shape"></div><label class="check"><input type="checkbox" id="bx-gs1"' + (/gs1/.test(s) ? ' checked' : '') + '> GS1 (Application Identifiers in brackets)</label></div>';
            else if (/^(ean13|ean8|upca|upce|isbn)$/.test(s)) html = `<div class="row"><label class="field grow"><span>${s === 'isbn' ? 'Price add-on (EAN-5)' : 'Add-on (2 or 5 digits)'}</span><input type="text" id="bx-addon" inputmode="numeric" maxlength="5" placeholder="${s === 'isbn' ? '51995 = US $19.95, 90000 = no price' : 'optional'}"></label></div>`;
            else if (/^(code39|code39ext|interleaved2of5|code11|msi)$/.test(s)) html = '<label class="check"><input type="checkbox" id="bx-check"> Add a check digit</label>';
            box.innerHTML = html;
            if ($('bx-ecc')) seg($('bx-ecc'), [['L', 'L'], ['M', 'M'], ['Q', 'Q'], ['H', 'H']], 'M', (v) => { st.extra.eclevel = v; update(); });
            if ($('bx-cols')) { $('bx-cols').onchange = (e) => { st.extra.columns = e.target.value ? +e.target.value : undefined; update(); }; $('bx-pecc').onchange = (e) => { st.extra.eclevel = e.target.value === '' ? undefined : +e.target.value; update(); }; }
            if ($('bx-aecc')) bindRange('bx-aecc', 'bx-aecc-o', (v) => `${v}%`, (v) => { st.extra.eclevel = v; update(); });
            if ($('bx-shape')) {
                const rect = /rectangular/.test(st.sym);
                seg($('bx-shape'), [['square', 'Square'], ['rectangle', 'Rectangle']], rect ? 'rectangle' : 'square', (v) => { const g = $('bx-gs1').checked; st.sym = (g ? 'gs1datamatrix' : 'datamatrix') + (v === 'rectangle' ? 'rectangular' : ''); symbolOptions(select, st.sym); update(); });
                $('bx-gs1').onchange = (e) => { const r = /rectangular/.test(st.sym); st.sym = (e.target.checked ? 'gs1datamatrix' : 'datamatrix') + (r ? 'rectangular' : ''); symbolOptions(select, st.sym); update(); };
            }
            if ($('bx-addon')) $('bx-addon').oninput = (e) => { const v = e.target.value.replace(/\D/g, ''); st.extra.addon = /^(\d{2}|\d{5})$/.test(v) ? v : undefined; update(); };
            if ($('bx-check')) $('bx-check').onchange = (e) => { st.extra.includecheck = e.target.checked || undefined; update(); };
        }

        /** The text bwip-js gets, and what the smart box says about it: { text, sym, notes[] }. */
        function prepare() {
            const raw = input.value.replace(/\r/g, '');
            const t = TWO_D.test(st.sym) ? raw : raw.trim();
            const notes = [];
            let sym = st.sym, text = t;
            st.isbnLine = null;
            const num = S.identifyNumber(t, { complete: true });
            if (st.isbnPage || st.sym === 'isbn') {
                const id = S.identifyNumber(t);
                if (!id || !['isbn10', 'isbn13'].includes(id.kind)) { notes.push(note('', 'Type an ISBN-10 or ISBN-13. With hyphens as on the copyright page, they are printed above the bars.')); return { text: '', sym, notes }; }
                if (!id.valid) notes.push(note('bad', `The check digit should be <b>${esc(id.expected)}</b>.`, `<button type="button" class="btn small act" data-fix="${esc(id.fixed)}">Fix</button>`));
                const thirteen = id.kind === 'isbn10' ? id.isbn13 : id.digits;
                const typed = t.replace(/^ISBN(?:-1[03])?:?\s*/i, '');
                if (/^97[89]-\d+-\d+-\d+-\d$/.test(typed) && typed.length === 17) { sym = 'isbn'; text = typed; } else { sym = 'ean13'; text = thirteen; st.isbnLine = `ISBN ${thirteen}`; }
                if (id.kind === 'isbn10') notes.push(note('ok', `ISBN-10 ${esc(id.fixed)} is ISBN-13 <b>${esc(thirteen)}</b>: books are printed with the 13-digit one.`));
                return { text, sym, notes };
            }
            if (/^(ean13|upca|ean8|itf14|upce)$/.test(st.sym) && num) {
                const want = { ean13: [12, 13], upca: [11, 12], ean8: [7, 8], itf14: [13, 14], upce: [8, 8] }[st.sym];
                const d = t.replace(/[\s-]/g, '');
                if (d.length === want[0] && want[0] !== want[1]) { text = d + S.gs1CheckDigit(d); notes.push(note('ok', `Check digit <b>${text.slice(-1)}</b> added: ${esc(text)}.`)); }
                else if (d.length === want[1] && !S.gs1Valid(d) && st.sym !== 'upce') notes.push(note('bad', `The check digit is ${esc(d.slice(-1))}; it should be <b>${esc(S.gs1CheckDigit(d.slice(0, -1)))}</b>.`, `<button type="button" class="btn small act" data-fix="${esc(d.slice(0, -1) + S.gs1CheckDigit(d.slice(0, -1)))}">Fix</button>`));
                else if (num.valid) notes.push(note('ok', `${esc(num.note)} Check digit correct.`));
                if (st.sym !== 'upce') text = text.replace(/[\s-]/g, '');
            }
            if (/^gs1|^ean14|^sscc18/.test(st.sym) && t && !/^\(\d{2,4}\)/.test(t) && st.sym !== 'gs1northamericancoupon') {
                if (/^\d{18}$/.test(t) && st.sym === 'gs1-128') { text = `(00)${t}`; notes.push(note('', `Read as an SSCC: encoded as <span class="mono">${esc(text)}</span>.`)); }
                else notes.push(note('warn', 'GS1 symbologies take Application Identifiers in brackets, e.g. <span class="mono">(01)09506000134352(10)ABC</span>.'));
            }
            if (/^\(\d{2,4}\)/.test(t)) {
                const g = S.parseGs1(t);
                g.parts.filter((p) => p.error).forEach((p) => notes.push(note('bad', `(${esc(p.ai)}) ${esc(p.title)}: ${esc(p.error)}.`)));
            }
            // What the text looks like, when that is not the chosen symbology.
            if (auto || !T.sym) {
                const rec = S.recommend(t);
                if (t && rec.symbology !== st.sym && !(rec.symbology === 'ean13' && st.sym === 'isbn')) {
                    const name = (bwipjs.symbolList.find((x) => x.bcid === rec.symbology) || {}).desc || rec.symbology;
                    notes.push(note('', `${esc(rec.why)}`, `<button type="button" class="btn small act" data-use="${esc(rec.symbology)}"${rec.encode ? ` data-text="${esc(rec.encode)}"` : ''}>Use ${esc(name)}</button>`));
                }
            }
            return { text, sym, notes };
        }

        let gen = 0;
        let lastPrep = null;
        const check = debounce(async (g, canvas, text, sym) => {
            if (!READABLE.test(sym)) { verdict($('bc-verdict'), '', 'No second reader for this symbology: drawn to its specification'); return; }
            try {
                const r = await checkScan(canvas, text.replace(/\s+\d{2,5}$/, ''));
                if (g !== gen) return;
                if (r.ok) verdict($('bc-verdict'), 'ok', `Test-scanned as ${esc(r.label)}: reads back exactly`);
                else if (r.text) verdict($('bc-verdict'), 'ok', `Test-scanned as ${esc(r.label)}: ${esc(r.text.slice(0, 48))}`);
                else verdict($('bc-verdict'), 'bad', 'Did not scan in the test: try a wider module, more contrast or a taller bar');
            } catch (e) { if (g === gen) verdict($('bc-verdict'), '', `Not checked: ${esc(e.message || 'the reader did not load')}`); }
        }, 350);
        const stage = $('bc-stage');
        function update() {
            gen++;
            const p = prepare();
            lastPrep = p;
            $('bc-smart').innerHTML = p.notes.join('');
            if (!p.text) { stage.innerHTML = '<div class="empty">Type something to encode</div>'; verdict($('bc-verdict'), '', '—'); facts($('bc-facts'), []); return; }
            const dots = Math.max(1, Math.round((st.x / 25.4) * st.dpi));
            $('bc-dots').textContent = `${dots} dot${dots === 1 ? '' : 's'} per module = ${((dots / st.dpi) * 25.4).toFixed(3)} mm`;
            try {
                const prev = { ...st, sym: p.sym };
                const c = document.createElement('canvas');
                // On screen: a few px per module, whatever the print size.
                bwipjs.toCanvas(c, bwipOpts({ ...prev, dpi: 72 * 3, height: st.height }, p.text, 3));
                c.className = 'art';
                c.setAttribute('role', 'img'); c.setAttribute('aria-label', `${p.sym} barcode preview`);
                stage.replaceChildren(c);
                // Print size from a render at the real resolution.
                const real = document.createElement('canvas');
                bwipjs.toCanvas(real, bwipOpts(prev, p.text, dots));
                const wmm = D.pxToMm(real.width, st.dpi), hmm = D.pxToMm(real.height, st.dpi);
                $('bc-size').textContent = `${wmm.toFixed(1)} × ${hmm.toFixed(1)} mm (${real.width} × ${real.height} px)`;
                const desc = (bwipjs.symbolList.find((x) => x.bcid === p.sym) || {}).desc || p.sym;
                facts($('bc-facts'), [[desc, 'Symbology'], [`${wmm.toFixed(1)} mm`, 'Width'], [`${p.text.length}`, 'Characters']]);
                verdict($('bc-verdict'), 'wait', 'Test-scanning…');
                const vc = document.createElement('canvas');
                bwipjs.toCanvas(vc, { ...bwipOpts({ ...prev, rotate: 'N', color: '#000000', bg: '#ffffff' }, p.text, Math.max(2, Math.min(4, dots))), backgroundcolor: 'ffffff' });
                check(gen, vc, p.text, p.sym);
            } catch (e) {
                stage.innerHTML = `<div class="err">${esc(bwipError(e))}</div>`;
                verdict($('bc-verdict'), 'bad', 'This text cannot be drawn in this symbology');
                facts($('bc-facts'), []);
            }
        }
        $('bc-smart').addEventListener('click', (e) => {
            const fix = e.target.closest('[data-fix]'); if (fix) { input.value = fix.dataset.fix; update(); return; }
            const use = e.target.closest('[data-use]'); if (use) { st.sym = use.dataset.use; st.touched = true; st.isbnPage = false; if (use.dataset.text) input.value = use.dataset.text; symbolOptions(select, st.sym); extras(); update(); }
        });
        const fileName = () => `${lastPrep ? lastPrep.sym : 'barcode'}-${slug(lastPrep ? lastPrep.text : 'code')}`;
        async function pngBlob() {
            const p = lastPrep; if (!p || !p.text) return null;
            const dots = Math.max(1, Math.round((st.x / 25.4) * st.dpi));
            const c = document.createElement('canvas');
            bwipjs.toCanvas(c, bwipOpts({ ...st, sym: p.sym }, p.text, dots));
            const b = await canvasBlob(c);
            return new Blob([D.pngWithDpi(new Uint8Array(await b.arrayBuffer()), st.dpi)], { type: 'image/png' });
        }
        $('bc-png').onclick = async () => { try { const b = await pngBlob(); if (!b) return toast('Nothing to download yet'); download(b, `${fileName()}.png`); } catch (e) { toast(bwipError(e)); } };
        $('bc-copy').onclick = async () => { try { const b = await pngBlob(); if (!b) return toast('Nothing to copy yet'); copyPng(b); } catch (e) { toast(bwipError(e)); } };
        $('bc-svg').onclick = () => {
            const p = lastPrep; if (!p || !p.text) return toast('Nothing to download yet');
            try {
                const dots = Math.max(1, Math.round((st.x / 25.4) * st.dpi));
                let svg = bwipjs.toSVG(bwipOpts({ ...st, sym: p.sym }, p.text, dots));
                // Physical size on the root element, so it prints at the size shown.
                const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
                if (vb) svg = svg.replace('<svg ', `<svg width="${D.pxToMm(+vb[1], st.dpi).toFixed(2)}mm" height="${D.pxToMm(+vb[2], st.dpi).toFixed(2)}mm" `);
                download(new Blob([svg], { type: 'image/svg+xml' }), `${fileName()}.svg`);
            } catch (e) { toast(bwipError(e)); }
        };
        extras();
        update();
        currentText = () => input.value.trim();
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
    // Scanner
    // ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
    function scan() {
        const video = $('sc-video'), shot = $('sc-shot'), overlay = $('sc-overlay'), drop = $('sc-drop'), list = $('sc-results');
        let stream = null, timer = null, devices = [], deviceIdx = 0, busy = false, torch = false;
        const seen = new Map();   // text → last time shown (ms)
        let history = store.get('ov_codes_scans', []);
        const engine = $('sc-engine');
        R.native().then((d) => { engine.textContent = d ? 'Reader: this browser\'s barcode detector, with ZXing (WebAssembly) for pictures and the formats it lacks.' : 'Reader: ZXing, compiled to WebAssembly and running on this page.'; });

        function beep() {
            if (!$('sc-beep').checked) return;
            try { const a = new (window.AudioContext || window.webkitAudioContext)(); const o = a.createOscillator(); const g = a.createGain(); o.frequency.value = 1320; g.gain.value = 0.06; o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime + 0.09); o.onended = () => a.close(); } catch { /* no audio */ }
            if (navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) navigator.vibrate(30);
        }
        function card(r, when, fresh) {
            const d = S.describePayload(r.text, r.format);
            const safe = d.href && /^(https?:|mailto:|tel:)/i.test(d.href) ? d.href : null;
            const fields = d.fields.length ? `<dl>${d.fields.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : '';
            const wifiPass = d.type === 'wifi' ? (d.fields.find((f) => f[0] === 'Password') || [])[1] : null;
            const make = toolUrl(/^(EAN|UPC|ITF|Code|Codabar|GS1 DataBar|ISBN)/.test(r.label) ? 'barcode' : r.label === 'Data Matrix' ? 'datamatrix' : 'qr', { text: r.text.slice(0, 700) });
            const el = document.createElement('article');
            el.className = 'result';
            if (!fresh) el.style.animation = 'none';
            el.innerHTML = `<div class="rh"><span class="fmt">${esc(r.label)}</span><span class="kind">${esc(d.title)}</span><span class="when">${esc(when)}</span></div>${fields}<div class="raw">${esc(r.text)}</div>
                <div class="acts"><button type="button" class="btn small" data-copy>${icon('copy')}Copy</button>${wifiPass && wifiPass !== '(none)' ? `<button type="button" class="btn small" data-pass>${icon('wifi')}Copy password</button>` : ''}${safe ? `<a class="btn small primary" href="${esc(safe)}" target="_blank" rel="noopener noreferrer nofollow">${icon('link')}Open ${esc(d.type === 'url' ? new URL(safe).host : d.title.toLowerCase())}</a>` : ''}<a class="btn small ghost" href="${esc(make)}">${icon('spark')}Make this code</a></div>`;
            el.querySelector('[data-copy]').onclick = () => copyText(r.text);
            if (el.querySelector('[data-pass]')) el.querySelector('[data-pass]').onclick = () => copyText(wifiPass);
            return el;
        }
        function renderHistory() {
            list.replaceChildren();
            if (!history.length) { list.innerHTML = note('', 'Codes you scan appear here, with what they contain. Nothing is opened until you choose to.'); return; }
            history.slice(0, 50).forEach((h) => list.appendChild(card(h, new Date(h.at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }), false)));
        }
        function found(results) {
            const now = Date.now();
            let added = false;
            for (const r of results) {
                const key = `${r.format}|${r.text}`;
                if (now - (seen.get(key) || 0) < 4000) { seen.set(key, now); continue; }
                seen.set(key, now);
                history = [{ text: r.text, format: r.format, label: r.label, at: now }, ...history.filter((h) => !(h.text === r.text && h.format === r.format))].slice(0, 50);
                if (list.querySelector('.note')) list.replaceChildren();
                list.prepend(card(r, 'just now', true));
                added = true;
            }
            if (added) { beep(); store.set('ov_codes_scans', history); }
        }
        /** Boxes over the picture: source coordinates mapped to the element, which shows the source with object-fit: contain. */
        function outline(results, sw, sh) {
            const rect = overlay.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            overlay.width = Math.round(rect.width * dpr); overlay.height = Math.round(rect.height * dpr);
            const g = overlay.getContext('2d');
            g.setTransform(dpr, 0, 0, dpr, 0, 0);
            g.clearRect(0, 0, rect.width, rect.height);
            if (!sw || !sh) return;
            const k = Math.min(rect.width / sw, rect.height / sh);
            const ox = (rect.width - sw * k) / 2, oy = (rect.height - sh * k) / 2;
            const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#3b82f6';
            for (const r of results) {
                if (!r.box || r.box.length < 4) continue;
                g.beginPath();
                r.box.forEach(([x, y], i) => { const px = ox + x * k, py = oy + y * k; if (i) g.lineTo(px, py); else g.moveTo(px, py); });
                g.closePath();
                g.lineWidth = 3; g.strokeStyle = accent; g.fillStyle = 'rgba(59,130,246,.18)';
                g.fill(); g.stroke();
                // A tag with the format over the code's top edge, kept inside the picture (the cards hold the text).
                const xs = r.box.map((p) => ox + p[0] * k), ys = r.box.map((p) => oy + p[1] * k);
                g.font = '700 11px Inter, system-ui, sans-serif';
                const w = g.measureText(r.label).width + 12;
                const tx = Math.max(0, Math.min(rect.width - w, Math.min(...xs))), ty = Math.max(0, Math.min(...ys) - 20);
                g.fillStyle = accent; g.beginPath(); g.roundRect ? g.roundRect(tx, ty, w, 18, 5) : g.rect(tx, ty, w, 18); g.fill();
                g.fillStyle = '#fff'; g.fillText(r.label, tx + 6, ty + 13);
            }
        }
        const frame = document.createElement('canvas');
        async function tick() {
            if (!stream || busy || video.readyState < 2) return;
            busy = true;
            try {
                let res = null;
                if (await R.native()) res = await R.readNative(video).catch(() => null);
                if (!res || !res.length) {
                    const vw = video.videoWidth, vh = video.videoHeight;
                    const k = Math.min(1, 1280 / Math.max(vw, vh));
                    frame.width = Math.round(vw * k); frame.height = Math.round(vh * k);
                    const g = frame.getContext('2d', { willReadFrequently: true });
                    g.drawImage(video, 0, 0, frame.width, frame.height);
                    res = (await R.readZxing(g.getImageData(0, 0, frame.width, frame.height), { tryHarder: false, max: 8 })).map((r) => ({ ...r, box: r.box && r.box.map(([x, y]) => [x / k, y / k]) }));
                }
                outline(res, video.videoWidth, video.videoHeight);
                if (res.length) found(res);
            } catch (e) { engine.textContent = `Reader problem: ${e.message}`; }
            busy = false;
        }
        async function start(deviceId) {
            stop();
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('This browser cannot use a camera here: choose a picture instead'); return; }
            try {
                stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: deviceId ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } } : { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
            } catch (e) {
                toast(e && e.name === 'NotAllowedError' ? 'Camera permission was refused' : 'No camera is available');
                return;
            }
            video.srcObject = stream; await video.play().catch(() => {});
            video.hidden = false; shot.hidden = true; drop.hidden = true; $('sc-aim').hidden = false;
            $('sc-stop').hidden = false; $('sc-again').hidden = true;
            devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
            $('sc-flip').hidden = devices.length < 2;
            const track = stream.getVideoTracks()[0];
            const caps = track && track.getCapabilities ? track.getCapabilities() : {};
            $('sc-torch').hidden = !caps.torch;
            R.zxing().catch(() => {});
            timer = setInterval(tick, 160);
        }
        function stop() {
            clearInterval(timer); timer = null;
            if (stream) stream.getTracks().forEach((t) => t.stop());
            stream = null; torch = false;
            video.hidden = true; $('sc-aim').hidden = true; $('sc-stop').hidden = true; $('sc-flip').hidden = true; $('sc-torch').hidden = true;
            if (shot.hidden) drop.hidden = false;
            outline([], 0, 0);
        }
        async function picture(file) {
            if (!file || !/^image\//.test(file.type || 'image/')) { toast('That is not a picture'); return; }
            stop();
            const url = URL.createObjectURL(file);
            shot.onload = async () => {
                drop.hidden = true; shot.hidden = false; $('sc-again').hidden = false;
                engine.textContent = 'Reading…';
                try {
                    let res = await R.readZxing(file, { tryHarder: true, max: 24 });
                    if (!res.length && await R.native()) { const bmp = await createImageBitmap(file); res = await R.readNative(bmp); }
                    outline(res, shot.naturalWidth, shot.naturalHeight);
                    engine.textContent = res.length ? `${res.length} code${res.length === 1 ? '' : 's'} found in the picture.` : 'No code found. Try a sharper or closer picture, with the code flat and well lit.';
                    seen.clear();
                    found(res);
                } catch (e) { engine.textContent = `Could not read it: ${e.message}`; }
            };
            shot.src = url;
        }
        $('sc-start').onclick = () => start();
        $('sc-stop').onclick = () => { stop(); drop.hidden = false; shot.hidden = true; };
        $('sc-flip').onclick = () => { if (!devices.length) return; deviceIdx = (deviceIdx + 1) % devices.length; start(devices[deviceIdx].deviceId); };
        $('sc-torch').onclick = async () => { const t = stream && stream.getVideoTracks()[0]; if (!t) return; torch = !torch; try { await t.applyConstraints({ advanced: [{ torch }] }); $('sc-torch').setAttribute('aria-pressed', String(torch)); } catch { toast('The torch is not available'); } };
        $('sc-file').onchange = (e) => picture(e.target.files[0]);
        $('sc-file2').onchange = (e) => picture(e.target.files[0]);
        $('sc-clear').onclick = () => { history = []; store.set('ov_codes_scans', []); renderHistory(); };
        const view = $('sc-view');
        ['dragenter', 'dragover'].forEach((ev) => view.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
        ['dragleave', 'drop'].forEach((ev) => view.addEventListener(ev, () => drop.classList.remove('over')));
        view.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) picture(f); });
        document.addEventListener('paste', (e) => { const item = [...(e.clipboardData ? e.clipboardData.items : [])].find((i) => i.type.startsWith('image/')); if (item) picture(item.getAsFile()); });
        window.addEventListener('pagehide', stop);
        document.addEventListener('visibilitychange', () => { if (document.hidden && stream) stop(); });
        renderHistory();
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
    // Check: GTIN / ISBN / SSCC numbers and GS1 element strings
    // ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
    function check() {
        const input = $('ck-text'), out = $('ck-out'), stage = $('ck-stage');
        input.value = params.get('text') || '';
        let draw = null;   // { sym, text }
        let gs1Sym = 'gs1-128';
        const KIND = { gtin8: 'GTIN-8 (EAN-8)', upce: 'UPC-E', upca: 'UPC-A (GTIN-12)', ean13: 'EAN-13 (GTIN-13)', isbn13: 'ISBN-13', isbn10: 'ISBN-10', issn: 'ISSN (EAN-13)', gtin14: 'GTIN-14', sscc: 'SSCC' };
        function preview() {
            if (!draw) { stage.innerHTML = '<div class="empty">The matching barcode appears here</div>'; return; }
            try {
                const c = document.createElement('canvas');
                const twoD = TWO_D.test(draw.sym);
                bwipjs.toCanvas(c, { bcid: draw.sym, text: draw.text, scale: 3, ...(twoD ? {} : { height: 14, ...textOpts(draw.sym) }), backgroundcolor: 'ffffff', paddingwidth: 10, paddingheight: 6 });
                c.className = 'art'; stage.replaceChildren(c);
                $('ck-studio').href = toolUrl(/datamatrix/.test(draw.sym) ? 'datamatrix' : 'barcode', { text: draw.text, sym: draw.sym });
            } catch (e) { stage.innerHTML = `<div class="err">${esc(bwipError(e))}</div>`; }
        }
        function run() {
            const t = input.value.trim();
            draw = null; $('ck-sym').hidden = true;
            if (!t) { out.innerHTML = note('', 'Type a product, book or shipping number, or paste GS1 data from a label or a scanner.'); preview(); return; }
            const isGs1 = /^\(\d{2,4}\)|^\]C1|^\]d2|^\]Q3/.test(t) || (/^\d{16,}/.test(t) && !S.identifyNumber(t)) || /[\x1d|]/.test(t);
            if (isGs1) {
                const g = S.parseGs1(t);
                out.innerHTML = (g.ok ? note('ok', `${g.parts.length} field${g.parts.length === 1 ? '' : 's'}, all valid.`) : note('bad', esc(g.error || 'Some fields are not valid.'))) +
                    `<table class="ais"><thead><tr><th>AI</th><th>Meaning</th><th>Value</th><th></th></tr></thead><tbody>${g.parts.map((p) => `<tr><td class="mono">(${esc(p.ai)})</td><td>${esc(p.title)}</td><td class="v">${esc(p.value)}${p.display && p.display !== p.value ? `<br><span class="muted">${esc(p.display)}</span>` : ''}</td><td class="${p.valid ? 'st-ok' : 'st-bad'}">${p.valid ? '✓' : esc(p.error)}</td></tr>`).join('')}</tbody></table>`;
                if (g.parts.length) {
                    draw = { sym: gs1Sym, text: S.gs1Text(g.parts) };
                    $('ck-sym').hidden = false;
                    seg($('ck-sym'), [['gs1-128', 'GS1-128'], ['gs1datamatrix', 'GS1 DataMatrix'], ['gs1qrcode', 'GS1 QR']], gs1Sym, (v) => { gs1Sym = v; draw.sym = v; preview(); });
                }
                preview();
                return;
            }
            const n = S.identifyNumber(t, { complete: true });
            if (!n) {
                const d = t.replace(/[\s-]/g, '');
                out.innerHTML = /^\d+$/.test(d) ? note('', `${d.length} digits is not a GS1 key length (8, 12, 13, 14 or 18, or one less to add a check digit). The check digit for these digits would be <b>${S.gs1CheckDigit(d)}</b>.`) : note('', 'Not a GTIN, ISBN or SSCC, and no GS1 Application Identifiers found.');
                preview();
                return;
            }
            const digits = n.missing ? n.fixed : n.digits;
            const cd = digits.slice(-1);
            const head = n.missing ? note('ok', `Check digit <b>${esc(cd)}</b> added.`) : n.valid ? note('ok', 'Check digit correct.') : note('bad', `The check digit is ${esc(n.digits.slice(-1))}; it should be <b>${esc(n.expected)}</b>.`, `<button type="button" class="btn small act" data-fix="${esc(n.fixed)}">Fix</button>`);
            const conv = [];
            if (n.isbn13) conv.push(['ISBN-13', n.isbn13]);
            if (n.isbn10) conv.push(['ISBN-10', n.isbn10]);
            if (n.upca) conv.push(['As UPC-A', n.upca]);
            if (n.kind === 'upca') conv.push(['As EAN-13', `0${n.fixed}`]);
            if (/^(ean13|upca|isbn13|issn|gtin8)$/.test(n.kind)) { const base = n.fixed.padStart(13, '0').slice(0, 12); conv.push(['As GTIN-14 (case, indicator 1)', `1${base}${S.gs1CheckDigit(`1${base}`)}`]); }
            if (n.kind === 'gtin14' || n.kind === 'sscc') conv.push(['GS1 string', n.kind === 'sscc' ? `(00)${n.fixed}` : `(01)${n.fixed}`]);
            out.innerHTML = `<div class="lbl">${esc(KIND[n.kind] || n.kind)}</div><div class="big-number">${esc(digits.slice(0, -1))}<span class="cd ${n.valid || n.missing ? 'ok' : 'bad'}">${esc(n.valid || n.missing ? cd : n.digits.slice(-1))}</span>${!n.valid && !n.missing ? `<span class="cd ok">${esc(n.expected)}</span>` : ''}</div>${head}<p class="muted" style="margin:6px 0">${esc(n.note)}</p>` +
                (conv.length ? `<table class="ais"><tbody>${conv.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="v">${esc(v)}</td><td><button type="button" class="btn small ghost" data-copy="${esc(v)}">${icon('copy')}</button></td></tr>`).join('')}</tbody></table>` : '');
            const fixed = n.valid || n.missing ? n.fixed : n.fixed;
            draw = { sym: n.symbology === 'isbn' ? 'isbn' : n.symbology, text: n.symbology === 'isbn' ? n.encode : n.kind === 'sscc' ? `(00)${fixed}` : n.kind === 'isbn10' ? n.isbn13 : fixed };
            preview();
        }
        out.addEventListener('click', (e) => {
            const f = e.target.closest('[data-fix]'); if (f) { input.value = f.dataset.fix; run(); }
            const c = e.target.closest('[data-copy]'); if (c) copyText(c.dataset.copy);
        });
        input.addEventListener('input', debounce(run, 120));
        // GS1 builder: rows of AI + value → the element string in the box above.
        const rows = $('ck-rows');
        const opts = Object.entries(S.AI).map(([ai, d]) => `<option value="${ai}">(${ai}) ${esc(d.t)}</option>`).join('');
        function addRow(ai = '01', value = '') {
            const r = document.createElement('div');
            r.className = 'aibuild';
            r.innerHTML = `<select aria-label="Application Identifier">${opts}</select><input type="text" class="mono" aria-label="Value" value="${esc(value)}" autocomplete="off"><button type="button" class="btn small ghost" aria-label="Remove">${icon('trash')}</button>`;
            r.querySelector('select').value = ai;
            rows.appendChild(r);
        }
        function build() {
            const parts = [...rows.querySelectorAll('.aibuild')].map((r) => ({ ai: r.querySelector('select').value, value: r.querySelector('input').value.trim() })).filter((p) => p.value);
            if (parts.length) { input.value = S.gs1Text(parts); run(); }
        }
        rows.addEventListener('input', build);
        rows.addEventListener('change', build);
        rows.addEventListener('click', (e) => { if (e.target.closest('button')) { e.target.closest('.aibuild').remove(); build(); } });
        $('ck-add').onclick = () => { addRow('10', ''); };
        addRow('01', '09506000134352'); addRow('17', '271231'); addRow('10', 'ABC123');
        if (!input.value) build();
        $('ck-png').onclick = async () => { if (!draw) return toast('Nothing to download yet'); const c = document.createElement('canvas'); try { bwipjs.toCanvas(c, { bcid: draw.sym, text: draw.text, scale: 4, ...(TWO_D.test(draw.sym) ? {} : { height: 15, ...textOpts(draw.sym) }), backgroundcolor: 'ffffff', paddingwidth: 10, paddingheight: 8 }); download(await canvasBlob(c), `${draw.sym}-${slug(draw.text)}.png`); } catch (e) { toast(bwipError(e)); } };
        $('ck-svg').onclick = () => { if (!draw) return toast('Nothing to download yet'); try { download(new Blob([bwipjs.toSVG({ bcid: draw.sym, text: draw.text, ...(TWO_D.test(draw.sym) ? {} : textOpts(draw.sym)), backgroundcolor: 'ffffff', paddingwidth: 10, paddingheight: 8 })], { type: 'image/svg+xml' }), `${draw.sym}-${slug(draw.text)}.svg`); } catch (e) { toast(bwipError(e)); } };
        run();
        currentText = () => input.value.trim();
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
    // Bulk: many codes → ZIP or a label sheet
    // ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
    function bulk() {
        const MAX = 2000;
        let src = 'list';
        let made = [];   // { value, caption, blob?, svg?, url }
        symbolOptions($('bk-type'), params.get('sym') || 'code128');
        $('bk-text').value = params.get('text') || 'SKU-0001\nSKU-0002\nSKU-0003\nSKU-0004\nSKU-0005\nSKU-0006';
        seg($('bk-src'), [['list', 'List or CSV'], ['seq', 'Sequence']], src, (v) => { src = v; $('bk-list').hidden = v !== 'list'; $('bk-seq').hidden = v !== 'seq'; run(); });
        function values() {
            if (src === 'seq') {
                const n = Math.min(MAX, Math.max(1, +$('bk-count').value || 1)), start = +$('bk-start').value || 0, step = Math.max(1, +$('bk-step').value || 1), pad = Math.max(0, Math.min(18, +$('bk-pad').value || 0));
                const pre = $('bk-prefix').value, suf = $('bk-suffix').value, gtin = $('bk-gtin').checked;
                return Array.from({ length: n }, (_, i) => { let num = String(start + i * step).padStart(pad, '0'); if (gtin) num += S.gs1CheckDigit(num); return { value: `${pre}${num}${suf}`, caption: '' }; });
            }
            const csv = $('bk-csv').checked;
            return $('bk-text').value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, MAX).map((l) => {
                if (!csv) return { value: l, caption: '' };
                const m = /^("(?:[^"]|"")*"|[^,\t]*)[,\t](.*)$/.exec(l);
                const unq = (s) => s.replace(/^"|"$/g, '').replace(/""/g, '"').trim();
                return m ? { value: unq(m[1]), caption: unq(m[2]) } : { value: l, caption: '' };
            });
        }
        function opts(sym, value) {
            const twoD = TWO_D.test(sym);
            return { bcid: sym, text: value, scale: 3, backgroundcolor: 'ffffff', paddingwidth: twoD ? 4 : 10, paddingheight: 4, ...(twoD ? {} : { height: 12, ...($('bk-showtext').checked ? textOpts(sym) : {}) }) };
        }
        let gen = 0;
        async function run() {
            const g = ++gen;
            made.forEach((m) => m.url && URL.revokeObjectURL(m.url));
            made = [];
            const sym = $('bk-type').value;
            const list = values();
            const fails = [];
            const sheet = $('bk-sheet');
            sheet.replaceChildren();
            const t0 = performance.now();
            for (let i = 0; i < list.length; i++) {
                if (g !== gen) return;
                const v = list[i];
                try {
                    const svg = bwipjs.toSVG(opts(sym, v.value));
                    const item = { ...v, svg };
                    made.push(item);
                    if (made.length <= 48) {
                        item.url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
                        const f = document.createElement('figure');
                        f.innerHTML = `<img src="${item.url}" alt="${esc(v.value)}">${v.caption || !$('bk-showtext').checked || TWO_D.test(sym) ? `<figcaption>${esc(v.caption || v.value)}</figcaption>` : ''}`;
                        sheet.appendChild(f);
                    }
                } catch (e) { fails.push(`${v.value}: ${bwipError(e)}`); }
                if (i % 40 === 39) { $('bk-count-o').textContent = `${made.length} of ${list.length}…`; await new Promise((r) => setTimeout(r)); }
            }
            $('bk-count-o').textContent = `${made.length} code${made.length === 1 ? '' : 's'}${list.length >= MAX ? ` (the first ${MAX})` : ''}`;
            $('bk-time').textContent = made.length ? `${Math.round(performance.now() - t0)} ms${made.length > 48 ? ' · preview shows 48' : ''}` : '';
            const fl = $('bk-fails');
            fl.hidden = !fails.length;
            fl.innerHTML = fails.slice(0, 20).map((f) => `<li>${esc(f)}</li>`).join('') + (fails.length > 20 ? `<li>and ${fails.length - 20} more</li>` : '');
        }
        const later = debounce(run, 300);
        ['bk-text', 'bk-prefix', 'bk-start', 'bk-count', 'bk-step', 'bk-pad', 'bk-suffix'].forEach((id) => $(id).addEventListener('input', later));
        ['bk-csv', 'bk-gtin', 'bk-type', 'bk-showtext'].forEach((id) => $(id).addEventListener('change', run));
        $('bk-zip').onclick = async () => {
            if (!made.length) return toast('Nothing to download yet');
            const fmt = $('bk-fmt').value;
            const btn = $('bk-zip'); btn.disabled = true;
            try {
                const files = [];
                for (let i = 0; i < made.length; i++) {
                    const m = made[i];
                    const base = slug(m.value) || `code-${i + 1}`;
                    if (fmt === 'svg') files.push({ name: `${base}.svg`, data: m.svg });
                    else {
                        const c = document.createElement('canvas');
                        bwipjs.toCanvas(c, { ...opts($('bk-type').value, m.value), scale: 4 });
                        files.push({ name: `${base}.png`, data: D.pngWithDpi(new Uint8Array(await (await canvasBlob(c)).arrayBuffer()), 300) });
                    }
                    if (i % 25 === 24) { btn.textContent = `${i + 1} / ${made.length}…`; await new Promise((r) => setTimeout(r)); }
                }
                download(new Blob([D.zip(files)], { type: 'application/zip' }), `barcodes-${made.length}.zip`);
            } catch (e) { toast(bwipError(e)); }
            btn.disabled = false; btn.innerHTML = `${icon('download')}Download ZIP`;
        };
        $('bk-print').onclick = () => {
            if (!made.length) return toast('Nothing to print yet');
            const lw = +$('bk-lw').value || 63.5, lh = +$('bk-lh').value || 38.1, cols = Math.max(1, +$('bk-cols').value || 3), gap = +$('bk-gap').value || 0, margin = +$('bk-margin').value || 0;
            const cap = $('bk-caption').checked;
            const sheet = $('print-sheet');
            sheet.style.width = `${cols * lw + (cols - 1) * gap}mm`;
            sheet.innerHTML = `<style>@page{margin:${margin}mm}#print-sheet{display:grid;grid-template-columns:repeat(${cols},${lw}mm);gap:${gap}mm}#print-sheet .lab{width:${lw}mm;height:${lh}mm;padding:2mm}</style>` +
                made.map((m) => `<div class="lab"><img src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(m.svg)}" alt="">${cap && m.caption ? `<span>${esc(m.caption)}</span>` : ''}</div>`).join('');
            setTimeout(() => window.print(), 100);
        };
        run();
        currentText = () => '';
    }

    // ── Start ────────────────────────────────────────────────────────────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', () => {}, { once: true });
    function boot() {
        try {
            const token = (() => { try { return localStorage.getItem('ov_token'); } catch { return null; } })();
            if (window.OpenVibeNavbar) OpenVibeNavbar.init({ service: 'tools', apiBase: 'https://openvibe.network', token, history: { type: 'tool', title: T.h1 }, silentLogin: 'https://openvibe.tools/auth/login?silent=1&next={url}' });
        } catch { /* the page works without it */ }
        try {
            if (window.OpenVibeFooter) OpenVibeFooter.init({ service: 'tools', variant: ID === 'codes' ? 'full' : 'compact', mount: '#ov-footer', apiBase: 'https://openvibe.network', links: [
                { heading: 'Barcode & QR', items: ['qr', 'barcode', 'datamatrix', 'scan', 'gs1', 'bulkbarcodes'].map((id) => ({ name: TOOLS[id].h1, url: toolUrl(id) })) },
                { heading: 'One type', items: ['code128', 'ean13', 'upc', 'isbn', 'pdf417', 'aztec', 'wifiqr', 'vcardqr'].map((id) => ({ name: TOOLS[id].h1, url: toolUrl(id) })) },
            ] });
        } catch { /* */ }
        if (!window.bwipjs && T.view !== 'scan') { $(`view-${T.view}`).insertAdjacentHTML('afterbegin', note('bad', 'The barcode library did not load. Check your connection and reload the page.')); return; }
        ({ hub, qr, barcode, scan, check, bulk })[T.view]();
    }
    boot();
})();
