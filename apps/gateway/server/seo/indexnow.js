'use strict';

// ═══════════════════════════════════════════════════════════════
// IndexNow (openvibe-shared/indexnow): the key file engines fetch to verify this site.
//
// Created once at boot from INDEXNOW_KEY in the gateway config (server/config.js). A blank or
// unset key means off: the module is not mounted, /<key>.txt falls through to the 404, and no
// ping is ever sent. Tools has no user-created public pages — every page is built from the
// tool descriptors at boot — so nothing here calls pingSoon(); only the key file is served.
// ═══════════════════════════════════════════════════════════════
const shared = require('openvibe-shared/indexnow');

/** @param {string} host the site host, e.g. https://openvibe.tools @param {string} [key] INDEXNOW_KEY */
function createToolsIndexNow(host, key) {
    const trimmed = String(key == null ? '' : key).trim();
    // createIndexNow() itself refuses a key that is not 8–128 hex/alphanumeric; null is the "off" key.
    return shared.createIndexNow({ host, key: trimmed === '' ? null : trimmed });
}

module.exports = { createToolsIndexNow };
