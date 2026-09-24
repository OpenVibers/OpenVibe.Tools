'use strict';
// Audio.OpenVibe as a real process, with real ffmpeg: a job RUNNING when the process is killed is
// re-queued by the next process and finishes; a running job is cancelled (ffmpeg killed); progress
// events come from ffmpeg itself.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { startApp } = require('../../_shared/test/spawn');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch {
    console.log('audio jobs: SKIPPED (no ffmpeg on this machine)');
    process.exit(0);
}

async function waitFor(app, id, cookie, pred, what, ms = 30000) {
    const t0 = Date.now();
    for (;;) {
        const job = await (await fetch(`${app.base}/api/v1/jobs/${id}`, { headers: { cookie } })).json();
        if (pred(job)) return job;
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(job)}`);
        await sleep(150);   // the older /api/ limiter allows an address 60 requests a minute
    }
}

(async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-audio-'));
    const env = { DATA_DIR: data, UPLOADS_DIR: path.join(data, 'uploads'), OUTPUT_DIR: path.join(data, 'output') };
    // Three minutes of tone: small to upload, a couple of seconds to re-encode.
    const input = path.join(data, 'tone.mp3');
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=180', '-ac', '1', '-b:a', '16k', input]);
    const bytes = fs.readFileSync(input);
    const submit = async (app, cookie, tool) => {
        const fd = new FormData();
        fd.append('type', 'audio.process');
        fd.append('input', JSON.stringify(tool));
        fd.append('file', new Blob([bytes], { type: 'audio/mpeg' }), 'tone.mp3');
        const r = await fetch(`${app.base}/api/v1/jobs`, { method: 'POST', body: fd, headers: cookie ? { cookie } : {} });
        assert.strictEqual(r.status, 202, await r.clone().text());
        return { job: await r.json(), cookie: cookie || r.headers.get('set-cookie').split(';')[0] };
    };
    let app;
    try {
        app = await startApp('audio', env);

        // Killed while ffmpeg runs → the next process runs it again.
        const { job, cookie } = await submit(app, null, { tool: 'convert', format: 'flac' });
        await waitFor(app, job.id, cookie, j => j.state === 'running', 'running');
        await app.kill('SIGKILL');
        app = await startApp('audio', env, app.port);
        const done = await waitFor(app, job.id, cookie, j => j.state === 'succeeded' || j.state === 'failed', 'finished after restart');
        assert.strictEqual(done.state, 'succeeded', JSON.stringify(done.error));
        assert.strictEqual(done.attempts, 2, 'the interrupted attempt is counted');
        assert.strictEqual(done.result.files[0].name, 'tone.flac');
        const r = await fetch(`${app.base}${done.result.files[0].url}`, { headers: { cookie } });
        assert.strictEqual(Buffer.from(await r.arrayBuffer()).slice(0, 4).toString(), 'fLaC', 'the result is FLAC');
        const ranged = await fetch(`${app.base}${done.result.files[0].url}?inline=1`, { headers: { cookie, range: 'bytes=0-3' } });
        assert.strictEqual(ranged.status, 206, 'previews support range requests (audio seeking)');

        // Progress from ffmpeg, then cancel: ffmpeg is killed and the job ends cancelled.
        const second = await submit(app, cookie, { tool: 'convert', format: 'mp3', bitrate: '320' });
        const moving = await waitFor(app, second.job.id, cookie, j => j.state === 'running' && j.progress.message === 'Encoding' || j.state === 'succeeded', 'ffmpeg progress');
        if (moving.state === 'running') {
            const c = await fetch(`${app.base}/api/v1/jobs/${second.job.id}`, { method: 'DELETE', headers: { cookie } });
            assert.ok([200, 202].includes(c.status));
            const cancelled = await waitFor(app, second.job.id, cookie, j => j.state !== 'running', 'cancelled');
            assert.strictEqual(cancelled.state, 'cancelled');
            assert.strictEqual(cancelled.error.code, 'tools.job.cancelled');
        } else {
            console.log('audio jobs: (this machine encoded too fast to cancel mid-run; cancel is covered by the shared tests)');
        }

        await app.kill('SIGTERM');
        console.log('audio jobs: all checks passed');
    } catch (err) {
        if (app) { console.error(app.output()); await app.kill('SIGKILL'); }
        throw err;
    } finally {
        fs.rmSync(data, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exit(1); });
