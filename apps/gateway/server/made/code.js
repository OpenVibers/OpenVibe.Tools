'use strict';
// ═══════════════════════════════════════════════════════════════
// A code tool's source and its entry (plan 2026-11-13 §AD.12 (c); the owner, 11-15: "allow users to submit their own
// and use code"). A maker writes one JavaScript function, run(input), that returns the answer. Two runtimes read it:
//
//   the page      the source runs in the visitor's browser, in a sandboxed frame with no network, no storage and no
//                 way to the page (public/js/make.js); free, and works for anyone today
//   a runner      tool.js, the source with a wrapper that reads the input as JSON on stdin and writes the answer as
//                 JSON on stdout: exactly what Link's skill runner (openvibe-skill-runner@1.0.0) runs as a Run
//                 function job, under Node's permission model in the job sandbox (no network by default)
//
// code.sha256 is tool.js's digest, so a runner can refuse any other bytes; GET /api/v1/made-tools/:id/code serves it.
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');

const MAX_SOURCE_BYTES = 64 * 1024;
const ENTRY = 'tool.js';

// The runner's wrapper: the input from stdin, run(input) (it may be async), the answer to stdout as one JSON value.
const WRAPPER = `
;(async () => {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8').trim();
    const answer = await run(text ? JSON.parse(text) : {});
    process.stdout.write(JSON.stringify(answer === undefined ? null : answer));
})().catch((err) => { process.stderr.write(String((err && err.stack) || err)); process.exitCode = 1; });
`;

/** The entry a runner gets: the maker's source, then the wrapper. */
function entryOf(source) {
    return `'use strict';\n// OpenVibe Tools: a tool people made. Its source, then the wrapper that reads the input and writes the answer.\n${source}\n${WRAPPER}`;
}

/** A maker's source, checked: text, at most 64 KiB, and a run function in it. → { source, entry, sha256, bytes } */
function checkSource(source) {
    if (typeof source !== 'string') return { error: 'source_code is the tool\'s JavaScript (a run(input) function)' };
    const text = source.replace(/\r\n?/g, '\n');
    if (!text.trim()) return { error: 'Write the tool\'s code: a run(input) function that returns the answer' };
    if (Buffer.byteLength(text) > MAX_SOURCE_BYTES) return { error: 'The code is at most 64 KB' };
    if (!/\b(function\s*\*?\s*run\s*\(|(const|let|var)\s+run\s*=|async\s+function\s+run\s*\()/.test(text)) return { error: 'The code needs a run(input) function: function run(input) { … return answer; }' };
    const entry = entryOf(text);
    return { source: text, entry, sha256: crypto.createHash('sha256').update(entry).digest('hex'), bytes: Buffer.byteLength(entry) };
}

const TEMPLATE = `// run(input) gets the inputs below and returns the answer (it may be async).
// It runs without a network: work with the input only.
function run(input) {
  const text = String(input.text || '');
  const words = text.trim().split(/\\s+/).filter(Boolean);
  return { words: words.length, characters: text.length };
}
`;

module.exports = { entryOf, checkSource, WRAPPER, ENTRY, MAX_SOURCE_BYTES, TEMPLATE };
