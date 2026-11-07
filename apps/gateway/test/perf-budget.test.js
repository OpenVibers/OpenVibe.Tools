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
    jsRawKB: 315.6, // 315.6 with openvibe-shared 4.133.0 (2026-11-07: your feeds in the menu, the navbar keeps the Frame cards again, Messages and the balances on every signed-in site, and your online status); 313.3 with openvibe-shared 4.129.0 (2026-11-07: the one menu (the burger opens the OpenVibe menu)); 312.2 with openvibe-shared 4.122.0 (2026-11-06: the featured link's phone button (4.119.0), the Dock's agent view (4.120.0), the agent view in the Dock's pop-out (4.121.0) and the thread start page's head (4.122.0)); 308.7 with openvibe-shared 4.114.0 (2026-11-06: the one Share sheet in the navbar (ov-share.js and ov-qr.js load on the first press); navbar.js gains its click handler); 307.4 with openvibe-shared 4.112.1 (2026-11-06: theme-loader.js (4.111.1) and the footer/appbar phone CSS (4.112.1)); 306.1 with openvibe-shared 4.109.2 (2026-11-03: OpenVibe's own select, the navbar loads ov-forms); 302.8 with openvibe-shared 4.106.2 (2026-11-02: the site's name reads whole on a signed-in phone; the balances stack); 301.6 with openvibe-shared 4.103.0 (2026-11-02: the puzzle glyph, two-line sidebar rows, boost lets parsed pages go, eight solids) (2026-11-02); 299 openvibe-shared 4.70.0 (2026-11-01: the app bar, busy(), skeletons, view transitions); 295.6 with openvibe-shared 4.66.0: the mark with depth and motion, ov-fx loaded on request (2026-10-31); 294 with openvibe-shared 4.59.0: the Pair mark beside the name, set in the brand face (2026-10-31); 291.9 with openvibe-shared 4.53.0: the footer's columns fold on phones (2026-10-30); 288.9 with openvibe-shared 4.52.0: the Dock's loader and its Chats tab (2026-10-30); 286.4 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 278.6 with openvibe-shared 4.43.0 (room.css carries the kit tokens, 4.39.1; the kit's 4.39.0 rules); 271.5 with openvibe-shared 4.27.0 and the home's live demo (the design pass, 2026-10-29: +1.2 KB, four real transform previews); 269.3 with openvibe-shared 4.25.0 (the menu's orb beside the brand, both balances on phones, messages, the phone account sheet, the bar stepping away on phones); 263.1 with openvibe-shared 4.22.0 (the navbar's magnifier search and More; search.js and loading.js load only when used); 257.4 with openvibe-shared 4.17.0 (the folded balance chip, Across OpenVibe marks, wallet chips); 243.4 with openvibe-shared 4.15.0 (the compact footer opens into the whole one, the pulse line); 207.9 before
    jsBrotliKB: 75.3,   // 75.3 with openvibe-shared 4.133.0 (2026-11-07: your feeds in the menu, the navbar keeps the Frame cards again, Messages and the balances on every signed-in site, and your online status); 74.8 with openvibe-shared 4.129.0 (2026-11-07: the one menu (the burger opens the OpenVibe menu)); 74.6 with openvibe-shared 4.124.0 (2026-11-07: the share gate's markup start (4.123.0) and the Dock agent view's four controls (4.124.0)); 74.5 with openvibe-shared 4.122.0 (2026-11-06: the featured link's phone button (4.119.0), the Dock's agent view (4.120.0), the agent view in the Dock's pop-out (4.121.0) and the thread start page's head (4.122.0)); 74 with openvibe-shared 4.114.0 (2026-11-06: the one Share sheet in the navbar (ov-share.js and ov-qr.js load on the first press); navbar.js gains its click handler); 73.2 openvibe-shared 4.70.0 (2026-11-01: the app bar, busy(), skeletons, view transitions); 72.5 with openvibe-shared 4.59.0: the Pair mark beside the name, set in the brand face (2026-10-31); 71.3 with openvibe-shared 4.52.0: the Dock's loader and its Chats tab (2026-10-30); 70.6 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 69.1 with openvibe-shared 4.43.0 (room.css carries the kit tokens, 4.39.1; the kit's 4.39.0 rules); 67.3 with openvibe-shared 4.27.0 and the live demo; 66.6 with openvibe-shared 4.25.0; 64.7 with openvibe-shared 4.22.0; 63.2 with openvibe-shared 4.17.0; 60.6 with openvibe-shared 4.15.0; 58.0 with openvibe-shared 4.12.0 (light/dark switch, seasonal mark, theme pairs); 48.5 before
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
