'use strict';

// ═══════════════════════════════════════════════════════════════
// Docs.OpenVibe — one document operation, shared by the synchronous endpoints
// (/api/process, /api/process/multi) and the docs.process job (see defineJobs).
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { getTool, listTools } = require('./tools');

const SINGLE_KEYS = ['format', 'quality', 'angle', 'pages', 'order', 'ranges', 'mode',
    'text', 'fontSize', 'opacity', 'rotation', 'color',
    'pageSize', 'dpi', 'password', 'userPassword', 'ownerPassword',
    'title', 'author', 'subject', 'keywords', 'creator',
    'level', 'defaultFormat'];
const MULTI_KEYS = ['order', 'pageSize', 'quality', 'format'];

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
    };
}

/** Job type docs.process: input { tool, …options } + one PDF, or several files for merge / img2pdf. */
function defineJobs(system) {
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
            const result = await tool.handler(tool.multiFile ? buffers : buffers[0], buildOptions(input, null, tool.multiFile));
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

module.exports = { buildOptions, describe, defineJobs, SINGLE_KEYS, MULTI_KEYS };
