// ═══════════════════════════════════════════════════════════════
// Docs.OpenVibe — Client Application
// The page around the tool is the shared frame (openvibe-shared ≥ 4.57.1): the server draws the head,
// the box, the answer slot, the family and the folds for this host. This file fills the box (the drop
// zone, the tool's own options and the one button) and the answer (the file it made, its size before
// and after, and Download). The upload, the processing and the download are the app's own, unchanged.
// ═══════════════════════════════════════════════════════════════

(function () {
    'use strict';

    // ── State ────────────────────────────────────────────────
    let ctx = null;           // domain context from /api/context
    let selectedFiles = [];   // the File objects the drop zone holds

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
            ctx = { toolId: 'hub', brandName: 'Docs.OpenVibe', tools: [] };
        }

        initNavbar();
        initNotifications();
        if (typeof OpenVibeAccountSwitcher !== 'undefined') OpenVibeAccountSwitcher.init({ apiBase: 'https://openvibe.network' });
        showAvailability();
        initDrop();
        initOptions();
        reattach();
    }

    // ── A tool whose command-line tools are not on the server yet ──
    // Protect and Unlock need qpdf, PDF to images needs poppler: while one is missing the tool answers
    // 503, so the page says so instead of letting the upload fail.
    function showAvailability() {
        const op = (ctx && ctx.defaultOp) || null;
        const tool = (ctx.tools || []).find((t) => t.id === op);
        const off = !!(tool && tool.available === false);
        const card = document.querySelector('.ovk-tool-card');
        if (!card) return;
        let note = document.getElementById('tool-notice');
        if (off && !note) {
            note = document.createElement('div');
            note.id = 'tool-notice';
            note.className = 'tool-notice';
            note.setAttribute('role', 'status');
            card.appendChild(note);
        }
        if (note) {
            note.textContent = off ? `${tool.label} is being set up on the server and is not available yet. The other PDF tools work now.` : '';
            note.style.display = off ? '' : 'none';
        }
        const drop = document.querySelector('.ovk-drop');
        if (drop) drop.hidden = off;
        if (optionsPanel) optionsPanel.hidden = off || optionsPanel.hidden;
        if (off && processBtn) processBtn.disabled = true;
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
                service: 'docs',
                token,
                user: ctx?.user || user,
                apiBase: 'https://openvibe.network',
                history: { type: 'tool', title: ctx?.brandName || 'Docs.OpenVibe' },
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
                service: 'docs',
                variant: 'compact',
                mount: '#ov-footer',
                apiBase: 'https://openvibe.network',
                brandName: 'OpenVibe.Tools',
                links: [{ heading: 'PDF tools', items: [
                    { name: 'Merge', url: 'https://mergepdf.openvibe.tools' },
                    { name: 'Split', url: 'https://splitpdf.openvibe.tools' },
                    { name: 'Compress', url: 'https://compresspdf.openvibe.tools' },
                    { name: 'Rotate', url: 'https://rotatepdf.openvibe.tools' },
                    { name: 'Watermark', url: 'https://watermarkpdf.openvibe.tools' },
                    { name: 'Protect', url: 'https://protectpdf.openvibe.tools' },
                ] }],
            });
        } catch { /* optional */ }
    }

    // ── Notifications (OpenVibe bell + toasts) ───────────
    function initNotifications() {
        const token = getCookie('ov_token') || localStorage.getItem('ov_token');
        if (typeof OpenVibeNotifications === 'undefined') return;

        OpenVibeNotifications.init({ token: token || null, apiBase: 'https://openvibe.network' });

        if (typeof OpenVibeNavbar !== 'undefined') {
            const mount = OpenVibeNavbar.getBellMount();
            if (mount) {
                const bell = OpenVibeNotifications.createBell();
                if (bell) mount.appendChild(bell);
            }
        }
    }

    // ── The box: the drop zone ───────────────────────────────
    function initDrop() {
        if (!fileInput) return;
        fileInput.addEventListener('change', () => {
            const files = Array.prototype.slice.call(fileInput.files || []);
            if (files.length) handleFiles(files);
        });
        if (clearBtn) clearBtn.addEventListener('click', resetUpload);

        const sampleLink = document.querySelector('[data-ovk-sample]');
        if (sampleLink && window.OVToolFrame) {
            sampleLink.addEventListener('click', (e) => {
                e.preventDefault();
                window.OVToolFrame.sample(sampleLink.getAttribute('data-ovk-sample'), (file) => handleFiles([file]));
            });
        }
    }

    function handleFiles(files) {
        const many = fileInput.hasAttribute('multiple');
        const max = many ? 50 : 1;
        if (files.length > max) {
            fail(`That is more than ${max} file${max === 1 ? '' : 's'}.`);
            return;
        }
        const tooBig = files.find((f) => f.size > 100 * 1024 * 1024);
        if (tooBig) {
            fail('That file is too large. The maximum is 100 MB.');
            return;
        }
        selectedFiles = files;
        if (optionsPanel) optionsPanel.hidden = false;
        if (processBtn) processBtn.disabled = false;
        hideAnswer();
    }

    function resetUpload() {
        selectedFiles = [];
        if (fileInput) fileInput.value = '';
        if (optionsPanel) optionsPanel.hidden = true;
        if (processBtn) processBtn.disabled = true;
        hideAnswer();
    }

    // ── The box: the options and the one button ─────────────
    function initOptions() {
        if (processBtn) processBtn.addEventListener('click', processDocument);
    }

    /** The tool's own options, as the job's input: the fields the descriptor names, and nothing else. */
    function collectInput() {
        const form = document.querySelector('#ovk-docs-form');
        const input = {};
        if (!form) return input;
        form.querySelectorAll('input[name], select[name], textarea[name]').forEach((el) => {
            if (el.type === 'hidden') { input[el.name] = el.value; return; }
            // The drop zone's own file field is not an option: the file goes in the job's files.
            if (el.type === 'file') return;
            if (el.type === 'radio') { if (el.checked) input[el.name] = el.value; return; }
            if (el.type === 'checkbox') { input[el.name] = el.checked; return; }
            if (el.value === '') return;
            input[el.name] = el.value;
        });
        return input;
    }

    // ── Process ──────────────────────────────────────────────
    async function processDocument() {
        if (!selectedFiles.length) return;

        const input = collectInput();
        if (processBtn) {
            processBtn.disabled = true;
            const span = processBtn.querySelector('span');
            // The button keeps its verb while it works: "Compress…", not "Working…".
            if (span) span.textContent = `${span.textContent.replace(/…$/, '')}…`;
        }
        showWorking();

        try {
            const many = selectedFiles.length > 1;
            const job = await OVJobs.submit({
                type: 'docs.process', input, files: selectedFiles, fileField: many ? 'files' : 'file',
            });
            OVJobs.remember(job.id);
            followJob(job);
        } catch (err) {
            failProcessing(err.message);
        }
    }

    // ── Jobs ─────────────────────────────────────────────────
    let watcher = null;

    function processingText(job) {
        const pct = job.progress && job.progress.percent;
        if (job.cancel_requested) return 'Cancelling…';
        if (job.state === 'queued') return 'Waiting for a free slot…';
        const label = (job.progress && job.progress.message) || 'Working on your document';
        return pct != null ? `${label}… ${Math.round(pct)}%` : `${label}…`;
    }

    function followJob(job) {
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
        if (processBtn) processBtn.disabled = !selectedFiles.length;
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
            body: '<p data-ovk-working>Your document is being worked on by our server. This page stays open until it is done.</p>',
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
        if (processBtn) processBtn.disabled = false;
        const out = data.output || {};
        const rows = [];
        if (out.ext) rows.push(['Format', String(out.ext).toUpperCase()]);
        if (data.fileCount) rows.push(['Files', String(data.fileCount)]);
        if (data.pageCount) rows.push(['Pages', String(data.pageCount)]);
        if (data.savings && data.savings.savedPercent) rows.push(['Smaller by', `${data.savings.savedPercent}%`, { text: 'good', tone: 'ok' }]);
        const expires = data.download && data.download.expiresIn;
        if (expires) {
            const mins = Math.max(1, Math.round(expires / 60000));
            rows.push(['Kept for', mins >= 60 ? `${Math.round(mins / 60)} hour${Math.round(mins / 60) === 1 ? '' : 's'}` : `${mins} minutes`]);
        }
        const html = window.OVToolFrame.fileAnswer({
            title: 'Your document is ready',
            before: selectedFiles.reduce((sum, f) => sum + f.size, 0) || null,
            after: out.size != null ? out.size : null,
            rows,
            downloadUrl: data.download && data.download.downloadUrl,
            filename: data.download && data.download.filename,
        });
        window.OVToolFrame.show(html);
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
