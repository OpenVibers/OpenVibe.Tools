'use strict';
// Size budgets for openvibe.tools' home page (roadmap WS-T task 1, openvibe-shared/perf-budget): the
// gateway as it runs, measured without a browser. Budgets sit a little above the 2026-09-26 measurement;
// raising one is a decision to state in the commit.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { measure, check, format } = require('openvibe-shared/perf-budget');
const { startApp } = require('../../_shared/test/spawn');

const BUDGETS = {
    htmlRawKB: 160,       // measured 135.5 (production; the catalogue is server-rendered)
    htmlBrotliKB: 23,     // 19.5
    jsFiles: 6,           // 5
    jsRawKB: 345.1, // 345.1: measured 337.1 with openvibe-shared 4.161.0, plus room for 4.162.0–4.163.0, 2026-11-09
    jsBrotliKB: 80, // 80: measured 330.1 KB raw / 78.5 KB brotli with openvibe-shared 4.159.0, plus room for 4.160.0–4.161.0 (the navbar's slots loader, the keyboard watcher, the pop motion), 2026-11-09; 77.9 with openvibe-shared 4.153.0 (2026-11-08: signed in to the network, signed in here, on phones too; a page can turn away a carried card); 77.7 with openvibe-shared 4.152.0 (2026-11-08: the menu marks the page you are on and opens without the keyboard on a phone, floating cards follow you across OpenVibe sites (overlay.js), and the navbar preconnects to the next OpenVibe site on intent); 77.1 with openvibe-shared 4.150.0 (2026-11-08: the bell opens the Dock on Activity, the Dock's phone header is in two rows, and the menu's orb is the close button with an open/close animation); 76.9 with openvibe-shared 4.149.0 (2026-11-08: the menu has tabs at the top; the phone's menu button is the orb of 4.148.0); 76.4 with openvibe-shared 4.142.0 (2026-11-07: the menu has a close button on a phone);  76.2 with openvibe-shared 4.139.0 (2026-11-07: the menu's feed rows lead with their picture, the footer and glyphs defer 38 KB); 76 with openvibe-shared 4.137.0 (2026-11-07: every script by its content hash, one menu button on a phone, the menu warms at idle); 75.5 with openvibe-shared 4.135.0 (2026-11-07: Ask your agent from any page (kit.askAgent), the Dock's Agent panel reads the timeline again, and the menu's feeds follow you); 75.3 with openvibe-shared 4.133.0 (2026-11-07: your feeds in the menu, the navbar keeps the Frame cards again, Messages and the balances on every signed-in site, and your online status); 75.3 with openvibe-shared 4.133.0 (2026-11-07: your feeds in the menu, the navbar keeps the Frame cards again, Messages and the balances on every signed-in site, and your online status); 74.8 with openvibe-shared 4.129.0 (2026-11-07: the one menu (the burger opens the OpenVibe menu)); 74.6 with openvibe-shared 4.124.0 (2026-11-07: the share gate's markup start (4.123.0) and the Dock agent view's four controls (4.124.0)); 74.5 with openvibe-shared 4.122.0 (2026-11-06: the featured link's phone button (4.119.0), the Dock's agent view (4.120.0), the agent view in the Dock's pop-out (4.121.0) and the thread start page's head (4.122.0)); 74 with openvibe-shared 4.114.0 (2026-11-06: the one Share sheet in the navbar (ov-share.js and ov-qr.js load on the first press); navbar.js gains its click handler); 73.2 openvibe-shared 4.70.0 (2026-11-01: the app bar, busy(), skeletons, view transitions); 72.5 with openvibe-shared 4.59.0: the Pair mark beside the name, set in the brand face (2026-10-31); 71.3 with openvibe-shared 4.52.0: the Dock's loader and its Chats tab (2026-10-30); 70.6 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 69.1 with openvibe-shared 4.43.0 (room.css carries the kit tokens, 4.39.1; the kit's 4.39.0 rules); 67.3 with openvibe-shared 4.27.0 and the live demo; 66.6 with openvibe-shared 4.25.0; 64.7 with openvibe-shared 4.22.0; 63.2 with openvibe-shared 4.17.0; 60.6 with openvibe-shared 4.15.0; 58.0 with openvibe-shared 4.12.0 (light/dark switch, seasonal mark, theme pairs); 48.5 before
    cssFiles: 1,          // 0
    externalFiles: 3,     // 1 in production
};

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-tools-budget-'));
    const gw = await startApp('gateway', { DATA_DIR: tmp, OV_DOMAINS_URL: 'http://127.0.0.1:9/api/domains', OV_REGISTRY_URL: 'http://127.0.0.1:9/registry' });
    try {
        const m = await measure({ base: gw.base });
        const over = check(m, BUDGETS);
        assert.deepStrictEqual(over, [], format(m, over));
        console.log(format(m));
        console.log('perf budget: all checks passed');
    } finally {
        await gw.kill();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exit(1); });
