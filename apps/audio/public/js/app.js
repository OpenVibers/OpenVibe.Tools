/* ================================================
   Audio.OpenVibe — Client Application  (public/js/app.js)
   Vanilla JS IIFE — no frameworks, same pattern as openvibe-img
   ================================================ */
(function () {
    'use strict';

    /* ---------- State ---------- */
    let ctx = null;           // from /api/context
    let toolList = [];        // from /api/tools
    let currentTool = null;   // active tool ID
    let uploadedFile = null;  // File object
    let resultId = null;      // retention ID from /api/process

    /* ---------- DOM refs ---------- */
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => [...document.querySelectorAll(sel)];

    const heroIcon    = $('#hero-icon');
    const heroTitle   = $('#hero-title');
    const heroSub     = $('#hero-subtitle');
    const toolTabs    = $('#tool-tabs');
    const uploadZone  = $('#upload-zone');
    const uploadArea  = $('#upload-area');
    const uploadInfo  = $('#upload-info');
    const fileInput   = $('#file-input');
    const browseBtn   = $('#browse-btn');
    const clearBtn    = $('#clear-btn');
    const optionsPanel = $('#options-panel');
    const processBtn  = $('#process-btn');
    const processText = $('#process-text');
    const processing  = $('#processing');
    const resultPanel = $('#result-panel');
    const resultPlayer = $('#result-player');
    const resultInfo  = $('#result-info');
    const downloadBtn = $('#download-btn');
    const anotherBtn  = $('#another-btn');
    const subdomains  = $('#subdomains');
    const subdomainGrid = $('#subdomain-grid');

    /* ---------- Init ---------- */
    async function init() {
        try {
            const [ctxRes, toolsRes] = await Promise.all([
                fetch('/api/context').then(r => r.json()),
                fetch('/api/tools').then(r => r.json())
            ]);
            ctx = ctxRes;
            toolList = toolsRes.tools || [];
        } catch (e) {
            console.error('Failed to load context:', e);
            ctx = { toolId: 'hub', brandName: 'Audio.OpenVibe', seoTitle: 'Audio.OpenVibe', seoDescription: 'Online Audio Tools' };
            toolList = [];
        }

        applyBranding();
        initNavbar();
        initNotifications();
        if (typeof OpenVibeAccountSwitcher !== 'undefined') OpenVibeAccountSwitcher.init({ apiBase: 'https://openvibe.network' });
        initToolTabs();
        initUpload();
        initOptions();
        initSubdomains();
        initResult();

        // Set initial tool
        const FORMAT_DOMAINS = ['mp3','wav','flac','ogg','m4a','aac','opus','wma','aiff','ac3'];
        if (ctx.toolId && ctx.toolId !== 'hub') {
            // Format-specific domains (mp3.openvibe.tools etc.) use the convert tool
            if (FORMAT_DOMAINS.includes(ctx.toolId)) {
                selectTool('convert');
            } else {
                selectTool(ctx.toolId);
            }
        } else {
            selectTool('convert');
        }
    }

    /* ---------- Branding ---------- */
    function applyBranding() {
        document.title = ctx.seoTitle || ctx.brandName || 'Audio.OpenVibe';
        const metaDesc = document.querySelector('meta[name="description"]');
        if (metaDesc && ctx.seoDescription) metaDesc.content = ctx.seoDescription;
        const metaOg = document.querySelector('meta[property="og:title"]');
        if (metaOg) metaOg.content = ctx.seoTitle || ctx.brandName;

        if (ctx.faIcon) heroIcon.innerHTML = `<i class="fa-solid ${ctx.faIcon}"></i>`;
        heroTitle.textContent = ctx.brandName || 'Audio.OpenVibe';
        heroSub.textContent = ctx.seoDescription || 'Online Audio Tools';

        // On a specific tool domain, hide tool tabs and subdomains
        if (ctx.toolId && ctx.toolId !== 'hub') {
            toolTabs.style.display = 'none';
            subdomains.style.display = 'none';
        }
    }

    /* ---------- Navbar (OpenVibe unified bar) ---------- */
    function initNavbar() {
        const token = getCookie('ov_token') || localStorage.getItem('ov_token');
        let user = null;
        if (token) {
            try {
                const payload = JSON.parse(atob(token.split('.')[1]));
                user = payload;
            } catch { /* invalid token */ }
        }

        if (typeof OpenVibeNavbar !== 'undefined') {
            OpenVibeNavbar.init({
                service: 'audio',
                brandName: ctx?.brandName || undefined,
                brandIcon: ctx?.faIcon || undefined,
                token,
                user: ctx?.user || user,
                apiBase: 'https://openvibe.network',
            });
        }
    }

    /* ---------- Notifications (OpenVibe bell + toasts) ---------- */
    function initNotifications() {
        const token = getCookie('ov_token') || localStorage.getItem('ov_token');
        if (typeof OpenVibeNotifications === 'undefined') return;

        OpenVibeNotifications.init({
            token: token || null,
            apiBase: 'https://openvibe.network',
        });

        // Mount bell into navbar if available
        if (typeof OpenVibeNavbar !== 'undefined') {
            const mount = OpenVibeNavbar.getBellMount();
            if (mount) {
                const bell = OpenVibeNotifications.createBell();
                if (bell) mount.appendChild(bell);
            }
        }
    }

    /* ---------- Tool Tabs ---------- */
    function initToolTabs() {
        $$('.tool-tab').forEach(tab => {
            tab.addEventListener('click', () => selectTool(tab.dataset.tool));
        });
    }

    function selectTool(toolId) {
        currentTool = toolId;

        // Update tab active state
        $$('.tool-tab').forEach(t => t.classList.toggle('active', t.dataset.tool === toolId));

        // Show matching option group, hide others
        $$('.option-group').forEach(g => g.style.display = 'none');
        const group = $(`#opt-${toolId}`);
        if (group) group.style.display = '';

        // Update process button text
        const tool = toolList.find(t => t.id === toolId);
        processText.textContent = tool ? `Process — ${tool.label}` : 'Process Audio';

        updateProcessBtn();
    }

    /* ---------- Upload ---------- */
    function initUpload() {
        // Click to browse
        browseBtn.addEventListener('click', () => fileInput.click());
        uploadArea.addEventListener('click', (e) => {
            if (e.target === uploadArea || e.target.closest('.upload-icon') || e.target.closest('.upload-text') || e.target.closest('.upload-hint')) {
                fileInput.click();
            }
        });

        // File selected
        fileInput.addEventListener('change', () => {
            if (fileInput.files[0]) handleFile(fileInput.files[0]);
        });

        // Drag & drop
        uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
        uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
        uploadZone.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadZone.classList.remove('drag-over');
            if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
        });

        // Clear
        clearBtn.addEventListener('click', clearFile);
    }

    function handleFile(file) {
        uploadedFile = file;
        const size = formatSize(file.size);
        const ext = file.name.split('.').pop().toUpperCase();

        const details = $('#file-details');
        details.innerHTML = `
            <div class="file-name">${escHtml(file.name)}</div>
            <div class="file-meta">${ext} — ${size}</div>
        `;

        uploadArea.style.display = 'none';
        uploadInfo.style.display = 'flex';
        optionsPanel.style.display = '';
        resultPanel.style.display = 'none';
        resultId = null;
        updateProcessBtn();
    }

    function clearFile() {
        uploadedFile = null;
        fileInput.value = '';
        uploadArea.style.display = '';
        uploadInfo.style.display = 'none';
        optionsPanel.style.display = 'none';
        updateProcessBtn();
    }

    function updateProcessBtn() {
        processBtn.disabled = !uploadedFile || !currentTool;
    }

    /* ---------- Options ---------- */
    function initOptions() {
        // Bitrate slider (convert)
        const bitrateSlider = $('#bitrate-slider');
        const bitrateVal = $('#bitrate-val');
        if (bitrateSlider) {
            bitrateSlider.addEventListener('input', () => { bitrateVal.textContent = bitrateSlider.value; });
        }

        // Pitch slider
        const pitchSlider = $('#pitch-slider');
        const pitchVal = $('#pitch-val');
        if (pitchSlider) {
            pitchSlider.addEventListener('input', () => {
                const v = parseInt(pitchSlider.value);
                pitchVal.textContent = (v > 0 ? '+' : '') + v;
            });
        }

        // Pitch presets
        $$('#opt-pitch .preset-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                pitchSlider.value = btn.dataset.val;
                pitchSlider.dispatchEvent(new Event('input'));
            });
        });

        // Speed slider
        const speedSlider = $('#speed-slider');
        const speedVal = $('#speed-val');
        if (speedSlider) {
            speedSlider.addEventListener('input', () => { speedVal.textContent = parseFloat(speedSlider.value).toFixed(2); });
        }

        // Speed presets
        $$('#opt-speed .preset-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                speedSlider.value = btn.dataset.val;
                speedSlider.dispatchEvent(new Event('input'));
            });
        });

        // Bass sliders
        const bassSlider = $('#bass-slider');
        const bassVal = $('#bass-val');
        if (bassSlider) {
            bassSlider.addEventListener('input', () => {
                const v = parseInt(bassSlider.value);
                bassVal.textContent = (v > 0 ? '+' : '') + v;
            });
        }
        const bassFreqSlider = $('#bass-freq-slider');
        const bassFreqVal = $('#bass-freq-val');
        if (bassFreqSlider) {
            bassFreqSlider.addEventListener('input', () => { bassFreqVal.textContent = bassFreqSlider.value; });
        }

        // Echo sliders
        const echoDelay = $('#echo-delay');
        const echoDecay = $('#echo-decay');
        const echoRepeats = $('#echo-repeats');
        if (echoDelay) echoDelay.addEventListener('input', () => { $('#echo-delay-val').textContent = echoDelay.value; });
        if (echoDecay) echoDecay.addEventListener('input', () => { $('#echo-decay-val').textContent = parseFloat(echoDecay.value).toFixed(2); });
        if (echoRepeats) echoRepeats.addEventListener('input', () => { $('#echo-repeats-val').textContent = echoRepeats.value; });

        // Reverb mix slider
        const reverbMix = $('#reverb-mix');
        if (reverbMix) reverbMix.addEventListener('input', () => { $('#reverb-mix-val').textContent = reverbMix.value; });

        // Format grid click handlers (convert)
        initGridSelect('#format-grid .format-btn', 'format');
        initGridSelect('#norm-mode-grid .format-btn', 'mode');
        initGridSelect('#eq-grid .format-btn', 'preset');
        initGridSelect('#voice-grid .format-btn', 'preset');
        initGridSelect('#reverb-grid .format-btn', 'preset');
        initGridSelect('#extract-format-grid .format-btn', 'format');
        initGridSelect('#ringtone-device-grid .format-btn', 'device');

        // Context defaults — if domain implies a format, pre-select it
        if (ctx.defaultFormat) {
            const fmtBtn = $(`#format-grid .format-btn[data-format="${ctx.defaultFormat}"]`);
            if (fmtBtn) {
                $$('#format-grid .format-btn').forEach(b => b.classList.remove('active'));
                fmtBtn.classList.add('active');
            }
        }

        // Process button
        processBtn.addEventListener('click', processAudio);
    }

    function initGridSelect(selector, attr) {
        const btns = $$(selector);
        if (!btns.length) return;
        const parent = btns[0].parentElement;
        btns.forEach(btn => {
            btn.addEventListener('click', () => {
                parent.querySelectorAll('.format-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            });
        });
    }

    /* ---------- Process ---------- */
    async function processAudio() {
        if (!uploadedFile || !currentTool) return;

        const formData = new FormData();
        formData.append('file', uploadedFile);
        formData.append('tool', currentTool);

        // Gather tool-specific options
        const opts = gatherOptions();
        for (const [k, v] of Object.entries(opts)) {
            formData.append(k, v);
        }

        // UI state
        optionsPanel.style.display = 'none';
        uploadZone.style.display = 'none';
        resultPanel.style.display = 'none';
        processing.style.display = '';

        try {
            const res = await fetch('/api/process', { method: 'POST', body: formData });
            const data = await res.json();

            if (!res.ok) {
                throw new Error(data.error || `Server error (${res.status})`);
            }

            resultId = data.download.id;
            showResult(data);
        } catch (err) {
            showToast(err.message, 'error');
            resetUI();
        }
    }

    function gatherOptions() {
        const o = {};
        switch (currentTool) {
            case 'convert': {
                const fmt = $('#format-grid .format-btn.active');
                if (fmt) o.format = fmt.dataset.format;
                o.bitrate = $('#bitrate-slider').value;
                break;
            }
            case 'trim':
                o.start = $('#trim-start').value || '0';
                o.end = $('#trim-end').value;
                break;
            case 'pitch':
                o.semitones = $('#pitch-slider').value;
                break;
            case 'speed':
                o.speed = $('#speed-slider').value;
                break;
            case 'reverse':
                break;
            case 'normalize': {
                const mode = $('#norm-mode-grid .format-btn.active');
                if (mode) o.mode = mode.dataset.mode;
                break;
            }
            case 'fade':
                o.fadeIn = $('#fade-in').value || '0';
                o.fadeOut = $('#fade-out').value || '0';
                break;
            case 'bass':
                o.gain = $('#bass-slider').value;
                o.frequency = $('#bass-freq-slider').value;
                break;
            case 'equalizer': {
                const p = $('#eq-grid .format-btn.active');
                if (p) o.preset = p.dataset.preset;
                break;
            }
            case 'voice': {
                const p = $('#voice-grid .format-btn.active');
                if (p) o.preset = p.dataset.preset;
                break;
            }
            case 'echo':
                o.delay = $('#echo-delay').value;
                o.decay = $('#echo-decay').value;
                o.repeats = $('#echo-repeats').value;
                break;
            case 'reverb': {
                const p = $('#reverb-grid .format-btn.active');
                if (p) o.preset = p.dataset.preset;
                o.mix = $('#reverb-mix').value;
                break;
            }
            case 'extract': {
                const fmt = $('#extract-format-grid .format-btn.active');
                if (fmt) o.format = fmt.dataset.format;
                break;
            }
            case 'ringtone': {
                const d = $('#ringtone-device-grid .format-btn.active');
                if (d) o.device = d.dataset.device;
                o.start = $('#ringtone-start').value || '0';
                o.end = $('#ringtone-end').value;
                break;
            }
        }
        return o;
    }

    /* ---------- Result ---------- */
    function initResult() {
        anotherBtn.addEventListener('click', () => {
            clearFile();
            resetUI();
        });
    }

    function showResult(data) {
        processing.style.display = 'none';
        resultPanel.style.display = '';

        const fileId = data.download.id;
        const previewUrl = `/api/preview/${fileId}`;
        const downloadUrl = `/api/download/${fileId}`;
        const outputMime = data.output?.mime || '';

        if (outputMime.startsWith('image/')) {
            // Waveform — returns an image
            resultPlayer.innerHTML = `<img src="${previewUrl}" class="result-waveform" alt="Waveform">`;
        } else {
            // Audio player
            resultPlayer.innerHTML = `<audio controls preload="auto" src="${previewUrl}"></audio>`;
        }

        // Info: filename, output size, savings %
        const parts = [];
        if (data.download.filename) parts.push(data.download.filename);
        if (data.output?.size) parts.push(formatSize(data.output.size));
        if (data.input?.size && data.output?.size) {
            const pct = ((1 - data.output.size / data.input.size) * 100).toFixed(1);
            if (pct > 0) parts.push(`${pct}% smaller`);
        }
        resultInfo.textContent = parts.join(' — ');

        // Download
        downloadBtn.href = downloadUrl;
        if (data.download.filename) downloadBtn.download = data.download.filename;
    }

    function resetUI() {
        processing.style.display = 'none';
        resultPanel.style.display = 'none';
        uploadZone.style.display = '';
        if (uploadedFile) {
            optionsPanel.style.display = '';
        }
    }

    /* ---------- Subdomain Grid ---------- */
    function initSubdomains() {
        if (ctx.toolId && ctx.toolId !== 'hub') {
            subdomains.style.display = 'none';
            return;
        }

        const categories = [
            { label: 'Format Conversion', icon: 'fa-solid fa-arrows-rotate', ids: ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'opus', 'wma', 'aiff', 'ac3'] },
            { label: 'Audio Editing', icon: 'fa-solid fa-scissors', ids: ['trim', 'merge', 'fade', 'loop', 'silence', 'stereo', 'normalize', 'speed', 'reverse'] },
            { label: 'Audio Effects', icon: 'fa-solid fa-wand-magic-sparkles', ids: ['pitch', 'bass', 'equalizer', 'echo', 'reverb', 'chorus', 'distortion', 'compressor', 'bitcrusher', 'voice', 'noise'] },
            { label: 'Extraction & Analysis', icon: 'fa-solid fa-magnifying-glass-chart', ids: ['extract', 'vocal', 'waveform', 'metadata'] },
            { label: 'Specialized', icon: 'fa-solid fa-star', ids: ['ringtone', 'podcast'] },
        ];

        // Build a lookup from tools list
        const toolMap = {};
        toolList.forEach(t => { toolMap[t.id] = t; });

        let html = '';
        for (const cat of categories) {
            html += `<div class="cat-header"><i class="${cat.icon}"></i> ${cat.label}</div>`;
            for (const id of cat.ids) {
                const t = toolMap[id];
                if (!t) continue;
                const host = `${id}.openvibe.tools`;
                html += `
                    <a class="subdomain-card" href="https://${host}">
                        <span class="card-icon"><i class="fa-solid ${t.faIcon || 'fa-music'}"></i></span>
                        <span class="card-info">
                            <span class="card-name">${escHtml(t.label)}</span>
                            <span class="card-desc">${escHtml(t.description)}</span>
                        </span>
                    </a>`;
            }
        }
        subdomainGrid.innerHTML = html;
    }

    /* ---------- Utilities ---------- */
    function getCookie(name) {
        const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
        return match ? decodeURIComponent(match[1]) : null;
    }

    function formatSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1048576).toFixed(1) + ' MB';
    }

    function escHtml(str) {
        const d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
    }

    function showToast(msg, type = '') {
        const el = document.createElement('div');
        el.className = 'toast' + (type ? ` ${type}` : '');
        el.textContent = msg;
        document.body.appendChild(el);
        setTimeout(() => { el.remove(); }, 4500);
    }

    /* ---------- Boot ---------- */
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
