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
    htmlRawKB: 225,       // 206 measured with all 184 crawlable tool rows; room for populated ranking rows
    htmlBrotliKB: 29,      // 26.5 measured with the complete category ItemLists
    jsFiles: 6,           // 5
    jsRawKB: 388.5,      // 2026-11-10: openvibe-shared 4.197.0 (the menu's row of places, the You tab's row, the Sign in mark, the tooltip); 387: measured 386.5 KB raw with openvibe-shared 4.190.0 (2026-11-10: the site name's dropdown, the footer's online strip, the balances pill); 370.3: measured 370.2 KB raw with openvibe-shared 4.186.0 (2026-11-10: the mark's Working and Thinking states, the Dock and the menu as one sheet, bare controls styled by the loader); 369.4: measured 369.2 with Shared 4.184.0; server-nav hydration marker and atomic replacement, 2026-11-10
    jsBrotliKB: 93,       // 93: measured 92.7 KB brotli with openvibe-shared 4.190.0 (2026-11-10: the site name's dropdown, the footer's online strip, the balances pill); 88.8: measured 88.7 KB brotli with openvibe-shared 4.186.0 (2026-11-10: the mark's Working and Thinking states, the Dock and the menu as one sheet, bare controls styled by the loader); 88.5: measured 88.4 with Shared 4.184.0; server-nav hydration marker and atomic replacement, 2026-11-10
    cssFiles: 1,          // 1: the kit's stylesheet
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
