// ═══════════════════════════════════════════════════════════════
// Img.OpenVibe — Client Application
// The page around the tool is the shared frame (openvibe-shared ≥ 4.57.1): the server draws the head,
// the box, the answer slot, the family and the folds for this host. This file fills the box (the drop
// zone, the options and the one button) and the answer (the file it made, its size before and after,
// and Download). The upload, the processing and the download are the app's own, unchanged.
// ═══════════════════════════════════════════════════════════════

(function () {
    'use strict';

    // ── State ────────────────────────────────────────────────
    let ctx = null;           // domain context from /api/context
    let selectedFile = null;  // File object
    let selectedTool = 'convert';

    // ── DOM refs ─────────────────────────────────────────────
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    const fileInput = $('#file-input');
    const optionsPanel = $('#options-panel');
    const processBtn = $('#process-btn');
    const clearBtn = $('#clear-btn');
    const kit = () => window.OpenVibeKit;

    // ── Init ─────────────────────────────────────────────────
    async function init() {
        try {
            const res = await fetch('/api/context');
            ctx = await res.json();
        } catch {
            ctx = { toolId: 'hub', brandName: 'Img.OpenVibe', defaultOp: 'convert', faIcon: 'fa-images', tools: [] };
        }

        initNavbar();
        initNotifications();
        if (typeof OpenVibeAccountSwitcher !== 'undefined') OpenVibeAccountSwitcher.init({ apiBase: 'https://openvibe.network' });
        showUnavailableInputs();
        initDrop();
        initOptions();
        initResult();
        reattach();
    }

    // ── Navbar ───────────────────────────────────────────────
    function initNavbar() {
        const token = getCookie('ov_token') || localStorage.getItem('ov_token');
        let user = null;
        if (token) {
            try { user = JSON.parse(atob(token.split('.')[1])); } catch { /* invalid token */ }
        }

        // The brand is the site ("Tools"), not the subdomain's name: the same brand the network and
        // code tool pages carry (owner ask 11).
        if (typeof OpenVibeNavbar !== 'undefined') {
            OpenVibeNavbar.init({
                service: 'img',
                token,
                user: ctx?.user || user,
                apiBase: 'https://openvibe.network',
                history: { type: 'tool', title: ctx?.brandName || 'Img.OpenVibe' },
                silentLogin: 'https://openvibe.tools/auth/login?silent=1&next={url}',
                brand: { subLabel: 'Tools', name: 'OpenVibe.Tools' },
            });
        }
        initFooter();
    }

    /* ---------- Footer (shared OpenVibeFooter) ---------- */
    function initFooter() {
        if (typeof OpenVibeFooter === 'undefined') return;
        try {
            OpenVibeFooter.init({
                service: 'img',
                variant: 'compact',
                mount: '#ov-footer',
                apiBase: 'https://openvibe.network',
                brandName: 'OpenVibe.Tools',
                links: [{ heading: 'Img tools', items: [
                    { name: 'Convert', url: 'https://convert.openvibe.tools' },
                    { name: 'Compress', url: 'https://compress.openvibe.tools' },
                    { name: 'Resize', url: 'https://resize.openvibe.tools' },
                    { name: 'Crop', url: 'https://crop.openvibe.tools' },
                    { name: 'Favicon', url: 'https://favicon.openvibe.tools' },
                    { name: 'PNG', url: 'https://png.openvibe.tools' },
                    { name: 'JPG', url: 'https://jpg.openvibe.tools' },
                    { name: 'WebP', url: 'https://webp.openvibe.tools' },
                ] }],
            });
        } catch { /* optional */ }
    }

    // ── Notifications (OpenVibe bell + toasts) ───────────
    function initNotifications() {
        const token = getCookie('ov_token') || localStorage.getItem('ov_token');
        if (typeof OpenVibeNotifications === 'undefined') return;

        OpenVibeNotifications.init({
            token: token || null,
            apiBase: 'https://openvibe.network',
        });

        if (typeof OpenVibeNavbar !== 'undefined') {
            const mount = OpenVibeNavbar.getBellMount();
            if (mount) {
                const bell = OpenVibeNotifications.createBell();
                if (bell) mount.appendChild(bell);
            }
        }
    }

    // A format this server cannot read yet (HEIC before libheif's decoder is installed): say so up
    // front on the page that is about it, instead of letting the upload fail.
    function showUnavailableInputs() {
        if (!ctx || ctx.toolId !== 'heic') return;
        if (!ctx.inputs || ctx.inputs.heic !== false) return;
        const card = document.querySelector('.ovk-tool-card');
        if (!card || document.getElementById('input-notice') || !kit()) return;
        const note = document.createElement('div');
        note.id = 'input-notice';
        note.innerHTML = kit().notice({
            kind: 'warn',
            text: 'HEIC (iPhone) photos cannot be converted yet: the decoder is being set up on the server. JPG, PNG, WebP, AVIF and the other formats work now.',
        });
        card.insertBefore(note, card.firstChild);
    }

    // ── The box: the drop zone ───────────────────────────────
    function initDrop() {
        if (!fileInput) return;
        fileInput.addEventListener('change', () => {
            if (fileInput.files && fileInput.files.length) handleFile(fileInput.files[0]);
        });
        if (clearBtn) clearBtn.addEventListener('click', resetUpload);

        // "Try": the sample picture goes into the drop zone as if it had been chosen.
        const sampleLink = document.querySelector('[data-ovk-sample]');
        if (sampleLink && window.OVToolFrame) {
            sampleLink.addEventListener('click', (e) => {
                e.preventDefault();
                window.OVToolFrame.sample(sampleLink.getAttribute('data-ovk-sample'), handleFile);
            });
        }
    }

    function handleFile(file) {
        if (!file) return;
        if (!file.type.startsWith('image/') && file.type !== 'image/svg+xml') {
            fail('Please choose an image file.');
            return;
        }
        if (file.size > 50 * 1024 * 1024) {
            fail('That file is too large. The maximum is 50 MB.');
            return;
        }

        selectedFile = file;
        selectedTool = (ctx && ctx.defaultOp) || 'convert';
        if (optionsPanel) optionsPanel.hidden = false;
        if (processBtn) processBtn.disabled = false;
        hideAnswer();
    }

    function resetUpload() {
        selectedFile = null;
        if (fileInput) fileInput.value = '';
        if (optionsPanel) optionsPanel.hidden = true;
        if (processBtn) processBtn.disabled = true;
        hideAnswer();
    }

    // ── The box: the options and the one button ─────────────
    function initOptions() {
        // The format chips: the button follows the format that is picked ("Convert to PNG").
        $$('input[name=format]').forEach((radio) => radio.addEventListener('change', updateVerb));

        // The quality slider: the kit shows the value; the app only reads it.
        if (processBtn) processBtn.addEventListener('click', processImage);
    }

    function selectedFormat() {
        const checked = document.querySelector('input[name=format]:checked');
        return checked ? checked.value : ((ctx && ctx.defaultFormat) || 'png');
    }

    function updateVerb() {
        if (!processBtn) return;
        const span = processBtn.querySelector('span');
        if (!span) return;
        if (selectedTool === 'compress') span.textContent = 'Compress';
        else if (selectedTool === 'resize') span.textContent = 'Resize';
        else if (selectedTool === 'crop') span.textContent = 'Crop';
        else if (ctx && ctx.toolId === 'favicon') span.textContent = 'Make favicon';
        else span.textContent = `Convert to ${selectedFormat().toUpperCase()}`;
    }

    function numberValue(name) {
        const el = document.querySelector(`[name="${name}"]`);
        return el && el.value !== '' ? Number(el.value) : null;
    }

    function radioValue(name) {
        const el = document.querySelector(`input[name="${name}"]:checked`);
        return el ? el.value : '';
    }

    // ── Process ──────────────────────────────────────────────
    async function processImage() {
        if (!selectedFile) return;

        const input = { tool: selectedTool };
        if (selectedTool === 'convert') {
            input.format = selectedFormat();
            const q = numberValue('quality');
            if (q != null) input.quality = q;
        } else if (selectedTool === 'compress') {
            const q = numberValue('quality');
            if (q != null) input.quality = q;
        } else if (selectedTool === 'resize') {
            const pct = numberValue('percentage');
            if (pct != null) input.percentage = pct;
            else {
                const w = numberValue('width');
                const h = numberValue('height');
                if (w != null) input.width = w;
                if (h != null) input.height = h;
            }
            const fit = document.querySelector('[name="fit"]');
            if (fit && fit.value) input.fit = fit.value;
        } else if (selectedTool === 'crop') {
            const aspect = radioValue('aspect');
            if (aspect) input.aspect = aspect;
            else {
                for (const k of ['left', 'top', 'width', 'height']) {
                    const v = numberValue(k);
                    if (v != null) input[k] = v;
                }
            }
        }

        if (processBtn) {
            processBtn.disabled = true;
            const span = processBtn.querySelector('span');
            // The button keeps its verb while it works: "Compress…", not "Working…".
            if (span) span.textContent = `${span.textContent.replace(/…$/, '')}…`;
        }
        showWorking();

        try {
            const job = await OVJobs.submit({ type: 'img.process', input, files: [selectedFile] });
            OVJobs.remember(job.id);
            followJob(job);
        } catch (err) {
            failProcessing(err.message);
        }
    }

    // ── Jobs ─────────────────────────────────────────────────
    let watcher = null;
    let currentJob = null;

    function processingText(job) {
        const pct = job.progress && job.progress.percent;
        if (job.cancel_requested) return 'Cancelling…';
        if (job.state === 'queued') return 'Waiting for a free slot…';
        const label = (job.progress && job.progress.message) || 'Processing your image';
        return pct != null ? `${label}… ${Math.round(pct)}%` : `${label}…`;
    }

    function followJob(job) {
        currentJob = job.id;
        hideAnswer();
        showWorking();
        if (watcher) watcher.close();
        watcher = OVJobs.watch(job.id, {
            onUpdate: (j) => {
                const out = document.querySelector('.ovk-tool-out');
                if (out) out.querySelector('[data-ovk-working]')?.setAttribute('data-progress', processingText(j));
            },
            onDone(done) {
                watcher = null;
                if (done.state === 'succeeded') return showResult(jobResult(done));
                OVJobs.forget();
                failProcessing(done.state === 'cancelled' ? null : (done.error && done.error.detail) || 'Processing failed');
            },
            onGone() { OVJobs.forget(); failProcessing(null); },
        });
    }

    /** A finished job in the shape the synchronous endpoint answers with. */
    function jobResult(job) {
        const f = (job.result && job.result.files && job.result.files[0]) || {};
        return {
            ...(job.result && job.result.data),
            download: { id: job.id, downloadUrl: f.url, previewUrl: f.url ? `${f.url}?inline=1` : null, filename: f.name, expiresIn: OVJobs.expiresIn(job) },
        };
    }

    function resetVerb() {
        const span = processBtn && processBtn.querySelector('span');
        if (span) span.textContent = span.textContent.replace(/…$/, '');
    }

    function failProcessing(message) {
        resetVerb();
        if (processBtn) {
            processBtn.disabled = !selectedFile;
            updateVerb();
        }
        if (message) fail(message);
        else hideAnswer();
    }

    /** After a reload: pick the job up again from ?job=<id> or this tab's session. */
    function reattach() {
        const id = window.OVJobs && OVJobs.recall();
        if (!id) return;
        OVJobs.get(id).then(followJob).catch(() => OVJobs.forget());
    }

    // ── The answer ───────────────────────────────────────────
    function showWorking() {
        const out = document.querySelector('.ovk-tool-out');
        if (!out || !kit()) return;
        out.innerHTML = kit().answer({
            title: 'Working…',
            body: '<p data-ovk-working>Your picture is being processed on our server. This page stays open until it is done.</p>',
        });
    }

    function hideAnswer() {
        const out = document.querySelector('.ovk-tool-out');
        if (out) out.innerHTML = '';
    }

    function fail(message) {
        const out = document.querySelector('.ovk-tool-out');
        if (!out || !kit()) return;
        out.innerHTML = kit().answer({ title: 'That did not work', tone: 'bad', body: `<p>${escapeHtml(message)}</p>` });
    }

    function showResult(data) {
        resetVerb();
        if (processBtn) {
            processBtn.disabled = false;
            updateVerb();
        }
        const out = data.output || {};
        const rows = [];
        if (out.ext) rows.push(['Format', String(out.ext).toUpperCase()]);
        if (data.dimensions) rows.push(['Size', `${data.dimensions.original.width}×${data.dimensions.original.height} → ${data.dimensions.resized.width}×${data.dimensions.resized.height}`]);
        if (data.crop) rows.push(['Kept', `${data.crop.width}×${data.crop.height}`]);
        const expires = data.download && data.download.expiresIn;
        if (expires) {
            const mins = Math.max(1, Math.round(expires / 60000));
            rows.push(['Kept for', mins >= 60 ? `${Math.round(mins / 60)} hour${Math.round(mins / 60) === 1 ? '' : 's'}` : `${mins} minutes`]);
        }
        const html = window.OVToolFrame.fileAnswer({
            title: 'Your picture is ready',
            before: selectedFile ? selectedFile.size : null,
            after: out.size != null ? out.size : null,
            savedPercent: data.savings && data.savings.savedPercent,
            rows,
            downloadUrl: data.download && data.download.downloadUrl,
            filename: data.download && data.download.filename,
        });
        window.OVToolFrame.show(html);
    }

    // ── Result ───────────────────────────────────────────────
    function initResult() {
        // Nothing to wire: the answer is drawn in the frame's answer slot.
    }

    // ── Helpers ──────────────────────────────────────────────
    function getCookie(name) {
        const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
        return match ? decodeURIComponent(match[1]) : null;
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ── Boot ─────────────────────────────────────────────────
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
