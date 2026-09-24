'use strict';

// ═══════════════════════════════════════════════════════════════
// Docs.OpenVibe — one document operation, shared by the synchronous endpoints
// (/api/process, /api/process/multi, /api/info) and the docs.process job (see defineJobs). Both run
// it through runTool(): pdf-lib work goes to the worker pool (./worker.js), so the two share one
// concurrency cap, one heap limit and terminate-on-timeout or cancel.
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { getTool, listTools, assertAvailable } = require('./tools');

const SINGLE_KEYS = ['format', 'quality', 'angle', 'pages', 'order', 'ranges', 'mode',
    'text', 'fontSize', 'opacity', 'rotation', 'color',
    'pageSize', 'dpi', 'password', 'userPassword', 'ownerPassword', 'allowPrint', 'allowCopy',
    'title', 'author', 'subject', 'keywords', 'creator',
    'level', 'defaultFormat'];
const MULTI_KEYS = ['order', 'pageSize', 'quality', 'format'];

/**
 * Run a tool: in the worker pool when it is pdf-lib work, on this thread when it shells out to qpdf
 * or poppler (their child processes have their own timeouts). Without a pool (tests), inline.
 * @param {object|null} pool     apps/_shared/jobs/pool.js
 * @param {object} tool          tools/index.js entry
 * @param {Buffer|Buffer[]} input
 * @param {object} options
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [opts]
 */
function runTool(pool, tool, input, options, opts = {}) {
    if (!pool || (tool.requires && tool.requires.length)) return tool.handler(input, options);
    return pool.run('process', { tool: tool.id, input, options }, { ...opts, transfer: true });
}

/** Tool options from a request body or a job input. */
function buildOptions(src, ctx, multi) {
    const options = {};
    for (const key of multi ? MULTI_KEYS : SINGLE_KEYS) if (src[key] !== undefined) options[key] = src[key];
    if (!multi && ctx && ctx.defaultFormat && !options.format) options.defaultFormat = ctx.defaultFormat;
    return options;
}

/** The JSON the synchronous endpoints have always answered with, minus the download block. */
function describe(toolId, result, fileCount) {
    if (result.viewOnly) { const { buffer, ...rest } = result; return { tool: toolId, ...rest }; }
    return {
        tool: toolId,
        output: { mime: result.mime, ext: result.ext, size: result.buffer.length, sizeKB: Math.round(result.buffer.length / 1024 * 10) / 10 },
        ...(fileCount != null && { fileCount }),
        ...(result.pageCount !== undefined && { pageCount: result.pageCount }),
        ...(result.savings && { savings: result.savings }),
        ...(result.metadata && { metadata: result.metadata }),
        ...(result.note && { note: result.note }),
        ...(result.parts && { parts: result.parts }),
        ...(result.pages && { pages: result.pages }),
        ...(result.encryption && { encryption: result.encryption }),
    };
}

/** Job type docs.process: input { tool, …options } + one PDF, or several files for merge / img2pdf. */
function defineJobs(system, pool = null) {
    const known = new Set(listTools().map(t => t.id));
    system.define({
        type: 'docs.process',
        version: 1,
        minFiles: 1,
        maxFiles: 50,
        maxAttempts: 3,
        onRestart: 'requeue',          // a pure function of the stored input: safe to run again
        timeoutMs: 10 * 60 * 1000,
        validate(input, files) {
            const id = String(input.tool || '');
            if (!known.has(id)) return id ? `Unknown tool: ${id}` : 'No tool specified.';
            const tool = getTool(id);
            // A tool whose command-line tools are not installed yet: 503 now, not a failed job later.
            try { assertAvailable(tool); } catch (err) { throw new system.JobError(err.status, err.code, err.message, { tool: id }); }
            if (!tool.multiFile && files.length !== 1) return `Tool "${id}" takes exactly one file`;
            if (id === 'merge' && files.length < 2) return 'Upload at least 2 files to merge.';
            for (const k of Object.keys(input)) if (k !== 'tool' && !SINGLE_KEYS.includes(k)) return `Unknown option: ${k}`;
            return null;
        },
        async run({ input, files, outDir, progress, signal }) {
            const toolId = String(input.tool);
            const tool = getTool(toolId);
            progress(5, files.length > 1 ? `Reading ${files.length} files` : 'Reading the document');
            const buffers = [];
            for (const f of files) buffers.push(await fsp.readFile(f.path));
            if (signal.aborted) throw new Error('cancelled');
            progress(20, 'Processing');
            // Cancel and the job's timeout abort `signal`: a worker is terminated at once.
            const result = await runTool(pool, tool, tool.multiFile ? buffers : buffers[0], buildOptions(input, null, tool.multiFile), { signal });
            if (result.viewOnly) return { files: [], data: describe(toolId, result) };
            progress(90, 'Saving');
            const first = files[0].name || 'document';
            const name = `${path.basename(first, path.extname(first)) || 'openvibedocs-output'}.${result.ext}`;
            const out = path.join(outDir, `result.${result.ext}`);
            fs.writeFileSync(out, result.buffer);
            return { files: [{ path: out, name, mime: result.mime }], data: describe(toolId, result, tool.multiFile ? files.length : undefined) };
        },
    });
}

module.exports = { buildOptions, describe, defineJobs, runTool, SINGLE_KEYS, MULTI_KEYS };
