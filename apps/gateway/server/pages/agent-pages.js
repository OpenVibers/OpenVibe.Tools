'use strict';
// The Markdown twins of openvibe.tools' public pages (openvibe-shared/agent-layer): the directory, every family and
// /all-tools. A tool's twin lives in site.js's /tool/:id.md with the tool's primary host as canonical (a /tool page
// would be a second canonical). They are the same pageIndex/pageFamily/pageAll renderers the site serves,
// so a twin cannot drift from its page; /developers too. The noindex search page and the API pages have no twin.
const site = require('./site');
const registry = require('../registry');

function createAgentPages({ opens = null } = {}) {
    async function renderPublicPage(path) {
        const p = String(path || '/').replace(/\/+$/, '') || '/';
        if (p === '/') {
            const top = opens ? await opens.top(7, 12).catch(() => []) : [];
            return { html: site.pageIndex(top) };
        }
        if (p === '/all-tools') return { html: site.pageAll() };
        // The API guide (11-03: llms.txt listed it as HTML; for an agent it is the page that matters most).
        if (p === '/developers') return { html: site.pageDevelopers() };
        const f = registry.get().families.find((x) => x.path === p);
        return f ? { html: site.pageFamily(f) } : null;
    }

    return { renderPublicPage };
}

module.exports = { createAgentPages };
