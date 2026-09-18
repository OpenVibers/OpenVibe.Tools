// ═══════════════════════════════════════════════════════════════
// Img.OpenVibe — Client Application
// Domain-aware image processing SPA.
// Detects hostname → fetches context → adapts branding + tools.
// ═══════════════════════════════════════════════════════════════

(function () {
    'use strict';

    // ── State ────────────────────────────────────────────────
    let ctx = null;           // domain context from /api/context
    let selectedFile = null;  // File object
    let selectedTool = 'convert';
    let selectedFormat = 'png';
    let selectedAspect = '';

    // ── DOM refs ─────────────────────────────────────────────
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    const heroIcon = $('#hero-icon');
    const heroTitle = $('#hero-title');
    const heroSubtitle = $('#hero-subtitle');
    const toolTabs = $('#tool-tabs');
    const uploadArea = $('#upload-area');
    const uploadInfo = $('#upload-info');
    const fileInput = $('#file-input');
    const browseBtn = $('#browse-btn');
    const clearBtn = $('#clear-btn');
    const optionsPanel = $('#options-panel');
    const processBtn = $('#process-btn');
    const processText = $('#process-text');
    const processingEl = $('#processing');
    const resultPanel = $('#result-panel');
    const resultPreview = $('#result-preview');
    const resultInfo = $('#result-info');
    const downloadBtn = $('#download-btn');
    const anotherBtn = $('#another-btn');
    const subdomainsSection = $('#subdomains');
    const subdomainGrid = $('#subdomain-grid');

    // Option elements
    const qualitySlider = $('#quality-slider');
    const qualityVal = $('#quality-val');
    const compressSlider = $('#compress-slider');
    const compressVal = $('#compress-val');

    // ── Init ─────────────────────────────────────────────────
    async function init() {
        // Fetch domain context
        try {
            const res = await fetch('/api/context');
            ctx = await res.json();
        } catch {
            ctx = { toolId: 'hub', brandName: 'Img.OpenVibe', defaultOp: 'convert', faIcon: 'fa-images', tools: [] };
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
    }

    // ── Branding ─────────────────────────────────────────────
    function applyBranding() {
        document.title = ctx.seoTitle || `${ctx.brandName} — Image Tools`;
        heroIcon.innerHTML = `<i class="fa-solid ${ctx.faIcon || 'fa-images'}"></i>`;
        heroTitle.textContent = ctx.brandName || 'Img.OpenVibe';

        // Set subtitle based on tool
        const subtitles = {
            hub: 'Online Image Converter & Tools',
            convert: 'Online Image Format Converter',
            compress: 'Online Image Compressor',
            resize: 'Online Image Resizer',
            crop: 'Online Image Cropper',
            favicon: 'Online Favicon Generator',
        };
        heroSubtitle.textContent = subtitles[ctx.toolId] || ctx.seoDescription || subtitles.hub;

        // If format-specific domain, set default format
        if (ctx.defaultFormat) {
            selectedFormat = ctx.defaultFormat;
        }

        // Set default tool from context
        selectedTool = ctx.defaultOp || 'convert';

        // Hide tool tabs on single-tool domains (format-specific ones show convert)
        const isFormatDomain = ctx.toolId && !['hub', 'convert', 'compress', 'resize', 'crop', 'favicon'].includes(ctx.toolId);
        if (isFormatDomain) {
            toolTabs.style.display = 'none';
            selectedTool = 'convert';
        }

        // Hide subdomains section on non-hub domains
        if (ctx.toolId !== 'hub') {
            subdomainsSection.style.display = 'none';
        }

        // Update meta description
        const metaDesc = document.querySelector('meta[name="description"]');
        if (metaDesc && ctx.seoDescription) metaDesc.content = ctx.seoDescription;
    }

    // ── Navbar ───────────────────────────────────────────────
    function initNavbar() {
        const token = getCookie('ov_token') || localStorage.getItem('ov_token');
        let user = null;
        if (token) {
            try {
                const payload = JSON.parse(atob(token.split('.')[1]));
                user = payload;
            } catch { /* invalid token */ }
        }

        // Brand name/icon come from the hostname now (png.openvibe.tools → "PNG.OpenVibe.Tools").
        if (typeof OpenVibeNavbar !== 'undefined') {
            OpenVibeNavbar.init({
                service: 'img',
                token,
                user: ctx?.user || user,
                apiBase: 'https://openvibe.network',
                history: { type: 'tool', title: ctx?.brandName || 'Img.OpenVibe' },
                silentLogin: 'https://openvibe.tools/auth/login?silent=1&next={url}',
            });
        }
        initFooter();
    }

    /* ---------- Footer (shared OpenVibeFooter) ---------- */
    // Full footer on the hub host, the compact strip on the single-tool hosts.
    function initFooter() {
        if (typeof OpenVibeFooter === 'undefined') return;
        try {
            OpenVibeFooter.init({
                service: 'img',
                variant: (!ctx || ctx.toolId === 'hub') ? 'full' : 'compact',
                mount: '#ov-footer',
                apiBase: 'https://openvibe.network',
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

        // Mount bell into navbar if available
        if (typeof OpenVibeNavbar !== 'undefined') {
            const mount = OpenVibeNavbar.getBellMount();
            if (mount) {
                const bell = OpenVibeNotifications.createBell();
                if (bell) mount.appendChild(bell);
            }
        }
    }

    // ── Tool Tabs ────────────────────────────────────────────
    function initToolTabs() {
        // Highlight active tab
        $$('.tool-tab').forEach(tab => {
            if (tab.dataset.tool === selectedTool) tab.classList.add('active');
            else tab.classList.remove('active');

            tab.addEventListener('click', () => {
                selectedTool = tab.dataset.tool;
                $$('.tool-tab').forEach(t => t.classList.toggle('active', t.dataset.tool === selectedTool));
                showToolOptions();
                updateProcessButton();
            });
        });
    }

    // ── Upload ───────────────────────────────────────────────
    function initUpload() {
        // Drag & drop
        uploadArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadArea.classList.add('dragover');
        });
        uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
        uploadArea.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadArea.classList.remove('dragover');
            if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
        });

        // Click to browse
        uploadArea.addEventListener('click', () => fileInput.click());
        browseBtn.addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
        fileInput.addEventListener('change', () => {
            if (fileInput.files.length) handleFile(fileInput.files[0]);
        });

        // Clear
        clearBtn.addEventListener('click', resetUpload);
    }

    function handleFile(file) {
        if (!file.type.startsWith('image/') && file.type !== 'image/svg+xml') {
            alert('Please select an image file.');
            return;
        }
        if (file.size > 50 * 1024 * 1024) {
            alert('File too large. Maximum 50MB.');
            return;
        }

        selectedFile = file;
        uploadArea.style.display = 'none';
        uploadInfo.style.display = 'flex';

        // Preview
        const preview = $('#file-preview');
        const details = $('#file-details');
        const objectUrl = URL.createObjectURL(file);
        preview.innerHTML = `<img src="${objectUrl}" alt="Preview">`;
        details.innerHTML = `
            <div class="fname">${escapeHtml(file.name)}</div>
            <div class="fmeta">${file.type} &bull; ${formatBytes(file.size)}</div>
        `;

        optionsPanel.style.display = '';
        showToolOptions();
        updateProcessButton();
    }

    function resetUpload() {
        selectedFile = null;
        fileInput.value = '';
        uploadArea.style.display = '';
        uploadInfo.style.display = 'none';
        optionsPanel.style.display = 'none';
        resultPanel.style.display = 'none';
        processingEl.style.display = 'none';
        processBtn.disabled = true;
    }

    // ── Options ──────────────────────────────────────────────
    function initOptions() {
        // Quality slider
        qualitySlider.addEventListener('input', () => { qualityVal.textContent = qualitySlider.value; });
        compressSlider.addEventListener('input', () => { compressVal.textContent = compressSlider.value; });

        // Format buttons
        $$('.format-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                selectedFormat = btn.dataset.format;
                $$('.format-btn').forEach(b => b.classList.toggle('active', b.dataset.format === selectedFormat));
            });
        });

        // Aspect ratio buttons
        $$('.aspect-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                selectedAspect = btn.dataset.aspect;
                $$('.aspect-btn').forEach(b => b.classList.toggle('active', b.dataset.aspect === selectedAspect));
                // Show/hide custom coords
                $('#crop-coords').style.display = selectedAspect ? 'none' : 'grid';
            });
        });

        // Process button
        processBtn.addEventListener('click', processImage);
    }

    function showToolOptions() {
        // Hide all option groups
        ['opt-convert', 'opt-compress', 'opt-resize', 'opt-crop'].forEach(id => {
            const el = $(`#${id}`);
            if (el) el.style.display = 'none';
        });

        // Show active tool options
        const optEl = $(`#opt-${selectedTool}`);
        if (optEl) optEl.style.display = '';

        // Pre-select format if domain-specific
        if (ctx.defaultFormat) {
            selectedFormat = ctx.defaultFormat;
            $$('.format-btn').forEach(b => b.classList.toggle('active', b.dataset.format === selectedFormat));
        }
    }

    function updateProcessButton() {
        processBtn.disabled = !selectedFile;
        const labels = { convert: 'Convert Image', compress: 'Compress Image', resize: 'Resize Image', crop: 'Crop Image' };
        processText.textContent = labels[selectedTool] || 'Process Image';
    }

    // ── Process ──────────────────────────────────────────────
    async function processImage() {
        if (!selectedFile) return;

        // Show processing state
        optionsPanel.style.display = 'none';
        resultPanel.style.display = 'none';
        processingEl.style.display = '';
        processBtn.disabled = true;

        const formData = new FormData();
        formData.append('file', selectedFile);
        formData.append('tool', selectedTool);

        // Add tool-specific options
        if (selectedTool === 'convert') {
            formData.append('format', selectedFormat);
            formData.append('quality', qualitySlider.value);
        } else if (selectedTool === 'compress') {
            formData.append('quality', compressSlider.value);
        } else if (selectedTool === 'resize') {
            const w = $('#resize-w').value;
            const h = $('#resize-h').value;
            const pct = $('#resize-pct').value;
            const fit = $('#resize-fit').value;
            if (pct) formData.append('percentage', pct);
            else {
                if (w) formData.append('width', w);
                if (h) formData.append('height', h);
            }
            formData.append('fit', fit);
        } else if (selectedTool === 'crop') {
            if (selectedAspect) {
                formData.append('aspect', selectedAspect);
            } else {
                const l = $('#crop-left').value;
                const t = $('#crop-top').value;
                const w = $('#crop-w').value;
                const h = $('#crop-h').value;
                if (l) formData.append('left', l);
                if (t) formData.append('top', t);
                if (w) formData.append('width', w);
                if (h) formData.append('height', h);
            }
        }

        try {
            const token = getCookie('ov_token') || localStorage.getItem('ov_token');
            const headers = {};
            if (token) headers['Authorization'] = `Bearer ${token}`;

            const res = await fetch('/api/process', { method: 'POST', body: formData, headers });

            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: 'Processing failed' }));
                throw new Error(err.error || `Server error: ${res.status}`);
            }

            const data = await res.json();
            showResult(data);
        } catch (err) {
            processingEl.style.display = 'none';
            optionsPanel.style.display = '';
            processBtn.disabled = false;
            alert(`Error: ${err.message}`);
        }
    }

    // ── Result ───────────────────────────────────────────────
    function initResult() {
        anotherBtn.addEventListener('click', () => {
            resetUpload();
            toolTabs.scrollIntoView({ behavior: 'smooth' });
        });
    }

    function showResult(data) {
        processingEl.style.display = 'none';
        resultPanel.style.display = '';

        // Preview image (if it's a previewable type)
        const previewable = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/avif'];
        if (previewable.includes(data.output.mime)) {
            resultPreview.innerHTML = `<img src="${data.download.downloadUrl}" alt="Result">`;
        } else {
            resultPreview.innerHTML = `<div style="font-size:48px;color:var(--accent);padding:24px"><i class="fa-solid fa-file-image"></i></div>`;
        }

        // Info
        let infoHtml = `<p>Format: <strong>${data.output.ext.toUpperCase()}</strong> &bull; Size: <strong>${data.output.sizeKB} KB</strong></p>`;
        if (data.savings) {
            const pct = data.savings.savedPercent;
            if (pct > 0) {
                infoHtml += `<p class="savings">Saved ${pct}% (${formatBytes(data.savings.savedBytes)} smaller)</p>`;
            } else {
                infoHtml += `<p>File size unchanged or slightly larger — try a lower quality.</p>`;
            }
        }
        if (data.dimensions) {
            infoHtml += `<p>${data.dimensions.original.width}x${data.dimensions.original.height} → ${data.dimensions.resized.width}x${data.dimensions.resized.height}</p>`;
        }
        if (data.crop) {
            infoHtml += `<p>Cropped to ${data.crop.width}x${data.crop.height}</p>`;
        }

        const expires = data.download.expiresIn;
        const expiresStr = expires >= 3600000 ? `${Math.round(expires / 3600000)}h` : `${Math.round(expires / 60000)}m`;
        infoHtml += `<p style="color:var(--text-muted);font-size:12px;margin-top:8px">Download expires in ${expiresStr}</p>`;

        resultInfo.innerHTML = infoHtml;

        // Download link
        downloadBtn.href = data.download.downloadUrl;
        downloadBtn.download = '';

        resultPanel.scrollIntoView({ behavior: 'smooth' });
    }

    // ── Subdomains Grid ──────────────────────────────────────
    function initSubdomains() {
        const tools = [
            { host: 'png.openvibe.tools',      name: 'OpenVibePNG',      icon: 'fa-file-image', desc: 'Convert to PNG' },
            { host: 'jpg.openvibe.tools',      name: 'OpenVibeJPG',      icon: 'fa-file-image', desc: 'Convert to JPG' },
            { host: 'webp.openvibe.tools',     name: 'OpenVibeWebP',     icon: 'fa-file-image', desc: 'Convert to WebP' },
            { host: 'avif.openvibe.tools',     name: 'OpenVibeAVIF',     icon: 'fa-file-image', desc: 'Convert to AVIF' },
            { host: 'heic.openvibe.tools',     name: 'OpenVibeHEIC',     icon: 'fa-file-image', desc: 'HEIC Converter' },
            { host: 'svg.openvibe.tools',      name: 'OpenVibeSVG',      icon: 'fa-bezier-curve', desc: 'SVG Converter' },
            { host: 'gif.openvibe.tools',      name: 'OpenVibeGIF',      icon: 'fa-film', desc: 'GIF Converter' },
            { host: 'ico.openvibe.tools',      name: 'OpenVibeICO',      icon: 'fa-icons', desc: 'ICO Favicon Maker' },
            { host: 'tiff.openvibe.tools',     name: 'OpenVibeTIFF',     icon: 'fa-file-image', desc: 'Convert to TIFF' },
            { host: 'bmp.openvibe.tools',      name: 'OpenVibeBMP',      icon: 'fa-file-image', desc: 'Convert to BMP' },
            { host: 'compress.openvibe.tools', name: 'OpenVibeCompress',  icon: 'fa-compress', desc: 'Compress Images' },
            { host: 'resize.openvibe.tools',   name: 'OpenVibeResize',    icon: 'fa-up-right-and-down-left-from-center', desc: 'Resize Images' },
            { host: 'crop.openvibe.tools',     name: 'OpenVibeCrop',      icon: 'fa-crop-simple', desc: 'Crop Images' },
            { host: 'convert.openvibe.tools',  name: 'OpenVibeConvert',   icon: 'fa-arrows-rotate', desc: 'Format Converter' },
            { host: 'favicon.openvibe.tools',  name: 'OpenVibeFavicon',   icon: 'fa-icons', desc: 'Favicon Generator' },
        ];

        subdomainGrid.innerHTML = tools.map(t => `
            <a class="subdomain-card" href="https://${t.host}">
                <span class="sd-icon"><i class="fa-solid ${t.icon}"></i></span>
                <span class="sd-info">
                    <span class="sd-name">${t.name}</span>
                    <span class="sd-desc">${t.desc}</span>
                </span>
            </a>
        `).join('');
    }

    // ── Helpers ──────────────────────────────────────────────
    function getCookie(name) {
        const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
        return match ? decodeURIComponent(match[1]) : null;
    }

    function formatBytes(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
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
