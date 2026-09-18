/* YT.OpenVibe — Client Application */
(function () {
    'use strict';

    // --- State ---
    let videoInfo = null;
    let selectedQuality = 'best';
    let downloadId = null;
    let sseSource = null;

    // --- DOM Refs ---
    const $ = (sel) => document.querySelector(sel);
    const urlInput      = $('#url-input');
    const fetchBtn      = $('#fetch-btn');
    const loading       = $('#loading');
    const videoCard     = $('#video-card');
    const videoThumb    = $('#video-thumb');
    const videoInfoEl   = $('#video-info');
    const formatSection = $('#format-section');
    const videoFormats  = $('#video-formats');
    const audioFormats  = $('#audio-formats');
    const downloadBtn   = $('#download-btn');
    const progressSec   = $('#progress-section');
    const progressTitle = $('#progress-title');
    const progressBar   = $('#progress-bar');
    const progressStats = $('#progress-stats');
    const doneSec       = $('#done-section');
    const doneInfo      = $('#done-info');
    const saveBtn       = $('#save-btn');
    const newBtn        = $('#new-btn');
    const errorSec      = $('#error-section');
    const errorMsg      = $('#error-msg');
    const retryBtn      = $('#retry-btn');

    // --- Auth ---
    function getCookie(name) {
        const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)'));
        return m ? decodeURIComponent(m[1]) : null;
    }

    function getAuthHeaders() {
        const h = { 'Content-Type': 'application/json' };
        const token = getCookie('ov_token') || localStorage.getItem('ov_token');
        if (token) h['Authorization'] = `Bearer ${token}`;
        return h;
    }

    // --- Helpers ---
    function show(el) { el.style.display = ''; }
    function hide(el) { el.style.display = 'none'; }

    function hideAll() {
        [loading, videoCard, formatSection, progressSec, doneSec, errorSec].forEach(hide);
    }

    function formatDuration(seconds) {
        if (!seconds || seconds <= 0) return '--:--';
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    function formatSize(bytes) {
        if (!bytes) return '';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
        return (bytes / 1073741824).toFixed(2) + ' GB';
    }

    function formatNumber(n) {
        if (!n) return '0';
        if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
        if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
        return String(n);
    }

    function showError(msg) {
        hideAll();
        errorMsg.textContent = msg;
        show(errorSec);
    }

    // --- Video Format Presets ---
    const VIDEO_QUALITIES = [
        { id: 'best',  label: 'Best Quality',  sub: 'MP4 • Highest' },
        { id: '1080p', label: '1080p',          sub: 'MP4 • Full HD' },
        { id: '720p',  label: '720p',           sub: 'MP4 • HD' },
        { id: '480p',  label: '480p',           sub: 'MP4 • SD' },
        { id: '360p',  label: '360p',           sub: 'MP4 • Low' },
        { id: 'webm',  label: 'WebM',           sub: 'VP9 • Best' },
    ];

    const AUDIO_QUALITIES = [
        { id: 'mp3',  label: 'MP3',  sub: '320kbps' },
        { id: 'm4a',  label: 'M4A',  sub: 'AAC Best' },
        { id: 'opus', label: 'OPUS', sub: 'Best' },
        { id: 'flac', label: 'FLAC', sub: 'Lossless' },
    ];

    // --- Render Formats ---
    function renderFormats() {
        videoFormats.innerHTML = '';
        audioFormats.innerHTML = '';

        VIDEO_QUALITIES.forEach(q => {
            const btn = document.createElement('button');
            btn.className = 'format-btn' + (selectedQuality === q.id ? ' active' : '');
            btn.innerHTML = `${q.label}<span class="format-sub">${q.sub}</span>`;
            btn.addEventListener('click', () => selectFormat(q.id));
            videoFormats.appendChild(btn);
        });

        AUDIO_QUALITIES.forEach(q => {
            const btn = document.createElement('button');
            btn.className = 'format-btn' + (selectedQuality === q.id ? ' active' : '');
            btn.innerHTML = `${q.label}<span class="format-sub">${q.sub}</span>`;
            btn.addEventListener('click', () => selectFormat(q.id));
            audioFormats.appendChild(btn);
        });
    }

    function selectFormat(id) {
        selectedQuality = id;
        renderFormats();
    }

    // --- Fetch Video Info ---
    async function fetchInfo() {
        const url = urlInput.value.trim();
        if (!url) { urlInput.focus(); return; }

        hideAll();
        show(loading);
        fetchBtn.disabled = true;

        // Never spin forever: the server gives yt-dlp 30 s, so anything past 45 s is dead.
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 45000);
        try {
            const res = await fetch('/api/info', {
                method: 'POST',
                headers: getAuthHeaders(),
                body: JSON.stringify({ url }),
                signal: ctrl.signal,
            });
            const data = await res.json().catch(() => ({}));

            if (!res.ok) {
                showError(data.error || `Could not fetch video info (${res.status})`);
                return;
            }

            // The API answers { success, video: {...} }; the card used to be fed the envelope,
            // which is why it showed "Untitled" with no thumbnail while the spinner stayed on.
            const info = data.video || data;
            if (!info || !info.id) { showError('No video found at that link'); return; }
            videoInfo = info;
            renderVideoCard(info);
            selectedQuality = 'best';
            renderFormats();
            hideAll();
            show(videoCard);
            show(formatSection);
        } catch (err) {
            showError(err && err.name === 'AbortError' ? 'YouTube took too long to answer — try again in a moment' : 'Network error — please check your connection');
        } finally {
            clearTimeout(timer);
            fetchBtn.disabled = false;
        }
    }

    // --- Render Video Card ---
    function renderVideoCard(info) {
        videoThumb.innerHTML = `
            <img src="${info.thumbnail || ''}" alt="" loading="lazy">
            <span class="duration-badge">${formatDuration(info.duration)}</span>
        `;

        const meta = [];
        const views = info.viewCount ?? info.view_count;
        const uploaded = info.uploadDate || info.upload_date;
        if (info.uploader) meta.push(`<span><i class="fa-solid fa-user"></i> ${escHtml(info.uploader)}</span>`);
        if (views) meta.push(`<span><i class="fa-solid fa-eye"></i> ${formatNumber(views)}</span>`);
        if (uploaded && String(uploaded).length === 8) {
            const d = String(uploaded);
            const formatted = `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`;
            meta.push(`<span><i class="fa-solid fa-calendar"></i> ${formatted}</span>`);
        }

        videoInfoEl.innerHTML = `
            <h2>${escHtml(info.title || 'Untitled')}</h2>
            <div class="video-meta">${meta.join('')}</div>
        `;
    }

    function escHtml(s) {
        const d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
    }

    // --- Start Download ---
    // One reducer (download-state.js) turns SSE frames and polls into view state; render() paints it
    // on the page and mirrors it into the navbar activity island when that module is present.
    const DS = window.YTDownloadState;
    let dlState = null, pollTimer = null, watchdog = null, tracking = null;
    const island = () => window.OpenVibeIsland || null;

    async function startDownload() {
        if (!videoInfo) return;
        hideAll(); show(videoCard); show(progressSec);
        downloadBtn.disabled = true;
        stopTracking();
        dlState = DS.initial({ title: videoInfo.title || '' });
        render();

        try {
            const res = await fetch('/api/download', {
                method: 'POST', headers: getAuthHeaders(),
                body: JSON.stringify({ url: urlInput.value.trim(), quality: selectedQuality, title: videoInfo.title || '' }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.id) { fail(data.error || 'Failed to start download'); return; }
            downloadId = data.id;
            const isl = island();
            if (isl) isl.start({ id: 'yt-' + data.id, title: 'Starting download', subtitle: videoInfo.title || '', icon: 'youtube', image: videoInfo.thumbnail || '', progress: null, state: 'busy',
                actions: [{ label: 'Cancel', onClick: () => cancelDownload(data.id) }] });
            subscribeProgress(data.id);
        } catch (err) {
            fail('Network error. Please check your connection.');
        }
    }

    function fail(msg) { apply({ status: 'error', error: msg }); }

    function apply(msg) {
        if (!dlState) return;
        const before = dlState;
        dlState = DS.reduce(dlState, msg);
        if (dlState !== before) render();
        if (dlState.terminal) stopTracking();
    }

    function subscribeProgress(id) {
        tracking = id;
        const startedAt = Date.now();
        let gotFrame = false;
        const onFrame = (e) => { if (tracking !== id) return; gotFrame = true; try { apply(Object.assign({ id }, JSON.parse(e.data))); } catch { /* */ } };
        if (window.EventSource) {
            sseSource = new EventSource(`/api/status/${id}/stream`);
            // Named events carry the same JSON as the unnamed message; the reducer is idempotent.
            sseSource.onmessage = onFrame;
            ['progress', 'complete', 'failed'].forEach((n) => sseSource.addEventListener(n, onFrame));
            sseSource.onerror = () => { if (tracking === id && !(dlState && dlState.terminal)) { closeSse(); poll(id, startedAt); } };
            // A proxy that buffers the stream would leave us silent: start polling after 4 s without a frame.
            watchdog = setTimeout(() => { if (!gotFrame && tracking === id) { closeSse(); poll(id, startedAt); } }, 4000);
        } else {
            poll(id, startedAt);
        }
    }

    function poll(id, startedAt) {
        if (tracking !== id || pollTimer) return;
        const step = async () => {
            pollTimer = null;
            if (tracking !== id) return;
            try {
                const res = await fetch(`/api/status/${id}`, { headers: getAuthHeaders(), cache: 'no-store' });
                if (res.status === 404) return fail('Download not found or expired');
                if (res.ok) apply(Object.assign({ id }, await res.json()));
            } catch { /* transient: keep trying until the deadline */ }
            if (tracking !== id) return;
            const delay = DS.pollDelay(Date.now() - startedAt);
            if (delay == null) return fail('The download took too long. Please try again.');
            pollTimer = setTimeout(step, delay);
        };
        step();
    }

    function closeSse() { if (sseSource) { sseSource.close(); sseSource = null; } }
    function stopTracking() { tracking = null; closeSse(); clearTimeout(pollTimer); pollTimer = null; clearTimeout(watchdog); watchdog = null; }

    async function cancelDownload(id) {
        try { await fetch(`/api/download/${id}`, { method: 'DELETE', headers: getAuthHeaders() }); } catch { /* */ }
        if (tracking === id) apply({ status: 'error', error: 'Cancelled', cancelled: true });
    }

    function render() {
        const s = dlState; if (!s) return;
        const isl = island(); const iid = downloadId ? 'yt-' + downloadId : null;
        if (s.phase === 'done') {
            hideAll(); show(doneSec);
            const parts = [];
            if (s.file.filename) parts.push(s.file.filename);
            if (s.file.size) parts.push(formatSize(s.file.size));
            doneInfo.textContent = parts.join(' · ') || 'Your file is ready';
            saveBtn.href = s.file.url || `/api/download/${downloadId}`;
            saveBtn.download = s.file.filename || '';
            downloadBtn.disabled = false;
            if (isl && iid) isl.finish(iid, { state: 'ok', title: 'Ready', subtitle: s.title, detail: parts.join(' · '), actions: [{ label: 'Save file', href: saveBtn.href, download: true }], ttl: 15000 });
            return;
        }
        if (s.phase === 'error') {
            downloadBtn.disabled = false;
            if (s.cancelled) { hideAll(); show(videoCard); } else showError(s.error);
            if (isl && iid) { if (s.cancelled) isl.finish(iid, { state: 'info', title: 'Cancelled', ttl: 2500 }); else isl.fail(iid, { title: 'Download failed', detail: s.error }); }
            return;
        }
        progressTitle.textContent = DS.label(s);
        if (s.progress == null) { progressBar.classList.add('indeterminate'); progressBar.style.width = ''; }
        else { progressBar.classList.remove('indeterminate'); progressBar.style.width = (s.progress * 100).toFixed(1) + '%'; }
        progressStats.textContent = s.detail;
        if (isl && iid) isl.update(iid, { title: DS.label(s).replace('…', ''), progress: s.progress, detail: s.detail });
    }

    // --- Reset ---
    function reset() {
        hideAll();
        videoInfo = null;
        downloadId = null;
        selectedQuality = 'best';
        urlInput.value = '';
        urlInput.focus();
        closeSse();
        downloadBtn.disabled = false;
    }

    // --- Event Listeners ---
    fetchBtn.addEventListener('click', fetchInfo);
    urlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') fetchInfo();
    });
    // Auto-detect paste
    urlInput.addEventListener('paste', () => {
        setTimeout(() => {
            const v = urlInput.value.trim();
            if (v && (v.includes('youtube.com') || v.includes('youtu.be'))) {
                fetchInfo();
            }
        }, 50);
    });
    downloadBtn.addEventListener('click', startDownload);
    newBtn.addEventListener('click', reset);
    retryBtn.addEventListener('click', reset);

    // --- Init ---
    function initNavbar() {
        const token = getCookie('ov_token') || localStorage.getItem('ov_token');
        let user = null;
        if (token) {
            try { user = JSON.parse(atob(token.split('.')[1])); } catch {}
        }
        if (typeof OpenVibeNavbar !== 'undefined') {
            OpenVibeNavbar.init({
                service: 'yt',
                token, user,
                apiBase: 'https://openvibe.network',
                history: { type: 'tool', title: 'YT.OpenVibe' },
                silentLogin: 'https://openvibe.tools/auth/login?silent=1&next={url}',
            });
        }
        if (typeof OpenVibeFooter !== 'undefined') {
            try {
                OpenVibeFooter.init({
                    service: 'yt', variant: 'compact', mount: '#ov-footer', apiBase: 'https://openvibe.network',
                    links: [{ heading: 'YT.OpenVibe', items: [
                        { name: 'Video downloader', url: 'https://yt.openvibe.tools' },
                        { name: 'Audio converter', url: 'https://audio.openvibe.tools' },
                        { name: 'All tools', url: 'https://openvibe.tools' },
                    ] }],
                });
            } catch { /* optional */ }
        }
        if (typeof OpenVibeAccountSwitcher !== 'undefined') {
            OpenVibeAccountSwitcher.init({ apiBase: 'https://openvibe.network' });
        }
    }

    function initNotifications() {
        const token = getCookie('ov_token') || localStorage.getItem('ov_token');
        if (typeof OpenVibeNotifications === 'undefined') return;
        if (!token) return;
        OpenVibeNotifications.init({
            token,
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

    function init() {
        initNavbar();
        initNotifications();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
