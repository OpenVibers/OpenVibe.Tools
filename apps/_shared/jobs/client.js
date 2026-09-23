/* OpenVibe Tools — browser helper for /api/v1/jobs (served at /js/ov-jobs.js by every satellite that runs jobs).
 *
 *   const job = await OVJobs.submit({ type: 'img.process', input: { tool: 'convert', format: 'webp' }, files: [file] });
 *   OVJobs.remember(job.id);                         // ?job=<id> in the address + sessionStorage: a reload reattaches
 *   OVJobs.watch(job.id, { onUpdate(job) {…}, onDone(job) {…} });
 *   const pending = OVJobs.recall();                 // on load: the job to reattach to, if any
 *   const next = await OVJobs.retry(failed.id);      // a failed job, again, as a new job (idempotent)
 *
 * Progress arrives over SSE (EventSource resumes with Last-Event-ID by itself); if the stream cannot be
 * kept open the helper polls GET /api/v1/jobs/:id instead. Errors are problem+json; submit() throws an
 * Error whose message is the problem's detail.
 */
(function () {
    'use strict';
    var TERMINAL = { succeeded: 1, failed: 1, cancelled: 1 };
    var EVENTS = ['job.queued', 'job.running', 'job.progress', 'job.cancel_requested', 'job.succeeded', 'job.failed', 'job.cancelled'];
    var KEY = 'ov-job:' + location.host + location.pathname;

    function newKey() {
        if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
        return String(Date.now()) + '-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    }
    function problemError(res, body) {
        var err = new Error((body && (body.detail || body.error || body.title)) || ('Server error (' + res.status + ')'));
        err.status = res.status; err.problem = body || null;
        return err;
    }
    function readJson(res) { return res.json().catch(function () { return null; }); }

    function submit(o) {
        var fd = new FormData();
        fd.append('type', o.type);
        fd.append('input', JSON.stringify(o.input || {}));
        var files = o.files || [];
        var field = o.fileField || (files.length > 1 ? 'files' : 'file');
        for (var i = 0; i < files.length; i++) fd.append(field, files[i]);
        return fetch('/api/v1/jobs', {
            method: 'POST', body: fd, credentials: 'same-origin',
            headers: { 'Idempotency-Key': o.idempotencyKey || newKey(), Accept: 'application/json' },
        }).then(function (res) {
            return readJson(res).then(function (body) { if (!res.ok) throw problemError(res, body); return body; });
        });
    }

    function get(id) {
        return fetch('/api/v1/jobs/' + encodeURIComponent(id), { credentials: 'same-origin', headers: { Accept: 'application/json' } })
            .then(function (res) { return readJson(res).then(function (body) { if (!res.ok) throw problemError(res, body); return body; }); });
    }

    function cancel(id) {
        return fetch('/api/v1/jobs/' + encodeURIComponent(id), { method: 'DELETE', credentials: 'same-origin', headers: { Accept: 'application/json' } })
            .then(function (res) { return readJson(res).then(function (body) { if (!res.ok) throw problemError(res, body); return body; }); });
    }

    /** Retry a failed job. → the new job (or, if it was already retried, that retry). */
    function retry(id) {
        return fetch('/api/v1/jobs/' + encodeURIComponent(id) + '/retry', { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' } })
            .then(function (res) { return readJson(res).then(function (body) { if (!res.ok) throw problemError(res, body); return body; }); });
    }

    /** Follow a job until it ends. → { close() } */
    function watch(id, h) {
        h = h || {};
        var done = false, es = null, timer = null, failures = 0;
        function finish(job) {
            if (done) return; done = true;
            if (es) es.close();
            if (timer) clearTimeout(timer);
            if (h.onDone) h.onDone(job);
        }
        function update(job) {
            if (done || !job) return;
            if (h.onUpdate) h.onUpdate(job);
            if (TERMINAL[job.state]) finish(job);
        }
        function poll() {
            if (done) return;
            get(id).then(function (job) { failures = 0; update(job); if (!done) timer = setTimeout(poll, 1500); })
                .catch(function (err) {
                    if (err.status === 404) { done = true; if (h.onGone) h.onGone(err); return; }
                    failures++; timer = setTimeout(poll, Math.min(15000, 1500 * failures));
                });
        }
        if (!window.EventSource) { poll(); return { close: function () { done = true; if (timer) clearTimeout(timer); } }; }
        es = new EventSource('/api/v1/jobs/' + encodeURIComponent(id) + '/events', { withCredentials: true });
        EVENTS.forEach(function (name) {
            es.addEventListener(name, function (e) { try { update(JSON.parse(e.data)); } catch (_) { /* ignore a bad frame */ } });
        });
        es.onerror = function () {
            // CLOSED: the server said 204 (nothing new — the job has ended) or refused; ask once, then poll.
            if (!done && es.readyState === 2) { es = null; poll(); }
        };
        return { close: function () { done = true; if (es) es.close(); if (timer) clearTimeout(timer); } };
    }

    function remember(id) {
        try { sessionStorage.setItem(KEY, id); } catch (_) { /* storage may be off */ }
        try { var u = new URL(location.href); u.searchParams.set('job', id); history.replaceState(history.state, '', u.toString()); } catch (_) { /* old browser */ }
    }
    function recall() {
        var fromUrl = null;
        try { fromUrl = new URL(location.href).searchParams.get('job'); } catch (_) { /* old browser */ }
        if (fromUrl && /^job_[0-9A-Z]{26}$/.test(fromUrl)) return fromUrl;
        try { var s = sessionStorage.getItem(KEY); if (s && /^job_[0-9A-Z]{26}$/.test(s)) return s; } catch (_) { /* storage may be off */ }
        return null;
    }
    function forget() {
        try { sessionStorage.removeItem(KEY); } catch (_) { /* storage may be off */ }
        try { var u = new URL(location.href); if (u.searchParams.has('job')) { u.searchParams.delete('job'); history.replaceState(history.state, '', u.toString()); } } catch (_) { /* old browser */ }
    }

    function fileUrl(job, n, opts) {
        var f = job && job.result && job.result.files && job.result.files[n || 0];
        if (!f) return null;
        return f.url + (opts && opts.inline ? '?inline=1' : '');
    }
    /** Milliseconds until a finished job's files expire (null while it is still running, or while something references it). */
    function expiresIn(job) {
        return job && job.expires_at ? Math.max(0, Date.parse(job.expires_at) - Date.now()) : null;
    }

    window.OVJobs = { submit: submit, get: get, cancel: cancel, retry: retry, watch: watch, remember: remember, recall: recall, forget: forget, fileUrl: fileUrl, expiresIn: expiresIn, TERMINAL: TERMINAL };
})();
