/* The tool frame's browser glue (openvibe-shared ≥ 4.57.1, owner ask 11, part 2).
 *
 * The satellite apps keep their own upload, processing and download code; this only fills the frame:
 * the answer a file tool draws in the frame's answer slot, and the sample a "Try" link drops into the
 * drop zone. The markup comes from openvibe-shared/kit, the same builders the server used.
 *
 * Served by each app at /js/tool-frame.js (the file lives in apps/_shared/public, so the three file
 * apps share one copy instead of three).
 */
(function () {
    'use strict';

    var kit = window.OpenVibeKit;
    if (!kit) return;
    var currentUpload = null;

    /** A file size in the words a person reads: "1.4 MB", "812 KB". */
    function size(bytes) {
        var b = Number(bytes) || 0;
        if (b >= 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + ' MB';
        if (b >= 1024) return Math.round(b / 1024) + ' KB';
        return b + ' B';
    }

    /**
     * The answer of a file tool: the file it made, its size before and after, and Download.
     * @param {object} o
     *   title        the answer's heading
     *   before       the size of the file that went in (bytes)
     *   after        the size of the file that came out (bytes)
     *   savedPercent how much smaller it is (a number, or nothing)
     *   rows         extra rows: [[label, value]]
     *   downloadUrl  where the file is
     *   filename     the name it downloads under
     *   body         markup under the rows
     *   tone         'bad' for a failure
     */
    function fileAnswer(o) {
        var rows = [];
        if (o.before != null) rows.push(['Before', size(o.before)]);
        if (o.after != null) rows.push(['After', size(o.after), o.savedPercent ? { text: o.savedPercent + '% smaller', tone: 'ok' } : null]);
        (o.rows || []).forEach(function (r) { rows.push(r); });
        var actions = o.downloadUrl
            ? [kit.button({ href: o.downloadUrl, label: 'Download', icon: 'download', kind: 'primary', attrs: { download: o.filename || '' } })]
            : [];
        return kit.answer({
            title: o.title || '', badge: o.badge || null, rows: rows, actions: actions,
            body: o.body || '', tone: o.tone || '', live: true,
        });
    }

    /** Put an answer in the frame's answer slot. */
    function show(html) {
        var out = document.querySelector('.ovk-tool-out');
        if (out) out.innerHTML = html;
        return out;
    }

    /**
     * Load a sample file into the drop zone, as if the person had chosen it.
     * @param {string} url the sample's address
     * @param {function} onFile called with the File
     */
    function sample(url, onFile) {
        if (!url || typeof fetch !== 'function') return;
        fetch(url, { credentials: 'same-origin' }).then(function (r) {
            if (!r.ok) throw new Error('sample ' + r.status);
            return r.blob();
        }).then(function (blob) {
            var name = String(url).split('/').pop() || 'sample';
            var file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
            if (currentUpload) currentUpload.add([file]);
            else if (onFile) onFile(file);
        }).catch(function () { /* the sample is a convenience, not a promise */ });
    }

    /** Shared picker for image, document and audio tools; their job transport owns the upload. */
    function upload(onFiles) {
        var root = document.querySelector('[data-ov-tool-upload]');
        var input = document.getElementById('file-input');
        var error = document.querySelector('[data-ov-tool-upload-error]');
        var progressRoot = document.querySelector('[data-ov-tool-upload-progress]');
        if (!root || !input || !error || !progressRoot || !window.OVUpload) return null;
        var files = [];
        var clearing = false;
        var maxBytes = Number(root.dataset.maxBytes);
        var maxFiles = Number(root.dataset.maxFiles);
        var meter = OVUpload.progress(progressRoot, { onRetry: function () { document.getElementById('process-btn')?.click(); } });
        function warn(message) { error.textContent = message; error.hidden = false; }
        var picker = OVUpload.picker(root, {
            label: root.dataset.label, accept: input.accept, multiple: input.multiple,
            onFile: function (file, row) {
                var accepted = input.accept.split(',').some(function (part) {
                    part = part.trim().toLowerCase();
                    return part === file.type.toLowerCase() || (part.endsWith('/*') && file.type.toLowerCase().startsWith(part.slice(0, -1))) || (part.startsWith('.') && file.name.toLowerCase().endsWith(part));
                });
                if (!accepted || (input.multiple && files.length >= maxFiles) || file.size > maxBytes) {
                    row.dispatchEvent(new Event('remove')); row.remove();
                    warn(!accepted ? 'Choose a supported file format for this tool.' : files.length >= maxFiles ? 'Choose at most ' + maxFiles + ' files.' : file.name + ' is over ' + size(maxBytes) + '.');
                    return;
                }
                if (!input.multiple) {
                    files = [];
                    picker.rows.querySelectorAll('.ov-upload__row').forEach(function (old) {
                        if (old !== row) { old.dispatchEvent(new Event('remove')); old.remove(); }
                    });
                }
                error.hidden = true;
                files.push(file);
                onFiles(files.slice());
                meter.update({ state: 'waiting', done: 0, total: files.reduce(function (sum, f) { return sum + f.size; }, 0) });
            },
            onRemove: function (file) {
                files = files.filter(function (item) { return item !== file; });
                if (!clearing) onFiles(files.slice());
            }
        });
        function clear() {
            clearing = true;
            files = [];
            picker.rows.querySelectorAll('.ov-upload__row').forEach(function (row) { row.dispatchEvent(new Event('remove')); });
            picker.rows.replaceChildren();
            clearing = false;
            meter.update({ state: 'waiting', done: 0, total: 0 });
        }
        currentUpload = { add: picker.add, clear: clear, start: function () { meter.update({ state: 'sending', done: 0, total: files.reduce(function (sum, f) { return sum + f.size; }, 0) }); },
            progress: function (done, total) { meter.update({ state: 'sending', done: done, total: total }); },
            done: function () { var total = files.reduce(function (sum, f) { return sum + f.size; }, 0); meter.update({ state: 'done', done: total, total: total }); },
            fail: function (message) { meter.update({ state: 'failed', message: message }); } };
        return currentUpload;
    }

    /**
     * A text tool's live output belongs in the frame's answer slot. Only an output that sits directly
     * in the box moves: one inside a two-pane editor (the Markdown preview) keeps its place.
     */
    function moveAnswer() {
        var card = document.querySelector('.ovk-tool-card');
        var out = document.querySelector('.ovk-tool-out');
        if (!card || !out) return;
        var live = card.querySelector('#output, #result, #results, #grid');
        // A two-pane editor (the Markdown preview) keeps its place: moving it would break the grid.
        if (live && !live.closest('.md-pane, .md-editor, .pane')) {
            out.appendChild(live);
            out.classList.add('ovk-tool-out--live');
        }
    }

    /**
     * The navbar sits over the page, so the frame starts under it: its height is measured and put in
     * --ovk-nav-h, which the app's own stylesheet uses for the frame's top padding.
     */
    function underNavbar() {
        var nav = document.querySelector('.openvibe-navbar');
        if (!nav) return;
        var h = Math.round(nav.getBoundingClientRect().height);
        if (h > 0) document.documentElement.style.setProperty('--ovk-nav-h', h + 'px');
    }

    function boot() {
        moveAnswer();
        underNavbar();
        if (typeof ResizeObserver === 'function') {
            var nav = document.querySelector('.openvibe-navbar');
            if (nav) new ResizeObserver(underNavbar).observe(nav);
        }
        // The navbar renders after the page: measure again once it is there.
        setTimeout(underNavbar, 400);
        setTimeout(underNavbar, 1500);
        window.addEventListener('resize', underNavbar);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();

    window.OVToolFrame = { size: size, fileAnswer: fileAnswer, show: show, sample: sample, upload: upload, moveAnswer: moveAnswer };
})();
