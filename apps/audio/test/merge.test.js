'use strict';
// Merge (merge.openvibe.tools): the host pointed at an operation that did not exist. Now 2–5 files of
// any format are re-encoded to one rate and stereo and joined in order, as a job (files in "files")
// and on /api/process/multi; wrong file counts are refused before anything runs.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { startApp } = require('../../_shared/test/spawn');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch {
    console.log('audio merge: SKIPPED (no ffmpeg on this machine)');
    process.exit(0);
}

const seconds = (file) => parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString());

(async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-audio-merge-'));
    process.env.DATA_DIR = data;   // the tool's temp files go here, not into the app directory
    const env = { DATA_DIR: data, UPLOADS_DIR: path.join(data, 'uploads'), OUTPUT_DIR: path.join(data, 'output') };
    // Different formats, rates and channel counts: a 1 s mono MP3 at 44.1 kHz and a 0.5 s stereo WAV at 22.05 kHz.
    const mp3 = path.join(data, 'one.mp3'), wav = path.join(data, 'two.wav');
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ac', '1', '-ar', '44100', mp3]);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=0.5', '-ac', '2', '-ar', '22050', wav]);

    // The operation itself.
    const { getTool, listTools } = require('../server/tools');
    const merge = getTool('merge');
    assert.ok(merge && merge.multiFile, 'merge is a registered tool');
    assert.ok(listTools().find(t => t.id === 'merge').multiFile);
    const out = await merge.handler([mp3, wav], { format: 'wav' });
    assert.strictEqual(out.ext, 'wav');
    assert.ok(Math.abs(seconds(out.outputPath) - 1.5) < 0.1, `joined length ${seconds(out.outputPath)}`);
    const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=channels,sample_rate', '-of', 'csv=p=0', out.outputPath]).toString().trim();
    assert.strictEqual(probe, '44100,2', 'one rate, stereo');
    fs.rmSync(out.outputPath, { force: true });
    await assert.rejects(merge.handler([mp3], {}), /at least 2/);
    await assert.rejects(merge.handler([mp3, wav], { format: 'exe' }), /Unsupported output format/);
    const text = path.join(data, 'notes.txt'); fs.writeFileSync(text, 'not audio');
    await assert.rejects(merge.handler([mp3, text], {}), /File 2/);

    // As a real process.
    const app = await startApp('audio', env);
    try {
        const fd = new FormData();
        fd.append('type', 'audio.process');
        fd.append('input', JSON.stringify({ tool: 'merge', format: 'mp3', bitrate: '64' }));
        fd.append('files', new Blob([fs.readFileSync(mp3)], { type: 'audio/mpeg' }), 'intro.mp3');
        fd.append('files', new Blob([fs.readFileSync(wav)], { type: 'audio/wav' }), 'outro.wav');
        let r = await fetch(`${app.base}/api/v1/jobs`, { method: 'POST', body: fd });
        assert.strictEqual(r.status, 202, await r.clone().text());
        const cookie = r.headers.get('set-cookie').split(';')[0];
        let job = await r.json();
        for (let i = 0; i < 200 && !['succeeded', 'failed'].includes(job.state); i++) {
            await sleep(100);
            job = await (await fetch(`${app.base}/api/v1/jobs/${job.id}`, { headers: { cookie } })).json();
        }
        assert.strictEqual(job.state, 'succeeded', JSON.stringify(job.error));
        assert.strictEqual(job.result.files[0].name, 'intro-merged.mp3');
        assert.strictEqual(job.result.data.fileCount, 2);
        const file = path.join(data, 'merged.mp3');
        fs.writeFileSync(file, Buffer.from(await (await fetch(`${app.base}${job.result.files[0].url}`, { headers: { cookie } })).arrayBuffer()));
        assert.ok(Math.abs(seconds(file) - 1.5) < 0.15, `job result length ${seconds(file)}`);

        // The merge host submits merge without naming the tool.
        const one = new FormData();
        one.append('type', 'audio.process');
        one.append('files', new Blob([fs.readFileSync(mp3)], { type: 'audio/mpeg' }), 'a.mp3');
        r = await fetch(`${app.base}/api/v1/jobs`, { method: 'POST', body: one, headers: { cookie, 'X-OV-Tool': 'merge' } });
        assert.strictEqual(r.status, 400, 'one file is not enough to merge');
        assert.match((await r.json()).detail, /2 to 5 files/);
        const two = new FormData();
        two.append('type', 'audio.process');
        two.append('input', JSON.stringify({ tool: 'trim' }));
        two.append('files', new Blob([fs.readFileSync(mp3)], { type: 'audio/mpeg' }), 'a.mp3');
        two.append('files', new Blob([fs.readFileSync(mp3)], { type: 'audio/mpeg' }), 'b.mp3');
        r = await fetch(`${app.base}/api/v1/jobs`, { method: 'POST', body: two, headers: { cookie } });
        assert.strictEqual(r.status, 400, 'single-file tools take one file');

        // The synchronous endpoint (after the burst limiter's window: the jobs above count too).
        await sleep(5100);
        const sync = new FormData();
        sync.append('tool', 'merge');
        sync.append('files', new Blob([fs.readFileSync(wav)], { type: 'audio/wav' }), 'x.wav');
        sync.append('files', new Blob([fs.readFileSync(mp3)], { type: 'audio/mpeg' }), 'y.mp3');
        r = await fetch(`${app.base}/api/process/multi`, { method: 'POST', body: sync });
        const body = await r.json();
        assert.strictEqual(r.status, 200, JSON.stringify(body));
        assert.strictEqual(body.fileCount, 2);
        assert.strictEqual(body.output.ext, 'mp3');
    } finally {
        await app.kill();
        fs.rmSync(data, { recursive: true, force: true });
    }
    console.log('audio merge: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
