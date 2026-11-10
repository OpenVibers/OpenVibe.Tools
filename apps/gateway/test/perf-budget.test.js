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
    jsRawKB: 369.4,       // 369.4: measured 369.2 with Shared 4.184.0; server-nav hydration marker and atomic replacement, 2026-11-10
    jsBrotliKB: 88.5,     // 88.5: measured 88.4 with Shared 4.184.0; server-nav hydration marker and atomic replacement, 2026-11-10
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
