'use strict';
// ═══════════════════════════════════════════════════════════════
// What each Tools app says about the deploy it runs: GET /release.json (ADR-016, registry.release-
// manifest@1) through openvibe-shared/release, mounted with release.mount (it also takes the shared
// navbar's POST /release-metrics into /metrics).
//
// The release is the repository's commit; every app is its own surface, so each one declares its
// components (manifest 1.1.0, served when the app's openvibe-contracts has that schema):
//   shell   what a page is made of (kind script): the app's public/ files, the server files that stamp
//           its pages, and the job helper the pages load (/js/ov-jobs.js) — a change reloads open tabs
//           at a safe moment
//   server  everything else the app runs (kind server): an API-only release leaves open tabs alone
// Before 1.5.0 every release reloaded every tab.
// ═══════════════════════════════════════════════════════════════

const path = require('path');
const { requireShared } = require('./version');

const ROOT = path.join(__dirname, '..', '..');

// Per app: the server files that shape its pages (templates, SEO stamping, host branding, catalogue).
const PAGE_FILES = {
    gateway: ['server/pages', 'server/seo', 'server/registry', 'server/net/config.js', 'server/dev/config.js'],
    img: ['server/seo.js', 'server/domain-map.js'],
    audio: ['server/seo.js', 'server/domain-map.js'],
    docs: ['server/seo.js', 'server/domain-map.js'],
    text: ['server/seo.js', 'server/hosts.js'],
};
const JOB_APPS = new Set(['img', 'audio', 'docs']);

/**
 * @param {string} app            'gateway' | 'img' | …
 * @param {Function} appRequire   the app's require (its own openvibe-shared and openvibe-contracts)
 * @param {object} [opts]         passed on to createRelease (tests: env, now, logger)
 */
function toolsRelease(app, appRequire, opts = {}) {
    requireShared(app);   // the app's declared openvibeToolsShared range, or it does not boot (version.js)
    const { createRelease } = appRequire('openvibe-shared/release');
    const dir = `apps/${app}`;
    let schema = null;
    try { schema = appRequire('openvibe-contracts/contracts/registry/release-manifest.v1.json'); } catch { schema = null; }
    const components = {
        shell: {
            kind: 'script',
            files: [`${dir}/public`, ...(PAGE_FILES[app] || []).map(f => `${dir}/${f}`), 'apps/_shared/host-role.js', ...(JOB_APPS.has(app) ? ['apps/_shared/jobs/client.js'] : [])],
        },
        server: { kind: 'server', files: [`${dir}/server`, 'apps/_shared', `${dir}/package-lock.json`] },
    };
    const release = createRelease({
        service: 'tools', root: ROOT, publicDir: `${dir}/public`, components,
        ...(schema && { schema }),
        ...opts,
    });
    // D42 (roadmap WS-P task 4): every app serves its OWN pinned copy of the shared browser files at /shared
    // (navbar, footer, theme loader, bell…), content-addressed, so its pages run what its pin says and keep
    // their frame while openvibe.network is down. Mounted with the release routes, before any page fallback.
    const mountRelease = release.mount;
    release.mount = function mount(app, o) {
        app.use('/shared', appRequire('openvibe-shared/serve').handler());
        return mountRelease.call(this, app, o);
    };
    return release;
}

module.exports = { toolsRelease, PAGE_FILES, ROOT };
