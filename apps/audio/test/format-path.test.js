'use strict';
/**
 * The output format becomes a temp file's extension, so it can never name a path: tmpFile() takes only a short
 * alphanumeric extension and stays inside tmpDir, and the audio.process job refuses any other format at submit.
 * (Security review 2026-10-10: `format: "../../x"` through POST /api/v1/jobs wrote outside the temp directory.)
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-audio-format-'));
const { tmpFile, tmpDir } = require('../server/tools/ffmpeg-helper');
const { defineJobs } = require('../server/process');

assert.strictEqual(path.dirname(tmpFile('mp3')), tmpDir);
assert.ok(tmpFile('FLAC').endsWith('.flac'));
for (const bad of ['../../etc/x', '../x', 'mp3/../../x', 'a.b', '', 'x'.repeat(9), '..', 'm p3']) {
    assert.throws(() => tmpFile(bad), (e) => e.status === 400 && e.code === 'tools.bad_format', `${JSON.stringify(bad)} is refused`);
}

let job = null;
defineJobs({ define: (d) => { job = d; } });
const file = [{ path: '/tmp/a.mp3', name: 'a.mp3', size: 1 }];
assert.strictEqual(job.validate({ tool: 'convert', format: 'wav' }, file), null);
assert.match(job.validate({ tool: 'convert', format: '../../x' }, file) || '', /format must be a short audio format name/);
assert.match(job.validate({ tool: 'extract', format: 'mp3/../../../tmp/pwned' }, file) || '', /format must be/);

fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
console.log('audio format path: only short alphanumeric formats, inside the temp directory');
