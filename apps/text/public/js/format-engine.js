// ═══════════════════════════════════════════════════════════════
// Text.OpenVibe — JSON formatting, Markdown rendering and text comparison.
//
// The engine behind json., markdown. and compare.openvibe.tools, kept apart from text-engine.js so
// those three pages do not load the font tables. Like text-engine.js it is pure (no DOM, no network)
// and runs unchanged in Node: server/engines.js requires it for the tools API (ADR-027).
// ═══════════════════════════════════════════════════════════════
(function (root) {
'use strict';

// ── JSON ─────────────────────────────────────────────────────
/** Keys at every depth (array items are not keys; their own keys are). */
function countKeys(obj) {
    let count = 0;
    if (typeof obj === 'object' && obj !== null) {
        if (Array.isArray(obj)) { obj.forEach(v => count += countKeys(v)); }
        else { for (const k of Object.keys(obj)) { count++; count += countKeys(obj[k]); } }
    }
    return count;
}

/** Nesting depth: a scalar is 0, {} or [] is 1. */
function maxDepth(obj, d) {
    d = d || 0;
    if (typeof obj !== 'object' || obj === null) return d;
    if (Array.isArray(obj)) return obj.length ? Math.max(...obj.map(v => maxDepth(v, d + 1))) : d + 1;
    const vals = Object.values(obj);
    return vals.length ? Math.max(...vals.map(v => maxDepth(v, d + 1))) : d + 1;
}

/** The same value with every object's keys in sorted order. */
function sortKeysDeep(obj) {
    if (Array.isArray(obj)) return obj.map(sortKeysDeep);
    if (typeof obj === 'object' && obj !== null) {
        const sorted = {};
        Object.keys(obj).sort().forEach(k => sorted[k] = sortKeysDeep(obj[k]));
        return sorted;
    }
    return obj;
}

// ── Markdown ─────────────────────────────────────────────────
/** A small Markdown renderer (no dependencies): code, headings, emphasis, links, images, quotes, lists, rules. */
function markdownToHtml(md) {
    let html = md;
    // Code blocks
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Headers
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    // Strikethrough
    html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');
    // Images
    html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">');
    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
    // Blockquotes
    html = html.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');
    // Unordered lists
    html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
    // HR
    html = html.replace(/^---$/gm, '<hr>');
    // Paragraphs
    html = html.replace(/^(?!<[hupblo]|<li|<hr|<img|<pre|<code|<del|<strong|<em|<a)(.+)$/gm, '<p>$1</p>');
    return html;
}

// ── Compare ──────────────────────────────────────────────────
/** Line diff by longest common subsequence → [{ type: 'same'|'add'|'del', text }]. O(lines(a) × lines(b)). */
function diffLines(a, b) {
    const linesA = a.split('\n'), linesB = b.split('\n');
    const m = linesA.length, n = linesB.length;
    // Build LCS table
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++)
        for (let j = 1; j <= n; j++)
            dp[i][j] = linesA[i-1] === linesB[j-1] ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1]);
    // Backtrack
    const result = [];
    let i = m, j = n;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && linesA[i-1] === linesB[j-1]) {
            result.unshift({ type: 'same', text: linesA[i-1] });
            i--; j--;
        } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
            result.unshift({ type: 'add', text: linesB[j-1] });
            j--;
        } else {
            result.unshift({ type: 'del', text: linesA[i-1] });
            i--;
        }
    }
    return result;
}

const FormatOpenVibeEngine = { countKeys, maxDepth, sortKeysDeep, markdownToHtml, diffLines };

if (typeof module !== 'undefined' && module.exports) module.exports = FormatOpenVibeEngine;
else root.FormatOpenVibeEngine = FormatOpenVibeEngine;
})(typeof window !== 'undefined' ? window : this);
