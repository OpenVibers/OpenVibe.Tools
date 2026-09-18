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

        try {
            const res = await fetch('/api/info', {
                method: 'POST',
                headers: getAuthHeaders(),
                body: JSON.stringify({ url }),
            });
            const data = await res.json();

            if (!res.ok) {
                showError(data.error || 'Failed to fetch video info');
                return;
            }

            videoInfo = data;
            renderVideoCard(data);
            selectedQuality = 'best';
            renderFormats();
            show(videoCard);
            show(formatSection);
        } catch (err) {
            showError('Network error — please check your connection');
        } finally {
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
        if (info.uploader) meta.push(`<span><i class="fa-solid fa-user"></i> ${escHtml(info.uploader)}</span>`);
        if (info.view_count) meta.push(`<span><i class="fa-solid fa-eye"></i> ${formatNumber(info.view_count)}</span>`);
        if (info.upload_date) {
            const d = info.upload_date;
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
    async function startDownload() {
        if (!videoInfo) return;

        hideAll();
        show(videoCard);
        show(progressSec);
        progressBar.style.width = '0%';
        progressBar.classList.remove('indeterminate');
        progressStats.textContent = '';
        progressTitle.textContent = 'Starting download...';
        downloadBtn.disabled = true;

        try {
            const res = await fetch('/api/download', {
                method: 'POST',
                headers: getAuthHeaders(),
                body: JSON.stringify({
                    url: urlInput.value.trim(),
                    quality: selectedQuality,
                }),
            });
            const data = await res.json();

            if (!res.ok) {
                showError(data.error || 'Failed to start download');
                downloadBtn.disabled = false;
                return;
            }

            downloadId = data.id;
            subscribeProgress(data.id);
        } catch (err) {
            showError('Network error — please check your connection');
            downloadBtn.disabled = false;
        }
    }

    // --- SSE Progress ---
    function subscribeProgress(id) {
        if (sseSource) { sseSource.close(); sseSource = null; }

        sseSource = new EventSource(`/api/status/${id}/stream`);

        sseSource.addEventListener('progress', (e) => {
            try {
                const d = JSON.parse(e.data);
                updateProgress(d);
            } catch {}
        });

        sseSource.addEventListener('complete', (e) => {
            try {
                const d = JSON.parse(e.data);
                onDownloadComplete(d);
            } catch {}
            closeSse();
        });

        sseSource.addEventListener('error_event', (e) => {
            try {
                const d = JSON.parse(e.data);
                showError(d.error || 'Download failed');
            } catch {
                showError('Download failed unexpectedly');
            }
            closeSse();
            downloadBtn.disabled = false;
        });

        sseSource.onerror = () => {
            // SSE disconnected — fall back to polling
            closeSse();
            pollFallback(id);
        };
    }

    function closeSse() {
        if (sseSource) { sseSource.close(); sseSource = null; }
    }

    function updateProgress(d) {
        progressTitle.textContent = 'Downloading...';

        if (d.progress != null && d.progress >= 0) {
            progressBar.classList.remove('indeterminate');
            progressBar.style.width = d.progress + '%';
        } else {
            progressBar.classList.add('indeterminate');
        }

        const parts = [];
        if (d.progress != null && d.progress >= 0) parts.push(d.progress.toFixed(1) + '%');
        if (d.speed) parts.push(d.speed);
        if (d.eta) parts.push('ETA ' + d.eta);
        if (d.filesize) parts.push(formatSize(d.filesize));
        progressStats.textContent = parts.join(' • ');
    }

    function onDownloadComplete(d) {
        hideAll();
        show(doneSec);

        const parts = [];
        if (d.filename) parts.push(d.filename);
        if (d.filesize) parts.push(formatSize(d.filesize));
        doneInfo.textContent = parts.join(' — ') || 'Your file is ready';

        saveBtn.href = `/api/download/${downloadId}`;
        saveBtn.download = d.filename || '';
        downloadBtn.disabled = false;
    }

    // --- Polling Fallback (if SSE drops) ---
    function pollFallback(id) {
        const interval = setInterval(async () => {
            try {
                const res = await fetch(`/api/status/${id}`, { headers: getAuthHeaders() });
                if (!res.ok) { clearInterval(interval); showError('Download failed'); return; }
                const d = await res.json();

                if (d.status === 'downloading') {
                    updateProgress(d);
                } else if (d.status === 'complete') {
                    clearInterval(interval);
                    onDownloadComplete(d);
                } else if (d.status === 'error') {
                    clearInterval(interval);
                    showError(d.error || 'Download failed');
                    downloadBtn.disabled = false;
                }
            } catch {
                clearInterval(interval);
                showError('Lost connection');
                downloadBtn.disabled = false;
            }
        }, 1000);
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
