'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const WRAPPER = path.join(__dirname, '..', '..', '..', 'deploy', 'scripts', 'deploy.sh');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-deploy-wrapper-'));
const log = path.join(tmp, 'calls.log');
const ovhost = path.join(tmp, 'ovhost');
fs.writeFileSync(ovhost, `#!/usr/bin/env bash\necho "$*" >> "${log}"\nexit "\${FAKE_EXIT:-0}"\n`, { mode: 0o755 });
function run(args = [], env = {}) {
    fs.rmSync(log, { force: true });
    const r = spawnSync('bash', [WRAPPER, ...args], { env: { PATH: process.env.PATH, OVHOST: ovhost, OVHOST_SUDO: '', ...env }, encoding: 'utf8' });
    let calls = [];
    try { calls = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean); } catch { /* none */ }
    return { code: r.status, out: r.stdout + r.stderr, calls };
}
assert.deepStrictEqual(run().calls, ['deploy tools']);
assert.deepStrictEqual(run(['--wait-idle']).calls, ['deploy tools --wait-idle']);
assert.deepStrictEqual(run(['--restart']).calls, ['deploy tools --restart']);
assert.deepStrictEqual(run(['--force']).calls, ['deploy tools --force']);
assert.deepStrictEqual(run(['--rollback']).calls, ['rollback tools']);
assert.deepStrictEqual(run([], { DRY_RUN: '1' }).calls, ['plan tools']);
assert.strictEqual(run([], { FAKE_EXIT: '3' }).code, 3);
assert.strictEqual(run(['--nope']).code, 1);
const missing = run([], { OVHOST: path.join(tmp, 'missing') });
assert.strictEqual(missing.code, 1);
assert.deepStrictEqual(missing.calls, []);
assert.match(missing.out, /ovhost not found/);
assert.doesNotMatch(fs.readFileSync(WRAPPER, 'utf8'), /legacy|capabilities|DEPLOY_LEGACY|OVHOST_LEGACY/i);
fs.rmSync(tmp, { recursive: true, force: true });
console.log('deploy wrapper: all checks passed');
