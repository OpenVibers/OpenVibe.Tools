'use strict';
// A tool subdomain's page always has a share image: one whose own HTML names none (dev, dns, regex, …) gets the Tools
// card from the site's pinned Frame files, with twitter:image and its size; one that names its own keeps it, once.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { renderTool } = require('../server/seo/render');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-seo-'));
const page = (name, extra = '') => {
    const file = path.join(dir, `${name}.html`);
    fs.writeFileSync(file, `<!doctype html><html><head><title>x</title><meta name="description" content="x"><meta property="og:title" content="x"><meta property="og:description" content="x"><meta property="og:url" content="x"><link rel="canonical" href="x">${extra}</head><body><main></main></body></html>`);
    return file;
};
try {
    const bare = renderTool(page('bare'), 'dev');
    const og = (/<meta property="og:image" content="([^"]+)">/.exec(bare) || [])[1];
    assert.match(String(og), /^https:\/\/openvibe\.tools\/shared\/social\/tools\.jpg\?v=[0-9a-f]+$/, `og:image ${og}`);
    assert.ok(bare.includes(`<meta name="twitter:image" content="${og}">`), 'twitter:image');
    assert.ok(bare.includes('<meta property="og:image:width" content="1200">') && bare.includes('<meta property="og:image:height" content="630">'));

    const own = renderTool(page('own', '<meta property="og:image" content="https://img.openvibe.tools/og.png">'), 'img');
    assert.strictEqual((own.match(/property="og:image"/g) || []).length, 1, 'one og:image');
    assert.ok(own.includes('content="https://img.openvibe.tools/og.png"'), 'the page keeps its own image');
    console.log('seo share image: all checks passed');
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}
