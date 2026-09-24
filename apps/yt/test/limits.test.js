'use strict';
// YT limits: maxDuration and the file size cap are enforced (they were configured but never checked),
// and /api/info runs at most N yt-dlp lookups at once with a per-video cache. yt-dlp is a stand-in
// script here: nothing reaches YouTube.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.YT_MAX_DURATION = '600';        // 10 minutes, before config is loaded
process.env.YT_MAX_FILESIZE_MB = '1';
process.env.YT_INFO_CONCURRENCY = '3';
const downloader = require('../server/downloader');
const { startApp } = require('../../_shared/test/spawn');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    // ── Video ids ──
    const id = downloader.videoId;
    assert.strictEqual(id('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10'), 'dQw4w9WgXcQ');
    assert.strictEqual(id('https://youtu.be/dQw4w9WgXcQ?si=x'), 'dQw4w9WgXcQ');
    assert.strictEqual(id('https://www.youtube.com/shorts/abcDEF12345'), 'abcDEF12345');
    assert.strictEqual(id('https://www.youtube.com/'), null);

    // ── Progress lines: over the length or the size limit sets the error before the file is done ──
    let e = { _weights: [1], _part: 0, progress: null };
    downloader.applyLine(e, 'OVD|601|False');
    assert.match(e.limitError, /10 minutes long; downloads are limited to 10 minutes/);
    e = { _weights: [1], _part: 0, progress: null };
    downloader.applyLine(e, 'OVD|NA|True');
    assert.match(e.limitError, /live stream/);
    e = { _weights: [1], _part: 0, progress: null };
    downloader.applyLine(e, 'OVD|120|False');
    assert.strictEqual(e.limitError, undefined);
    downloader.applyLine(e, `OVP| 50.0%|1MiB/s|00:01|${2 * 1024 * 1024}`);
    assert.match(e.limitError, /larger than 1 MB/);
    e = { _weights: [1], _part: 0, progress: null };
    downloader.applyLine(e, 'OVP| 50.0%|1MiB/s|00:01');   // the old four-field line still parses
    assert.strictEqual(e.progress, 50);

    // ── Info: at most 3 yt-dlp runs at once, one per video id, cached ──
    let running = 0, peak = 0, runs = 0;
    const run = async (url) => { runs++; running++; peak = Math.max(peak, running); await sleep(30); running--; return { id: downloader.videoId(url), duration: 60, downloadable: true }; };
    const urls = Array.from({ length: 8 }, (_, i) => `https://www.youtube.com/watch?v=video${String(i).padStart(6, '0')}`);
    await Promise.all([...urls, ...urls].map(u => downloader.getInfoLimited(u, { run })));
    assert.strictEqual(peak, 3, 'never more than three lookups at once');
    assert.strictEqual(runs, 8, 'the same video is looked up once even when asked twice at the same time');
    await downloader.getInfoLimited(urls[0], { run });
    assert.strictEqual(runs, 8, 'cached');
    // A full queue answers 503 instead of piling up processes.
    const slow = () => new Promise(r => setTimeout(() => r({ duration: 1 }), 200));
    const flood = Array.from({ length: 30 }, (_, i) => downloader.getInfoLimited(`https://youtu.be/flood${String(i).padStart(6, '0')}`, { run: slow }).then(() => 'ok', err => err.status));
    const outcomes = await Promise.all(flood);
    assert.strictEqual(outcomes.filter(o => o === 'ok').length, 23, '3 running + 20 queued');
    assert.strictEqual(outcomes.filter(o => o === 503).length, 7);

    // ── As a real process with a stand-in yt-dlp ──
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-yt-'));
    const fake = path.join(data, 'yt-dlp');
    fs.writeFileSync(fake, `#!${process.execPath}
const args = process.argv.slice(2);
const url = args[args.length - 1];
const long = url.includes('LONGLONG123');
if (args.includes('--dump-json')) {
    process.stdout.write(JSON.stringify({ id: long ? 'LONGLONG123' : 'SHORTxx1234', title: 't', duration: long ? 4000 : 30, formats: [{ vcodec: 'avc1', acodec: 'mp4a' }] }));
    process.exit(0);
}
const i = args.indexOf('--match-filter');
require('fs').writeFileSync(${JSON.stringify(path.join(data, 'args.json'))}, JSON.stringify(args));
process.stdout.write('OVD|' + (long ? 4000 : 30) + '|False\\n');
process.exit(0);   // the match filter skipped it: no file
`, { mode: 0o755 });
    const app = await startApp('yt', { DATA_DIR: data, DOWNLOADS_DIR: path.join(data, 'downloads'), YTDLP_PATH: fake, YT_MAX_DURATION: '600', YT_MAX_FILESIZE_MB: '100' });
    try {
        const post = (p, body) => fetch(`${app.base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        let r = await post('/api/info', { url: 'https://www.youtube.com/watch?v=LONGLONG123' });
        let body = await r.json();
        assert.strictEqual(r.status, 200);
        assert.strictEqual(body.video.downloadable, false);
        assert.match(body.video.reason, /67 minutes long; downloads are limited to 10 minutes/);
        assert.deepStrictEqual(body.video.limits, { maxDuration: 600, maxFilesizeMB: 100 });
        r = await post('/api/download', { url: 'https://youtu.be/LONGLONG123', quality: 'best' });
        assert.strictEqual(r.status, 422, 'refused from the cached info, before yt-dlp starts');
        assert.match((await r.json()).error, /limited to 10 minutes/);
        assert.ok(!fs.existsSync(path.join(data, 'args.json')), 'no download was started');

        // Without cached info, yt-dlp gets the filter and the size cap, and the skip is explained.
        r = await post('/api/download', { url: 'https://www.youtube.com/watch?v=SHORTxx1234', quality: 'best' });
        body = await r.json();
        assert.strictEqual(r.status, 200, JSON.stringify(body));
        // The download belongs to the browser session the start minted: only it sees the status.
        const cookie = String(r.headers.get('set-cookie') || '').split(';')[0];
        assert.match(cookie, /^ov_tools_jobs=/, 'starting a download starts a session');
        assert.strictEqual((await fetch(`${app.base}/api/status/${body.id}`)).status, 404, 'someone else gets 404');
        assert.strictEqual((await fetch(`${app.base}/api/status/${body.id}/stream`)).status, 404);
        assert.strictEqual((await fetch(`${app.base}/api/download/${body.id}`, { method: 'DELETE' })).status, 404, 'and cannot cancel it');
        let st;
        for (let i = 0; i < 50; i++) { st = await (await fetch(`${app.base}/api/status/${body.id}`, { headers: { cookie } })).json(); if (st.status !== 'downloading') break; await sleep(50); }
        const args = JSON.parse(fs.readFileSync(path.join(data, 'args.json'), 'utf8'));
        assert.strictEqual(args[args.indexOf('--match-filter') + 1], 'duration<=600 & !is_live');
        assert.strictEqual(args[args.indexOf('--max-filesize') + 1], '100M');
        assert.ok(args.includes('pre_process:OVD|%(duration)s|%(is_live)s'));
        assert.strictEqual(st.status, 'error');
        assert.match(st.error, /over the limits here: at most 10 minutes long and 100 MB per file/);
        const health = await (await fetch(`${app.base}/api/health`)).json();
        assert.deepStrictEqual(health.limits, { maxDuration: 600, maxFilesizeMB: 100 });
    } finally {
        await app.kill();
        fs.rmSync(data, { recursive: true, force: true });
    }
    console.log('yt limits (duration, file size, info concurrency + cache): all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
