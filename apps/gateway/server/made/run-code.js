'use strict';
// ═══════════════════════════════════════════════════════════════
// Code tools on machines (plan 2026-11-13 §AD.13 (2); the owner, 11-15: "available both on local machine with link but
// also on our ov shared nodes and users can share theirs"). A made code tool runs as an OpenVibe.Run function job:
//
//   artifact openvibe-skill-runner@1.1.0 (OpenVibe.Link v0.70.0), args { tool, source, sha256, input }: the tool's entry
//   (made/code.js entryOf) travels in the job and the Link checks its digest before it writes or runs anything; the code
//   runs under Node's permission model (no files, no processes, no eval) in the Link's job sandbox, with no network
//   unless the tool asks for one (net: public | openvibe-only).
//
// Where (the tool's `hosting`): openvibe (the default) and shared run as OpenVibe's operator (TOOLS_RUN_SUBJECT in
// TOOLS_RUN_PROJECT, the way Run's own checks do): openvibe on OpenVibe's machines and the operator's own (first-party,
// user-owned), shared also on machines people lend (community). mine waits for a person's own project (the person as
// the job's requester, so placement keeps their machines theirs) and says so.
//
// The run waits for the job (polled, at most `waitMs`) and answers like a prompt run: { data } or { text }. Errors carry
// a status and a code for tools.run@1.
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');

const ARTIFACT = { name: 'openvibe-skill-runner', version: '1.1.0' };
const SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const PROJECT = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;
const ENDED = new Set(['succeeded', 'failed', 'expired', 'cancelled']);

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
/** The runner's tool name: the slug, with underscores (^[a-z][a-z0-9_]{0,31}$). */
const toolName = (slug) => String(slug || 'tool').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^[^a-z]+/, '').slice(0, 32) || 'tool';
const egressOf = (net) => (net === 'public' ? 'public' : net === 'openvibe-only' ? 'openvibe-only' : 'none');
const trustOf = (hosting) => (hosting === 'shared' ? ['first-party', 'user-owned', 'community'] : ['first-party', 'user-owned']);

function createCodeRunner({ runUrl, tokens = null, subject = '', project = '', fetchImpl = globalThis.fetch, pollMs = 400, waitMs = 60_000, wallMs = 30_000 } = {}) {
    const enabled = !!(runUrl && tokens && SUBJECT.test(String(subject)) && PROJECT.test(String(project)));
    const base = String(runUrl || '').replace(/\/+$/, '');

    async function call(method, path, body, signal) {
        const headers = { Accept: 'application/json', 'X-OV-Subject': subject, 'X-OV-Project': project, ...(await tokens.authHeaders()) };
        if (body) headers['Content-Type'] = 'application/json';
        const res = await fetchImpl(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
        const out = await res.json().catch(() => null);
        if (!res.ok) throw fail(res.status >= 500 ? 502 : res.status, (out && out.code) || 'tools.made.run_refused', (out && (out.detail || out.title)) || `OpenVibe.Run answered ${res.status}`);
        return out;
    }

    /** One run of a made code tool (the row's code_text) on a machine; resolves { data } or { text }, or throws. */
    async function run(tool, codeText, input, { signal = null } = {}) {
        if (!enabled) throw fail(501, 'tools.made.code_not_ready', 'Code tools run on machines once OpenVibe.Run is set up here');
        if (tool.hosting === 'mine') throw fail(501, 'tools.made.mine_not_ready', 'Running on your own machine comes with your own project; this tool runs on OpenVibe\'s machines when its hosting is openvibe');
        const { entryOf } = require('./code');
        const source = entryOf(codeText);
        const sha256 = crypto.createHash('sha256').update(source).digest('hex');
        if (tool.code && tool.code.sha256 && tool.code.sha256 !== sha256) throw fail(409, 'tools.made.code_changed', 'The tool\'s code does not match its digest: save it again');
        const job = {
            class: 'function', artifact: ARTIFACT,
            args: { tool: toolName(tool.slug), source, sha256, input: input === undefined ? {} : input },
            limits: { wall_ms: wallMs, cpu_ms: wallMs, mem_bytes: 256 * 1024 * 1024 },
            ttl_ms: Math.max(60_000, waitMs + wallMs),
            egress: egressOf(tool.net),
            requirements: { kind: 'tools.made.code', mobility: 'job', latency_class: 'interactive', objective: 'balanced', trust: trustOf(tool.hosting) },
            idempotency_key: `made:${tool.id}:${crypto.randomBytes(9).toString('base64url')}`,
        };
        const made = await call('POST', '/api/v1/jobs', job, signal);
        const id = made && made.job && made.job.id;
        if (!id) throw fail(502, 'tools.made.run_refused', 'OpenVibe.Run did not take the run');
        const until = Date.now() + waitMs;
        let j = made.job;
        while (!ENDED.has(j.state)) {
            if (Date.now() > until) throw fail(504, 'tools.made.too_slow', j.state === 'queued' ? 'No machine took the run in time' : 'The run took too long');
            await new Promise((ok) => setTimeout(ok, pollMs));
            if (signal && signal.aborted) throw fail(499, 'tools.made.cancelled', 'The run was cancelled');
            j = ((await call('GET', `/api/v1/jobs/${encodeURIComponent(id)}`, null, signal)) || {}).job || j;
        }
        if (j.state !== 'succeeded') throw fail(502, 'tools.made.machine_failed', j.state === 'expired' ? 'No machine that runs code tools was free' : `The run ${j.state} on its machine`);
        const r = j.result || {};
        if (!r.ok) throw fail(422, 'tools.made.code_failed', `The code failed: ${String(r.error || 'no answer')}${r.stderr ? ` (${String(r.stderr).slice(0, 300)})` : ''}`);
        const out = r.output;
        if (tool.output && tool.output.kind === 'text') return { text: typeof out === 'string' ? out : JSON.stringify(out), job: id };
        return { data: out, job: id };
    }

    return { enabled, run };
}

module.exports = { createCodeRunner, toolName, ARTIFACT };
