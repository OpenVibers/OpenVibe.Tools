// ═══════════════════════════════════════════════════════════════
// Docs.OpenVibe — Client Application
// Domain-aware document processing SPA.
// Detects hostname → fetches context → adapts branding + tools.
// ═══════════════════════════════════════════════════════════════

(function () {
    'use strict';

    // ── State ────────────────────────────────────────────────
    let ctx = null;              // domain context from /api/context
    let selectedFiles = [];      // File objects (single or multi)
    let selectedTool = 'merge';
    let selectedAngle = 90;
    let selectedImgFmt = 'png';

    // ── DOM refs ─────────────────────────────────────────────
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    const heroIcon = $('#hero-icon');
    const heroTitle = $('#hero-title');
    const heroSubtitle = $('#hero-subtitle');
    const toolTabs = $('#tool-tabs');
    const uploadArea = $('#upload-area');
    const uploadHint = $('#upload-hint');
    const uploadInfo = $('#upload-info');
    const multiFileZone = $('#multi-file-zone');
    const fileInput = $('#file-input');
    const multiFileInput = $('#multi-file-input');
    const browseBtn = $('#browse-btn');
    const clearBtn = $('#clear-btn');
    const addMoreBtn = $('#add-more-btn');
    const clearAllBtn = $('#clear-all-btn');
    const fileList = $('#file-list');
    const optionsPanel = $('#options-panel');
    const processBtn = $('#process-btn');
    const processText = $('#process-text');
    const processingEl = $('#processing');
    const resultPanel = $('#result-panel');
    const resultInfo = $('#result-info');
    const downloadBtn = $('#download-btn');
    const anotherBtn = $('#another-btn');
    const subdomainsSection = $('#subdomains');
    const subdomainGrid = $('#subdomain-grid');

    // Multi-file tools
    const MULTI_FILE_TOOLS = new Set(['merge', 'img2pdf']);

    // ── Init ─────────────────────────────────────────────────
    async function init() {
        try {
            const res = await fetch('/api/context');
            ctx = await res.json();
        } catch {
            ctx = { toolId: 'hub', brandName: 'Docs.OpenVibe', defaultOp: null, faIcon: 'fa-file-pdf', tools: [] };
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
        document.title = ctx.seoTitle || `${ctx.brandName} — Document Tools`;
        heroIcon.innerHTML = `<i class="fa-solid ${ctx.faIcon || 'fa-file-pdf'}"></i>`;
        heroTitle.textContent = ctx.brandName || 'Docs.OpenVibe';

        const subtitles = {
            hub: 'Online PDF & Document Tools',
            merge: 'Combine PDF Files Online',
            split: 'Split PDF Files Online',
            compress: 'Compress PDF Files Online',
            rotate: 'Rotate PDF Pages Online',
            reorder: 'Rearrange PDF Pages Online',
            watermark: 'Add Watermarks to PDFs Online',
            protect: 'Password Protect PDFs Online',
            unlock: 'Remove PDF Password Online',
            img2pdf: 'Convert Images to PDF Online',
            pdf2img: 'Convert PDF to Images Online',
        };
        heroSubtitle.textContent = subtitles[ctx.toolId] || ctx.seoDescription || subtitles.hub;

        if (ctx.defaultOp) selectedTool = ctx.defaultOp;

        // Hide tool tabs on single-tool domains
        if (ctx.toolId !== 'hub') {
            toolTabs.style.display = 'none';
        }

        // Hide subdomains section on non-hub domains
        if (ctx.toolId !== 'hub') {
            subdomainsSection.style.display = 'none';
        }

        // Update upload hint based on tool
        updateUploadHint();

        // Update meta description
        const metaDesc = document.querySelector('meta[name="description"]');
        if (metaDesc && ctx.seoDescription) metaDesc.content = ctx.seoDescription;
    }

    function updateUploadHint() {
        const isImageTool = selectedTool === 'img2pdf';
        const isPdfTool = !isImageTool;
        if (isImageTool) {
            uploadHint.textContent = 'or click to browse — PNG, JPG, WebP, TIFF, BMP, GIF';
            fileInput.accept = 'image/*';
            multiFileInput.accept = 'image/*';
        } else {
            uploadHint.textContent = 'or click to browse — PDF files';
            fileInput.accept = '.pdf,application/pdf';
            multiFileInput.accept = '.pdf,application/pdf';
        }

        // Multi-file tools allow multiple selection
        if (MULTI_FILE_TOOLS.has(selectedTool)) {
            fileInput.multiple = true;
        } else {
            fileInput.multiple = false;
        }
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
                service: 'docs',
                token,
                user: ctx?.user || user,
                apiBase: 'https://openvibe.network',
                history: { type: 'tool', title: ctx?.brandName || 'Docs.OpenVibe' },
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
                service: 'docs',
                variant: (!ctx || ctx.toolId === 'hub') ? 'full' : 'compact',
                mount: '#ov-footer',
                apiBase: 'https://openvibe.network',
                links: [{ heading: 'Docs tools', items: [
                    { name: 'Merge PDF', url: 'https://mergepdf.openvibe.tools' },
                    { name: 'Split PDF', url: 'https://splitpdf.openvibe.tools' },
                    { name: 'Compress PDF', url: 'https://compresspdf.openvibe.tools' },
                    { name: 'Rotate PDF', url: 'https://rotatepdf.openvibe.tools' },
                    { name: 'Watermark PDF', url: 'https://watermarkpdf.openvibe.tools' },
                    { name: 'Protect PDF', url: 'https://protectpdf.openvibe.tools' },
                    { name: 'Images to PDF', url: 'https://image2pdf.openvibe.tools' },
                    { name: 'PDF to images', url: 'https://pdf2jpg.openvibe.tools' },
                ] }],
            });
        } catch { /* optional */ }
    }

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

    // ── Tool Tabs ────────────────────────────────────────────
    function initToolTabs() {
        $$('.tool-tab[data-tool]').forEach(tab => {
            if (tab.dataset.tool === selectedTool) tab.classList.add('active');
            else tab.classList.remove('active');

            tab.addEventListener('click', () => {
                selectedTool = tab.dataset.tool;
                $$('.tool-tab[data-tool]').forEach(t => t.classList.toggle('active', t.dataset.tool === selectedTool));
                resetUpload();
                updateUploadHint();
                updateProcessButton();
            });
        });
    }

    // ── Upload ───────────────────────────────────────────────
    function initUpload() {
        uploadArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadArea.classList.add('dragover');
        });
        uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
        uploadArea.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadArea.classList.remove('dragover');
            if (e.dataTransfer.files.length) handleFiles(Array.from(e.dataTransfer.files));
        });

        uploadArea.addEventListener('click', () => fileInput.click());
        browseBtn.addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
        fileInput.addEventListener('change', () => {
            if (fileInput.files.length) handleFiles(Array.from(fileInput.files));
        });

        // Multi-file controls
        addMoreBtn.addEventListener('click', () => multiFileInput.click());
        multiFileInput.addEventListener('change', () => {
            if (multiFileInput.files.length) handleFiles(Array.from(multiFileInput.files), true);
        });

        clearBtn.addEventListener('click', resetUpload);
        clearAllBtn.addEventListener('click', resetUpload);
    }

    function handleFiles(files, append = false) {
        const isMulti = MULTI_FILE_TOOLS.has(selectedTool);

        // Validate file types
        for (const file of files) {
            if (selectedTool === 'img2pdf') {
                if (!file.type.startsWith('image/')) {
                    alert(`"${file.name}" is not an image file.`);
                    return;
                }
            } else {
                if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
                    alert(`"${file.name}" is not a PDF file.`);
                    return;
                }
            }
            if (file.size > 100 * 1024 * 1024) {
                alert(`"${file.name}" is too large. Maximum 100MB per file.`);
                return;
            }
        }

        if (isMulti) {
            if (append) {
                selectedFiles = [...selectedFiles, ...files];
            } else {
                selectedFiles = [...files];
            }
            showMultiFileList();
        } else {
            selectedFiles = [files[0]];
            showSingleFile(files[0]);
        }

        optionsPanel.style.display = '';
        showToolOptions();
        updateProcessButton();
    }

    function showSingleFile(file) {
        uploadArea.style.display = 'none';
        multiFileZone.style.display = 'none';
        uploadInfo.style.display = 'flex';

        const preview = $('#file-preview');
        const details = $('#file-details');

        if (file.type === 'application/pdf') {
            preview.innerHTML = '<i class="fa-solid fa-file-pdf"></i>';
        } else {
            const url = URL.createObjectURL(file);
            preview.innerHTML = `<img src="${url}" alt="Preview">`;
        }

        details.innerHTML = `
            <div class="fname">${escapeHtml(file.name)}</div>
            <div class="fmeta">${file.type || 'application/pdf'} &bull; ${formatBytes(file.size)}</div>
        `;
    }

    function showMultiFileList() {
        uploadArea.style.display = 'none';
        uploadInfo.style.display = 'none';
        multiFileZone.style.display = '';

        fileList.innerHTML = selectedFiles.map((f, i) => `
            <li>
                <span class="fname"><i class="fa-solid ${f.type === 'application/pdf' ? 'fa-file-pdf' : 'fa-file-image'}" style="color:var(--accent);margin-right:8px"></i>${escapeHtml(f.name)}</span>
                <span class="fsize">${formatBytes(f.size)}</span>
                <button class="remove-file" data-idx="${i}" title="Remove"><i class="fa-solid fa-xmark"></i></button>
            </li>
        `).join('');

        // Bind remove buttons
        fileList.querySelectorAll('.remove-file').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.idx);
                selectedFiles.splice(idx, 1);
                if (selectedFiles.length === 0) {
                    resetUpload();
                } else {
                    showMultiFileList();
                    updateProcessButton();
                }
            });
        });
    }

    function resetUpload() {
        selectedFiles = [];
        fileInput.value = '';
        multiFileInput.value = '';
        uploadArea.style.display = '';
        uploadInfo.style.display = 'none';
        multiFileZone.style.display = 'none';
        optionsPanel.style.display = 'none';
        resultPanel.style.display = 'none';
        processingEl.style.display = 'none';
        processBtn.disabled = true;
    }

    // ── Options ──────────────────────────────────────────────
    function initOptions() {
        // Split mode toggle
        const splitMode = $('#split-mode');
        if (splitMode) {
            splitMode.addEventListener('change', () => {
                const rangesInput = $('#split-ranges-input');
                rangesInput.style.display = splitMode.value === 'ranges' ? '' : 'none';
            });
        }

        // Watermark opacity slider
        const wmOpacity = $('#wm-opacity');
        const wmOpacityVal = $('#wm-opacity-val');
        if (wmOpacity) {
            wmOpacity.addEventListener('input', () => { wmOpacityVal.textContent = wmOpacity.value; });
        }

        // Angle buttons
        $$('[data-angle]').forEach(btn => {
            btn.addEventListener('click', () => {
                selectedAngle = parseInt(btn.dataset.angle);
                $$('[data-angle]').forEach(b => b.classList.toggle('active', b.dataset.angle === btn.dataset.angle));
            });
        });

        // Image format buttons
        $$('[data-imgfmt]').forEach(btn => {
            btn.addEventListener('click', () => {
                selectedImgFmt = btn.dataset.imgfmt;
                $$('[data-imgfmt]').forEach(b => b.classList.toggle('active', b.dataset.imgfmt === btn.dataset.imgfmt));
            });
        });

        processBtn.addEventListener('click', processDocument);
    }

    function showToolOptions() {
        // Hide all option groups
        const groups = ['opt-split', 'opt-compress', 'opt-rotate', 'opt-reorder',
            'opt-watermark', 'opt-img2pdf', 'opt-pdf2img', 'opt-protect', 'opt-unlock'];
        groups.forEach(id => {
            const el = $(`#${id}`);
            if (el) el.style.display = 'none';
        });

        // Show active tool options
        const optEl = $(`#opt-${selectedTool}`);
        if (optEl) optEl.style.display = '';
    }

    function updateProcessButton() {
        const isMulti = MULTI_FILE_TOOLS.has(selectedTool);
        const hasFiles = selectedFiles.length > 0;
        const hasEnoughFiles = isMulti ? selectedFiles.length >= (selectedTool === 'merge' ? 2 : 1) : hasFiles;
        processBtn.disabled = !hasEnoughFiles;

        const labels = {
            merge: 'Merge PDFs',
            split: 'Split PDF',
            compress: 'Compress PDF',
            rotate: 'Rotate Pages',
            reorder: 'Reorder Pages',
            watermark: 'Add Watermark',
            protect: 'Protect PDF',
            unlock: 'Unlock PDF',
            img2pdf: 'Convert to PDF',
            pdf2img: 'Convert to Images',
            metadata: 'View Info',
        };
        processText.textContent = labels[selectedTool] || 'Process Document';
    }

    // ── Process ──────────────────────────────────────────────
    async function processDocument() {
        if (selectedFiles.length === 0) return;

        optionsPanel.style.display = 'none';
        resultPanel.style.display = 'none';
        processingEl.style.display = '';
        processBtn.disabled = true;

        const isMulti = MULTI_FILE_TOOLS.has(selectedTool);
        const formData = new FormData();
        formData.append('tool', selectedTool);

        if (isMulti) {
            for (const file of selectedFiles) {
                formData.append('files', file);
            }
        } else {
            formData.append('file', selectedFiles[0]);
        }

        // Add tool-specific options
        addToolOptions(formData);

        try {
            const token = getCookie('ov_token') || localStorage.getItem('ov_token');
            const headers = {};
            if (token) headers['Authorization'] = `Bearer ${token}`;

            const endpoint = isMulti ? '/api/process/multi' : '/api/process';
            const res = await fetch(endpoint, { method: 'POST', body: formData, headers });

            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: 'Processing failed' }));
                throw new Error(err.error || `Server error: ${res.status}`);
            }

            const data = await res.json();

            // Handle view-only results (metadata)
            if (data.viewOnly) {
                showMetadataResult(data);
            } else {
                showResult(data);
            }
        } catch (err) {
            processingEl.style.display = 'none';
            optionsPanel.style.display = '';
            processBtn.disabled = false;
            alert(`Error: ${err.message}`);
        }
    }

    function addToolOptions(formData) {
        switch (selectedTool) {
            case 'split': {
                const mode = $('#split-mode').value;
                if (mode === 'ranges') {
                    formData.append('ranges', $('#split-ranges').value);
                } else {
                    formData.append('mode', mode);
                }
                break;
            }
            case 'compress':
                formData.append('level', $('#compress-level').value);
                break;
            case 'rotate':
                formData.append('angle', selectedAngle);
                formData.append('pages', $('#rotate-pages').value || 'all');
                break;
            case 'reorder':
                formData.append('order', $('#reorder-order').value);
                break;
            case 'watermark':
                formData.append('text', $('#wm-text').value);
                formData.append('fontSize', $('#wm-fontsize').value);
                formData.append('opacity', ($('#wm-opacity').value / 100).toString());
                formData.append('rotation', $('#wm-rotation').value);
                formData.append('color', $('#wm-color').value);
                formData.append('pages', $('#wm-pages').value || 'all');
                break;
            case 'img2pdf':
                formData.append('pageSize', $('#img2pdf-pagesize').value);
                break;
            case 'pdf2img':
                formData.append('format', selectedImgFmt);
                formData.append('dpi', $('#pdf2img-dpi').value);
                formData.append('pages', $('#pdf2img-pages').value || 'all');
                break;
            case 'protect':
                formData.append('password', $('#protect-password').value);
                break;
            case 'unlock':
                formData.append('password', $('#unlock-password').value);
                break;
        }
    }

    // ── Result ───────────────────────────────────────────────
    function initResult() {
        anotherBtn.addEventListener('click', () => {
            resetUpload();
            (toolTabs.style.display !== 'none' ? toolTabs : uploadArea).scrollIntoView({ behavior: 'smooth' });
        });
    }

    function showResult(data) {
        processingEl.style.display = 'none';
        resultPanel.style.display = '';

        let infoHtml = '';

        if (data.output) {
            infoHtml += `<p>Format: <strong>${data.output.ext.toUpperCase()}</strong> &bull; Size: <strong>${data.output.sizeKB} KB</strong></p>`;
        }
        if (data.pageCount !== undefined) {
            infoHtml += `<p>Pages: <strong>${data.pageCount}</strong></p>`;
        }
        if (data.fileCount) {
            infoHtml += `<p>Files processed: <strong>${data.fileCount}</strong></p>`;
        }
        if (data.savings) {
            const pct = data.savings.savedPercent;
            if (pct > 0) {
                infoHtml += `<p class="savings">Saved ${pct}% (${formatBytes(data.savings.savedBytes)} smaller)</p>`;
            } else {
                infoHtml += `<p>File size unchanged or slightly larger.</p>`;
            }
        }
        if (data.note) {
            infoHtml += `<p style="color:var(--text-muted);font-size:12px">${escapeHtml(data.note)}</p>`;
        }

        const expires = data.download?.expiresIn;
        if (expires) {
            const expiresStr = expires >= 3600000 ? `${Math.round(expires / 3600000)}h` : `${Math.round(expires / 60000)}m`;
            infoHtml += `<p style="color:var(--text-muted);font-size:12px;margin-top:8px">Download expires in ${expiresStr}</p>`;
        }

        resultInfo.innerHTML = infoHtml;
        downloadBtn.href = data.download?.downloadUrl || '#';
        downloadBtn.download = '';
        downloadBtn.style.display = data.download ? '' : 'none';
        resultPanel.scrollIntoView({ behavior: 'smooth' });
    }

    function showMetadataResult(data) {
        processingEl.style.display = 'none';
        resultPanel.style.display = '';

        const m = data.metadata || {};
        let infoHtml = '<div style="text-align:left;max-width:500px;margin:0 auto">';
        infoHtml += `<p><strong>Title:</strong> ${escapeHtml(m.title || '(none)')}</p>`;
        infoHtml += `<p><strong>Author:</strong> ${escapeHtml(m.author || '(none)')}</p>`;
        infoHtml += `<p><strong>Subject:</strong> ${escapeHtml(m.subject || '(none)')}</p>`;
        infoHtml += `<p><strong>Creator:</strong> ${escapeHtml(m.creator || '(none)')}</p>`;
        infoHtml += `<p><strong>Producer:</strong> ${escapeHtml(m.producer || '(none)')}</p>`;
        infoHtml += `<p><strong>Pages:</strong> ${m.pageCount || '?'}</p>`;
        if (m.creationDate) infoHtml += `<p><strong>Created:</strong> ${m.creationDate}</p>`;
        if (m.modificationDate) infoHtml += `<p><strong>Modified:</strong> ${m.modificationDate}</p>`;
        infoHtml += '</div>';

        resultInfo.innerHTML = infoHtml;
        downloadBtn.style.display = 'none';
        resultPanel.scrollIntoView({ behavior: 'smooth' });
    }

    // ── Subdomains Grid ──────────────────────────────────────
    function initSubdomains() {
        const tools = [
            { host: 'mergepdf.openvibe.tools',     name: 'MergePDF',     icon: 'fa-object-group',  desc: 'Combine PDF files' },
            { host: 'splitpdf.openvibe.tools',     name: 'SplitPDF',     icon: 'fa-scissors',      desc: 'Split by page range' },
            { host: 'compresspdf.openvibe.tools',  name: 'CompressPDF',  icon: 'fa-compress',      desc: 'Reduce file size' },
            { host: 'rotatepdf.openvibe.tools',    name: 'RotatePDF',    icon: 'fa-rotate',        desc: 'Rotate PDF pages' },
            { host: 'reorderpdf.openvibe.tools',   name: 'ReorderPDF',   icon: 'fa-sort',          desc: 'Rearrange pages' },
            { host: 'watermarkpdf.openvibe.tools', name: 'WatermarkPDF', icon: 'fa-stamp',         desc: 'Add watermarks' },
            { host: 'protectpdf.openvibe.tools',   name: 'ProtectPDF',   icon: 'fa-lock',          desc: 'Password protect' },
            { host: 'unlockpdf.openvibe.tools',    name: 'UnlockPDF',    icon: 'fa-lock-open',     desc: 'Remove password' },
            { host: 'image2pdf.openvibe.tools',    name: 'Image2PDF',    icon: 'fa-file-image',    desc: 'Images to PDF' },
            { host: 'jpg2pdf.openvibe.tools',      name: 'JPG2PDF',      icon: 'fa-file-image',    desc: 'JPG to PDF' },
            { host: 'png2pdf.openvibe.tools',      name: 'PNG2PDF',      icon: 'fa-file-image',    desc: 'PNG to PDF' },
            { host: 'pdf2jpg.openvibe.tools',      name: 'PDF2JPG',      icon: 'fa-image',         desc: 'PDF to JPG' },
            { host: 'pdf2png.openvibe.tools',      name: 'PDF2PNG',      icon: 'fa-image',         desc: 'PDF to PNG' },
            { host: 'pdf.openvibe.tools',          name: 'OpenVibePDF',      icon: 'fa-file-pdf',      desc: 'All PDF tools' },
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
