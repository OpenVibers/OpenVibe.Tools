'use strict';

// ═══════════════════════════════════════════════════════════════
// Audio.OpenVibe — one audio operation, shared by the synchronous endpoint (/api/process) and the
// audio.process job (defineJobs below).
//
// Jobs can be cancelled and report progress although the tools build their own ffmpeg commands:
// FfmpegCommand#run is wrapped once, and a command started inside a job's AsyncLocalStorage
// context reports ffmpeg's percent to the job and is killed when the job's signal aborts. The
// synchronous endpoint runs in the same kind of context (runSync): a deadline (the descriptor's
// limits.timeoutMs) and a client that goes away abort it, and ffmpeg is killed.
//
// Hardening (apps/_shared/guard/ffmpeg.js, in both paths): every input of every command and every
// probe reads only local files and pipes, only through the operation's demuxers (never hls, concat,
// image2, lavfi…), and at most limits.maxDurationSec of it; inputs are probed first and a longer one
// is refused before any work starts.
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const ffmpeg = require('fluent-ffmpeg');
const { getTool, listTools } = require('./tools');
const { probe } = require('./tools/ffmpeg-helper');
const hardening = require('../../_shared/guard/ffmpeg');
const { SPECS } = require('./descriptors');

const jobContext = new AsyncLocalStorage();
const RESERVED = new Set(['tool', 'file', 'files']);

/** An operation's limits from its descriptor (every audio tool on one operation has the same). */
const LIMITS = new Map();
for (const s of SPECS) if (!LIMITS.has(s.job.operation)) LIMITS.set(s.job.operation, s.limits);
function limitsFor(op) {
    const l = LIMITS.get(op) || LIMITS.get('convert') || {};
    return { formats: hardening.formatsFor(op), maxDurationSec: l.maxDurationSec || null, timeoutMs: l.timeoutMs || 15 * 60 * 1000 };
}

// Every command and probe: the whitelists and the duration cap of the operation running (a command
// outside any context gets the widest audio list).
hardening.harden(ffmpeg, () => jobContext.getStore() || { formats: hardening.formatsFor('extract') });

const proto = ffmpeg.prototype;
if (!proto.__ovJobs) {
    const run = proto.run;
    proto.run = function runInJob(...args) {
        const job = jobContext.getStore();
        if (job && job.signal) {
            const kill = () => {
                if (this.ffmpegProc) { try { this.ffmpegProc.kill('SIGKILL'); } catch { /* already gone */ } } else this.once('start', () => { try { this.ffmpegProc.kill('SIGKILL'); } catch { /* gone */ } });
            };
            if (job.signal.aborted) kill(); else job.signal.addEventListener('abort', kill, { once: true });
            if (job.progress) this.on('progress', (p) => { if (p && Number.isFinite(p.percent)) job.progress(10 + Math.min(100, Math.max(0, p.percent)) * 0.8, 'Encoding'); });
        }
        return run.apply(this, args);
    };
    proto.__ovJobs = true;
}

/** Tool options from a request body or a job input, with the host's forced format. */
function buildOptions(src, toolId, ctx) {
    const options = {};
    for (const [k, v] of Object.entries(src || {})) if (!RESERVED.has(k)) options[k] = v;
    if (ctx && ctx.defaultFormat && toolId === 'convert') options.format = ctx.defaultFormat;
    return options;
}

/** The JSON the synchronous endpoint has always answered with, minus the download block. */
function describe(toolId, result, size, inputSize) {
    return {
        tool: toolId,
        output: { mime: result.mime, ext: result.ext, size, sizeKB: Math.round(size / 1024 * 10) / 10, duration: result.duration || null },
        input: { size: inputSize, sizeKB: Math.round(inputSize / 1024 * 10) / 10 },
        ...(result.metadata && { metadata: result.metadata }),
        ...(result.preset && { preset: result.preset }),
    };
}

/** Probe the inputs (hardened) and run the tool inside the current context. */
async function runTool(toolId, arg, options) {
    const tool = getTool(toolId);
    const lim = jobContext.getStore() || limitsFor(toolId);
    await hardening.probeInputs(probe, Array.isArray(arg) ? arg : [arg], lim);
    return tool.handler(arg, options);
}

/**
 * The synchronous endpoint's run: the job context without a job — hardened, killed at the
 * descriptor's timeout (504 tools.run.timeout) or when the client goes away.
 */
async function runSync(res, toolId, arg, options, override = {}) {
    const lim = { ...limitsFor(toolId), ...override };
    const ctrl = new AbortController();
    let why = null;
    const timer = setTimeout(() => { why = 'timeout'; ctrl.abort(); }, lim.timeoutMs);
    const gone = () => { if (!res.writableFinished && !why) { why = 'client'; ctrl.abort(); } };
    res.on('close', gone);
    try {
        return await jobContext.run({ signal: ctrl.signal, progress: () => {}, ...lim }, () => runTool(toolId, arg, options));
    } catch (err) {
        if (why === 'timeout') {
            throw Object.assign(new Error(`This took longer than ${Math.round(lim.timeoutMs / 60000)} minutes and was stopped.`), { status: 504, code: 'tools.run.timeout', guardReason: 'timeout', expose: true });
        }
        throw err;
    } finally {
        clearTimeout(timer);
        res.removeListener('close', gone);
    }
}

/** Job type audio.process: input { tool, …options } + one audio or video file (2–5 for merge). */
function defineJobs(system) {
    const known = new Set(listTools().map(t => t.id));
    system.define({
        type: 'audio.process',
        version: 1,
        minFiles: 1,
        maxFiles: Math.max(...listTools().map(t => t.maxFiles || 1)),
        maxAttempts: 2,
        onRestart: 'requeue',          // ffmpeg over the stored input: safe to run again
        timeoutMs: 15 * 60 * 1000,
        validate(input, files) {
            const id = String(input.tool || 'convert');
            if (!known.has(id)) return `Unknown tool: ${id}`;
            const tool = getTool(id);
            if (tool.multiFile) {
                if (files.length < tool.minFiles || files.length > tool.maxFiles) return `${tool.label} takes ${tool.minFiles} to ${tool.maxFiles} files (in "files")`;
            } else if (files.length !== 1) {
                return `Tool "${id}" takes exactly one file`;
            }
            for (const [k, v] of Object.entries(input)) if (v != null && typeof v === 'object') return `Option ${k} must be a string or a number`;
            return null;
        },
        async run({ input, files, progress, signal }) {
            const toolId = String(input.tool || 'convert');
            const tool = getTool(toolId);
            const src = files[0];
            progress(5, files.length > 1 ? `Reading ${files.length} files` : 'Reading the audio');
            const arg = tool.multiFile ? files.map(f => f.path) : src.path;
            const result = await jobContext.run({ signal, progress, ...limitsFor(toolId) }, () => runTool(toolId, arg, buildOptions(input, toolId, null)));
            if (signal.aborted) { fs.rm(result.outputPath, { force: true }, () => {}); throw new Error('cancelled'); }
            const size = fs.statSync(result.outputPath).size;
            const base = path.basename(src.name || 'audio', path.extname(src.name || '')) || 'openvibeaudio-output';
            const inputSize = files.reduce((n, f) => n + (f.size || 0), 0);
            return {
                files: [{ path: result.outputPath, name: `${base}${tool.multiFile ? '-merged' : ''}.${result.ext}`, mime: result.mime }],
                data: { ...describe(toolId, result, size, inputSize), ...(tool.multiFile && { fileCount: files.length }) },
            };
        },
    });
}

module.exports = { buildOptions, describe, defineJobs, jobContext, runSync, runTool, limitsFor };
