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
    jsRawKB: 279,         // 278.6 with openvibe-shared 4.43.0 (room.css carries the kit tokens, 4.39.1; the kit's 4.39.0 rules); 271.5 with openvibe-shared 4.27.0 and the home's live demo (the design pass, 2026-10-29: +1.2 KB, four real transform previews); 269.3 with openvibe-shared 4.25.0 (the menu's orb beside the brand, both balances on phones, messages, the phone account sheet, the bar stepping away on phones); 263.1 with openvibe-shared 4.22.0 (the navbar's magnifier search and More; search.js and loading.js load only when used); 257.4 with openvibe-shared 4.17.0 (the folded balance chip, Across OpenVibe marks, wallet chips); 243.4 with openvibe-shared 4.15.0 (the compact footer opens into the whole one, the pulse line); 207.9 before
    jsBrotliKB: 70,       // 69.1 with openvibe-shared 4.43.0 (room.css carries the kit tokens, 4.39.1; the kit's 4.39.0 rules); 67.3 with openvibe-shared 4.27.0 and the live demo; 66.6 with openvibe-shared 4.25.0; 64.7 with openvibe-shared 4.22.0; 63.2 with openvibe-shared 4.17.0; 60.6 with openvibe-shared 4.15.0; 58.0 with openvibe-shared 4.12.0 (light/dark switch, seasonal mark, theme pairs); 48.5 before
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
