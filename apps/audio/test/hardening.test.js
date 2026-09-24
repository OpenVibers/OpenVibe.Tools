'use strict';
// ffmpeg hardening (apps/_shared/guard/ffmpeg.js through server/process.js): an HLS playlist or an
// ffconcat list that points at a local file is refused — by the upload sniffing at the door, and by
// ffmpeg's own protocol and format whitelists if one ever got further; inputs longer than the
// descriptor's maxDurationSec are refused before work starts (and -t caps what is read); a
// synchronous run is killed at its deadline.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');
const { startApp } = require('../../_shared/test/spawn');

try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch {
    console.log('audio hardening: SKIPPED (no ffmpeg on this machine)');
    process.exit(0);
}

(async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-audio-guard-'));
    process.env.DATA_DIR = data;   // the tools' temp files go here
    const ff = (...args) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args]);
    const secret = path.join(data, 'secret.wav');
    ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', secret);
    const hls = path.join(data, 'evil.m3u8');
    fs.writeFileSync(hls, `#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:2,\nfile://${secret}\n#EXT-X-ENDLIST\n`);
    const concat = path.join(data, 'evil.ffconcat');
    fs.writeFileSync(concat, "ffconcat version 1.0\nfile 'secret.wav'\n");
    // The attack is real on this ffmpeg: unhardened, the playlist reads the local file.
    const plain = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=format_name,duration', '-of', 'csv=p=0', hls]).toString();
    assert.match(plain, /hls/, 'without the whitelists ffprobe follows the playlist');

    const { jobContext, runTool, runSync, limitsFor } = require('../server/process');
    const { getTool } = require('../server/tools');
    const hardening = require('../../_shared/guard/ffmpeg');
    const ffmpeg = require('fluent-ffmpeg');

    // ── Every command's inputs carry the whitelists and the duration cap ──
    const lim = limitsFor('convert');
    assert.strictEqual(lim.maxDurationSec, 3 * 60 * 60, 'the descriptor\'s limits.maxDurationSec');
    assert.ok(!lim.formats.includes('hls') && !lim.formats.includes('concat'));
    assert.ok(limitsFor('extract').formats.includes('avi') && !lim.formats.includes('avi'), 'only the extractor opens video-only containers');
    const cmd = ffmpeg(secret).noVideo().output(path.join(data, 'x.mp3'));
    hardening.applyToCommand(cmd, lim);
    const args = cmd._getArguments();
    const at = args.indexOf('-i');
    assert.deepStrictEqual(args.slice(at - 6, at), ['-protocol_whitelist', 'file,pipe', '-format_whitelist', lim.formats.join(','), '-t', '10800'], 'input options before -i');

    // ── The playlist and the concat list are refused, at the probe and by ffmpeg itself ──
    for (const evil of [hls, concat]) {
        await assert.rejects(jobContext.run(lim, () => runTool('convert', evil, { format: 'mp3' })),
            (e) => e.status === 415 && e.code === 'tools.file.unsupported_type' && e.guardReason === 'ffmpeg.format', `${path.basename(evil)}: refused before work starts`);
        // Even the tool's own ffmpeg command (no probe first) cannot open it.
        await assert.rejects(jobContext.run(lim, () => getTool('convert').handler(evil, { format: 'mp3' })), /whitelist|Invalid argument|Invalid data/i, `${path.basename(evil)}: ffmpeg refuses it`);
    }
    const ok = await jobContext.run(lim, () => runTool('convert', secret, { format: 'mp3' }));
    assert.strictEqual(ok.ext, 'mp3', 'a real WAV converts as before');
    fs.rmSync(ok.outputPath, { force: true });

    // ── Longer than the descriptor allows: refused before work starts ──
    await assert.rejects(jobContext.run({ ...lim, maxDurationSec: 1 }, () => runTool('convert', secret, { format: 'mp3' })),
        (e) => e.status === 413 && e.guardReason === 'ffmpeg.duration' && /2 seconds long; this tool takes at most 1 seconds/.test(e.message));

    // ── A synchronous run is killed at its deadline ──
    const long = path.join(data, 'long.wav');
    ff('-f', 'lavfi', '-i', 'sine=frequency=220:duration=600', '-ar', '44100', long);
    const res = Object.assign(new EventEmitter(), { writableFinished: false });
    const t0 = Date.now();
    await assert.rejects(runSync(res, 'reverb', long, {}, { timeoutMs: 150 }), (e) => e.status === 504 && e.code === 'tools.run.timeout' && e.guardReason === 'timeout');
    assert.ok(Date.now() - t0 < 5000, `stopped quickly (${Date.now() - t0} ms)`);
    // A client that goes away stops it too.
    const gone = Object.assign(new EventEmitter(), { writableFinished: false });
    const run = runSync(gone, 'reverb', long, {});
    setTimeout(() => gone.emit('close'), 150);
    await assert.rejects(run, (e) => e.code !== 'tools.run.timeout');

    // ── Through the app: sniffing turns the playlist away at the door ──
    const env = { DATA_DIR: data, UPLOADS_DIR: path.join(data, 'uploads'), OUTPUT_DIR: path.join(data, 'output') };
    const app = await startApp('audio', env);
    try {
        const ctx = await fetch(`${app.base}/api/context`);
        const cookie = String(ctx.headers.get('set-cookie') || '').split(';')[0];
        assert.match(cookie, /^ov_tools_jobs=/, 'the page\'s context call starts the session audio tools need');
        const post = (buf, name, type, tool = 'convert') => {
            const f = new FormData();
            f.append('file', new Blob([buf], { type }), name);
            f.append('tool', tool);
            f.append('format', 'mp3');
            return fetch(`${app.base}/api/process`, { method: 'POST', body: f, headers: { cookie } });
        };
        let r = await post(fs.readFileSync(hls), 'song.mp3', 'audio/mpeg');
        assert.strictEqual(r.status, 415);
        assert.strictEqual((await r.json()).code, 'tools.file.unsupported_type');
        r = await post(fs.readFileSync(secret), 'take.wav', 'application/octet-stream');
        const body = await r.json();
        assert.strictEqual(r.status, 200, JSON.stringify(body));
        assert.strictEqual(body.output.ext, 'mp3');
        // A job with the playlist is refused the same way.
        const f = new FormData();
        f.append('type', 'audio.process');
        f.append('input', JSON.stringify({ tool: 'convert', format: 'mp3' }));
        f.append('file', new Blob([fs.readFileSync(concat)], { type: 'audio/mpeg' }), 'list.mp3');
        r = await fetch(`${app.base}/api/v1/jobs`, { method: 'POST', body: f, headers: { cookie } });
        assert.strictEqual(r.status, 415);
    } finally {
        await app.kill();
        fs.rmSync(data, { recursive: true, force: true });
    }
    console.log('audio hardening: playlist and concat refused (sniffing, probe, ffmpeg whitelists), duration cap and -t, sync deadline and client-gone kill: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
