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

// ── Common page init ─────────────────────────────────────────
// Called on every page to set up keyboard shortcuts, etc.
function initPage() {
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
