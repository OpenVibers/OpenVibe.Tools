'use strict';
// The Markdown twins of openvibe.tools' public pages (openvibe-shared/agent-layer): the directory, every family,
// /all-tools and each tool's page. They are the same pageIndex/pageFamily/pageTool/pageAll renderers the site serves,
// so a twin cannot drift from its page. The noindex search page and the API pages have no twin.
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
        if (p.startsWith('/tool/')) {
            const t = registry.get().tools.find((x) => x.id === p.slice('/tool/'.length));
            return t ? { html: site.pageTool(t) } : null;
        }
        const f = registry.get().families.find((x) => x.path === p);
        return f ? { html: site.pageFamily(f) } : null;
    }

    return { renderPublicPage };
}

module.exports = { createAgentPages };
