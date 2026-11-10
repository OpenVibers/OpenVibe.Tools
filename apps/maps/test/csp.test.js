'use strict';
// Avatars are served from openvibe.media (the Network's /avatar/<name> redirects there). The survival
// map shows people's avatars, so its Content-Security-Policy img-src must allow that origin.
const assert = require('assert');
const { startApp } = require('../../_shared/test/spawn');

(async () => {
    const maps = await startApp('maps', {}, undefined, { readyPath: '/api/ready' });
    try {
        const csp = (await fetch(`${maps.base}/`)).headers.get('content-security-policy') || '';
        assert.match(csp, /img-src[^;]*https:\/\/openvibe\.media(?:[ ;]|$)/, csp);
        assert.match(csp, /(?:^|;)frame-src https:\/\/openvibe\.network(?:;|$)/, 'only Network may supply the silent session frame');
        console.log('  ✓ img-src allows https://openvibe.media');
    } finally {
        maps.kill('SIGTERM');
        await maps.exited;
    }
})().catch((e) => { console.error(e); process.exitCode = 1; });
