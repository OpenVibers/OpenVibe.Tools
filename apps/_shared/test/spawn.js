'use strict';
// Start a satellite as its own process (the way systemd does), so a test can kill it outright and
// start it again over the same data directory.
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    });
}

/**
 * @param {string} app   'img' | 'audio' | 'docs' | …
 * @param {object} env   extra environment (DATA_DIR, TOOLS_JOBS_CONCURRENCY_…)
 * @returns {Promise<{ base, port, kill(signal), exited: Promise, output: () => string }>}
 */
async function startApp(app, env = {}, port) {
    port = port || await freePort();
    const dir = path.join(__dirname, '..', '..', app);
    let out = '';
    const child = spawn(process.execPath, ['server/index.js'], {
        cwd: dir,
        env: {
            ...process.env,
            NODE_ENV: 'test',
            PORT: String(port),
            HOST: '127.0.0.1',
            // Never reach the real Network from a test: the key fetch fails fast and users are anonymous.
            OV_NETWORK_URL: 'http://127.0.0.1:9',
            OV_NETWORK_INTERNAL_URL: 'http://127.0.0.1:9',
            TOOLS_JOB_RESULTS: 'local',
            ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const exited = new Promise(r => child.on('exit', r));
    const base = `http://127.0.0.1:${port}`;
    const t0 = Date.now();
    for (;;) {
        if (child.exitCode != null) throw new Error(`${app} exited during boot:\n${out}`);
        try { const r = await fetch(`${base}/api/health`); if (r.ok) break; } catch { /* not up yet */ }
        if (Date.now() - t0 > 15000) { child.kill('SIGKILL'); throw new Error(`${app} did not start:\n${out}`); }
        await new Promise(r => setTimeout(r, 100));
    }
    return {
        base, port, exited,
        output: () => out,
        kill(signal = 'SIGKILL') { child.kill(signal); return exited; },
    };
}

module.exports = { startApp, freePort };
