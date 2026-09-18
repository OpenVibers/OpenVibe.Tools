/* YT.OpenVibe — download state reducer.
 *
 * One function turns every status message into view state, whether it arrived as a named SSE
 * event (progress / complete / failed), an unnamed SSE message, or a poll of /api/status/:id.
 * The wire format is the same JSON everywhere:
 *   { status: 'downloading'|'done'|'error', phase, progress: 0–100|null, speed, eta, error,
 *     cancelled, title, download: { url, size, ext, filename } }
 * Pure and DOM-free so it runs under `node --test` as well as in the page.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.YTDownloadState = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var POLL_MAX_MS = 10 * 60 * 1000;

    function initial(extra) {
        var s = {
            phase: 'starting',     // starting | downloading | processing | done | error
            progress: null,        // 0–1, or null while unknown (indeterminate bar)
            percent: null,         // 0–100 for display
            speed: '',
            eta: '',
            detail: '',
            title: '',
            file: null,            // { url, size, ext, filename } once done
            error: null,
            cancelled: false,
            terminal: false,
        };
        if (extra) for (var k in extra) s[k] = extra[k];
        return s;
    }

    function clean(v) {
        var t = String(v == null ? '' : v).trim();
        return /^(n\/?a|unknown|none)?$/i.test(t) ? '' : t;
    }

    function detailLine(s) {
        var parts = [];
        if (s.phase === 'processing') return 'Converting…';
        if (s.percent != null) parts.push(s.percent.toFixed(1) + '%');
        if (s.speed) parts.push(s.speed);
        if (s.eta) parts.push('ETA ' + s.eta);
        return parts.join(' · ');
    }

    /**
     * @param {object} state  previous state (from initial() or reduce())
     * @param {object} msg    a status payload, or { status: 'error', error } made up by the client
     * @returns {object} next state — the same object when nothing may change any more
     */
    function reduce(state, msg) {
        if (!state) state = initial();
        if (state.terminal || !msg || typeof msg !== 'object') return state;

        var next = {};
        for (var k in state) next[k] = state[k];
        if (msg.title) next.title = String(msg.title);

        // 'complete' is what the first client waited for and the server never said; accept both.
        var status = msg.status === 'complete' ? 'done' : msg.status;
        if (!status && msg.error) status = 'error';

        if (status === 'done') {
            var d = msg.download || {};
            next.phase = 'done';
            next.progress = 1;
            next.percent = 100;
            next.speed = '';
            next.eta = '';
            next.file = {
                url: d.url || (msg.id ? '/api/download/' + msg.id : ''),
                size: d.size || 0,
                ext: d.ext || '',
                filename: d.filename || '',
            };
            next.terminal = true;
        } else if (status === 'error') {
            next.phase = 'error';
            next.cancelled = !!msg.cancelled;
            next.error = clean(msg.error) || 'Download failed';
            next.speed = '';
            next.eta = '';
            next.terminal = true;
        } else if (status === 'downloading') {
            var p = typeof msg.progress === 'number' && isFinite(msg.progress) ? Math.max(0, Math.min(100, msg.progress)) : null;
            // Never run backwards, and never drop back to "unknown" once a figure was shown.
            if (p != null && (next.percent == null || p > next.percent)) next.percent = p;
            next.progress = next.percent == null ? null : next.percent / 100;
            next.speed = clean(msg.speed);
            next.eta = clean(msg.eta);
            if (msg.phase === 'processing') next.phase = 'processing';
            else if (next.percent != null && next.percent > 0) next.phase = next.phase === 'processing' ? 'processing' : 'downloading';
            else if (next.phase !== 'processing') next.phase = msg.phase === 'downloading' ? 'downloading' : 'starting';
            // Converting has no percentage of its own: the bar goes indeterminate again.
            if (next.phase === 'processing') next.progress = null;
        } else {
            return state;
        }

        next.detail = detailLine(next);
        return next;
    }

    /** Headline for a state. */
    function label(s) {
        switch (s.phase) {
            case 'starting': return 'Starting download…';
            case 'downloading': return 'Downloading…';
            case 'processing': return 'Converting…';
            case 'done': return 'Ready';
            case 'error': return s.cancelled ? 'Cancelled' : 'Download failed';
            default: return '';
        }
    }

    /** Poll delay: every second for the first ten seconds, easing out to three. null = give up. */
    function pollDelay(elapsedMs) {
        if (elapsedMs >= POLL_MAX_MS) return null;
        if (elapsedMs < 10000) return 1000;
        if (elapsedMs < 20000) return 2000;
        return 3000;
    }

    return { initial: initial, reduce: reduce, label: label, pollDelay: pollDelay, POLL_MAX_MS: POLL_MAX_MS };
});
