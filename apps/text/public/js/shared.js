// ═══════════════════════════════════════════════════════════════
// Text.OpenVibe — Shared UI Helpers
// Copy-to-clipboard, toasts, input binding, keyboard shortcuts
// ═══════════════════════════════════════════════════════════════

(function (root) {
'use strict';

// ── Copy to clipboard ────────────────────────────────────────
async function copyText(text, btn) {
    try {
        await navigator.clipboard.writeText(text);
        if (btn) {
            const orig = btn.textContent;
            btn.textContent = 'Copied!';
            btn.classList.add('copied');
            setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1500);
        }
        showToast('Copied to clipboard');
    } catch (e) {
        // Fallback for older browsers
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        if (btn) {
            const orig = btn.textContent;
            btn.textContent = 'Copied!';
            btn.classList.add('copied');
            setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1500);
        }
        showToast('Copied to clipboard');
    }
}

// ── Toast notification ───────────────────────────────────────
let toastTimer = null;
function showToast(message, duration = 2800) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();
    clearTimeout(toastTimer);

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    toastTimer = setTimeout(() => toast.remove(), duration);
}

// ── Live input binding ───────────────────────────────────────
// Calls callback on every input event with debounce
function bindInput(selector, callback, debounceMs = 50) {
    const el = typeof selector === 'string' ? document.querySelector(selector) : selector;
    if (!el) return;
    let timer;
    el.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => callback(el.value), debounceMs);
    });
    // Also trigger immediately if there's a value
    if (el.value) callback(el.value);
}

// ── Create output card ───────────────────────────────────────
function createOutputCard(name, text, container) {
    const card = document.createElement('div');
    card.className = 'output-card';
    card.innerHTML = `
        <div class="style-name">${escapeHtml(name)}</div>
        <div class="style-text">${escapeHtml(text)}</div>
        <button class="copy-btn" title="Copy">Copy</button>
    `;
    card.querySelector('.copy-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        copyText(text, card.querySelector('.copy-btn'));
    });
    card.addEventListener('click', () => copyText(text));
    container.appendChild(card);
    return card;
}

// ── Update output card text ──────────────────────────────────
function updateOutputCard(card, text) {
    const textEl = card.querySelector('.style-text');
    if (textEl) textEl.textContent = text;
    // Update copy handler
    const btn = card.querySelector('.copy-btn');
    if (btn) {
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
        newBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            copyText(text, newBtn);
        });
    }
}

// ── HTML escape ──────────────────────────────────────────────
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ── Download text file ───────────────────────────────────────
function downloadText(text, filename = 'openvibetext-output.txt') {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = filename;
    link.href = url;
    link.click();
    URL.revokeObjectURL(url);
}

// ── Share via Web Share API ──────────────────────────────────
async function shareText(text, title = 'Text.OpenVibe') {
    if (navigator.share) {
        try {
            await navigator.share({ title, text });
        } catch (e) {
            // User cancelled
        }
    } else {
        copyText(text);
    }
}

// ── Shared chrome: navbar + footer ───────────────────────────
// Every page loads navbar.js / footer.js from openvibe.network; this is the one place that
// boots them, so a page only needs a <div id="ov-footer" data-related="Name|url;…"> mount.
const NETWORK = 'https://openvibe.network';
const SILENT_LOGIN = 'https://openvibe.tools/auth/login?silent=1&next={url}';
const LOGO_HOSTS = /^(logo|title|wordmark|textlogo|transparent|badge|sticker|thumbnail|cover|channelart|watermark|neon|overlay|lowerthird)\./;

// The site's own tool list — the footer columns on the hubs, the "more tools" row elsewhere.
const TEXT_TOOLS = [
    { name: 'Fancy Text', url: 'https://fancy.openvibe.tools' },
    { name: 'Zalgo Text', url: 'https://zalgo.openvibe.tools' },
    { name: 'ASCII Art', url: 'https://ascii.openvibe.tools' },
    { name: 'Symbols', url: 'https://symbols.openvibe.tools' },
    { name: 'Kaomoji', url: 'https://kaomoji.openvibe.tools' },
    { name: 'Case Converter', url: 'https://case.openvibe.tools' },
    { name: 'Text Counter', url: 'https://count.openvibe.tools' },
    { name: 'JSON Formatter', url: 'https://json.openvibe.tools' },
    { name: 'Markdown Preview', url: 'https://markdown.openvibe.tools' },
    { name: 'Diff Checker', url: 'https://compare.openvibe.tools' },
    { name: 'Bio Generator', url: 'https://bio.openvibe.tools' },
];
const LOGO_TOOLS = [
    { name: 'Title Cards', url: 'https://title.openvibe.tools' },
    { name: 'Wordmark', url: 'https://wordmark.openvibe.tools' },
    { name: 'Transparent PNG', url: 'https://transparent.openvibe.tools' },
    { name: 'Badges & Stickers', url: 'https://badge.openvibe.tools' },
    { name: 'Thumbnail Text', url: 'https://thumbnail.openvibe.tools' },
    { name: 'Watermark', url: 'https://watermark.openvibe.tools' },
];

function getCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
}

function currentService() {
    return LOGO_HOSTS.test(location.hostname) ? 'logo' : 'text';
}

/** The tool's name for history: "Case Converter — … | case.openvibe.tools" → "Case Converter — …". */
function pageTitle() {
    const h1 = document.querySelector('.page-header h1, .hub-hero h1');
    const fromH1 = h1 ? h1.textContent.replace(/\s+/g, ' ').trim() : '';
    return fromH1 || document.title.split('|')[0].trim();
}

function initNavbar() {
    if (typeof OpenVibeNavbar === 'undefined') return;
    const token = getCookie('ov_token') || localStorage.getItem('ov_token');
    try {
        OpenVibeNavbar.init({
            service: currentService(),
            apiBase: NETWORK,
            token,
            history: { type: 'tool', title: pageTitle() },
            silentLogin: SILENT_LOGIN,
        });
    } catch (e) { /* the page works without the navbar */ }
    if (typeof OpenVibeAccountSwitcher !== 'undefined') {
        try { OpenVibeAccountSwitcher.init({ apiBase: NETWORK }); } catch (e) { /* optional */ }
    }
    if (token && typeof OpenVibeNotifications !== 'undefined') {
        try {
            OpenVibeNotifications.init({ token, apiBase: NETWORK });
            const mount = OpenVibeNavbar.getBellMount && OpenVibeNavbar.getBellMount();
            if (mount) { const bell = OpenVibeNotifications.createBell(); if (bell) mount.appendChild(bell); }
        } catch (e) { /* optional */ }
    }
}

/** Footer: related tools from the mount's data-related, then the site's own tool list. */
function initFooter(opts = {}) {
    if (typeof OpenVibeFooter === 'undefined') return;
    const mount = document.getElementById('ov-footer');
    if (!mount) return;
    const related = (mount.dataset.related || '').split(';').map(s => s.trim()).filter(Boolean).map(pair => {
        const [name, url] = pair.split('|');
        return { name: (name || '').trim(), url: (url || '').trim() };
    }).filter(l => l.name && l.url);
    const service = currentService();
    const links = [];
    if (related.length) links.push({ heading: 'Related tools', items: related });
    if (service === 'logo') {
        links.push({ heading: 'Logo tools', items: LOGO_TOOLS });
        links.push({ heading: 'Text tools', items: TEXT_TOOLS.slice(0, 6) });
    } else {
        links.push({ heading: 'Text tools', items: TEXT_TOOLS });
        links.push({ heading: 'Logo tools', items: LOGO_TOOLS });
    }
    try {
        OpenVibeFooter.init({ service, variant: opts.variant || 'compact', links, apiBase: NETWORK, mount: '#ov-footer' });
    } catch (e) { /* optional */ }
}

// ── Common page init ─────────────────────────────────────────
// Called on every page: shared chrome, keyboard shortcuts, live-tool affordances.
//   opts.footer — 'full' on the hub pages, 'compact' (default) on tool pages
function initPage(opts = {}) {
    initNavbar();
    initFooter({ variant: opts.footer });

    // "/" key focuses input (when not already in a field)
    document.addEventListener('keydown', (e) => {
        if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
            e.preventDefault();
            const input = document.querySelector('textarea, input[type="text"]');
            if (input) input.focus();
        }
    });

    // ── Auto-inject UX affordances for live-updating tools ──
    // Detects tools with textarea/input + output-grid/output area and adds:
    //   1. A "⚡ Results update as you type" live indicator
    //   2. A visible "Generate" button for users who expect one
    //   3. Enter key support for single-line <input> fields
    const mainInput = document.querySelector('#input, .tool-section textarea, .tool-section input[type="text"]');
    const outputArea = document.querySelector('#output, .output-grid, .output-section, #result, .result');
    if (!mainInput || !outputArea) return; // not a text-tool page (picker, hub, etc.)

    // Skip pages that already have their own action buttons (sort, bio, nickname, etc.)
    const existingBtns = mainInput.closest('.tool-section')?.querySelectorAll('.btn-primary, .btn[data-action]');
    if (existingBtns && existingBtns.length > 0) return;

    const inputGroup = mainInput.closest('.input-group') || mainInput.parentElement;

    // 1. Live indicator hint
    if (!document.querySelector('.live-hint')) {
        const hint = document.createElement('div');
        hint.className = 'live-hint';
        hint.innerHTML = '<span class="live-dot"></span> Results update as you type';
        inputGroup.appendChild(hint);
    }

    // 2. Generate button (triggers existing input event listeners)
    if (!document.querySelector('.generate-btn')) {
        const btnRow = document.createElement('div');
        btnRow.className = 'generate-row';
        const btn = document.createElement('button');
        btn.className = 'btn btn-primary generate-btn';
        btn.innerHTML = '<i class="fas fa-bolt"></i> Generate';
        btn.addEventListener('click', () => {
            mainInput.dispatchEvent(new Event('input', { bubbles: true }));
            mainInput.focus();
            // Brief flash on the output area to draw attention
            outputArea.classList.add('output-flash');
            setTimeout(() => outputArea.classList.remove('output-flash'), 600);
        });
        btnRow.appendChild(btn);
        inputGroup.after(btnRow);
    }

    // 3. Enter key support for single-line <input> fields
    if (mainInput.tagName === 'INPUT') {
        mainInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                mainInput.dispatchEvent(new Event('input', { bubbles: true }));
                outputArea.classList.add('output-flash');
                setTimeout(() => outputArea.classList.remove('output-flash'), 600);
            }
        });
    }

    // 4. Flash output on first meaningful input change to draw attention
    let hasFlashed = false;
    mainInput.addEventListener('input', () => {
        if (!hasFlashed && mainInput.value.trim().length > 0) {
            hasFlashed = true;
            outputArea.classList.add('output-flash');
            setTimeout(() => outputArea.classList.remove('output-flash'), 600);
        }
    });
}

// ── Public API ───────────────────────────────────────────────
root.OpenVibeUI = {
    copyText,
    showToast,
    bindInput,
    createOutputCard,
    updateOutputCard,
    escapeHtml,
    downloadText,
    shareText,
    initPage,
};

})(window);
