'use strict';
/**
 * deploy/scripts/deploy.sh is a thin wrapper around `ovhost deploy tools` (OpenVibe.Host, strategy
 * multi-app; roadmap WS-N task 11) with deploy-legacy.sh (the previous script, unchanged) as its
 * fallback. A fake ovhost records what the wrapper asks for; a fake legacy script records the fallback.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const WRAPPER = path.join(__dirname, '..', '..', '..', 'deploy', 'scripts', 'deploy.sh');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-deploy-wrapper-'));
const log = path.join(tmp, 'calls.log');
const ovhost = path.join(tmp, 'ovhost');
fs.writeFileSync(ovhost, `#!/usr/bin/env bash
if [ "$1" = capabilities ]; then
  [ -n "$FAKE_OLD" ] && exit 1
  printf '%b\\n' "\${FAKE_CAPS:-ovhost=0.3.0\\ndeploy-api=1\\nservice=tools\\nstrategy=multi-app\\nmanaged=yes\\nlayout=git}"
  exit 0
fi
echo "ovhost $*" >> "${log}"
exit "\${FAKE_EXIT:-0}"
`, { mode: 0o755 });
const legacy = path.join(tmp, 'legacy.sh');
fs.writeFileSync(legacy, `#!/usr/bin/env bash\necho "legacy $*" >> "${log}"\n`, { mode: 0o755 });

function run(args = [], env = {}) {
    fs.rmSync(log, { force: true });
    const r = spawnSync('bash', [WRAPPER, ...args], { env: { PATH: process.env.PATH, OVHOST: ovhost, OVHOST_SUDO: '', DEPLOY_LEGACY: legacy, ...env }, encoding: 'utf8' });
    let calls = [];
    try { calls = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean); } catch { /* none */ }
    return { code: r.status, out: r.stdout + r.stderr, calls };
}

assert.deepStrictEqual(run().calls, ['ovhost deploy tools']);
assert.deepStrictEqual(run(['--wait-idle']).calls, ['ovhost deploy tools --wait-idle']);
assert.deepStrictEqual(run(['--rollback']).calls, ['ovhost rollback tools']);
assert.deepStrictEqual(run([], { DRY_RUN: '1' }).calls, ['ovhost plan tools']);
assert.strictEqual(run([], { FAKE_EXIT: '3' }).code, 3, "ovhost's exit code is the wrapper's");
assert.strictEqual(run(['--nope']).code, 1);

let r = run([], { FAKE_OLD: '1' });
assert.deepStrictEqual(r.calls, ['legacy'], 'too old: the legacy script');
assert.match(r.out, /too old/);
r = run([], { FAKE_CAPS: 'deploy-api=1\\nstrategy=git-checkout\\nmanaged=yes' });
assert.deepStrictEqual(r.calls, ['legacy'], 'another strategy: the legacy script');
assert.match(r.out, /does not deploy tools with strategy multi-app \(git-checkout\)/);
r = run([], { OVHOST: path.join(tmp, 'missing') });
assert.deepStrictEqual(r.calls, ['legacy']);
for (const [args, env] of [[['--rollback'], {}], [['--wait-idle'], {}], [[], { DRY_RUN: '1' }]]) {
    r = run(args, { OVHOST_LEGACY: '1', ...env });
    assert.strictEqual(r.code, 1, `${args.join(' ')} ${JSON.stringify(env)}: the legacy script cannot, so nothing runs`);
    assert.deepStrictEqual(r.calls, []);
}
assert.match(fs.readFileSync(WRAPPER, 'utf8'), /^set -euo pipefail$/m);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('deploy wrapper: all checks passed');
