'use strict';

// ═══════════════════════════════════════════════════════════════
// Img.OpenVibe — one image operation, shared by the synchronous endpoints
// (/api/process, /api/process/direct) and the img.process job (server/jobs.js).
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { getTool, listTools } = require('./tools');

// defaultFormat: the output format when the caller names none (a format tool's own, e.g. png for
// png.openvibe.tools; its descriptor's run.job.preset). An explicit format always wins, as on the page.
const OPTION_KEYS = ['format', 'defaultFormat', 'quality', 'width', 'height', 'percentage', 'fit', 'background', 'left', 'top', 'aspect'];

/** Tool options from a request body or a job input, with the host's defaults. */
function buildOptions(src, ctx, inputMime) {
    const options = {};
    for (const k of OPTION_KEYS) options[k] = src[k] != null && src[k] !== '' ? src[k] : undefined;
    if (!options.format) options.format = options.defaultFormat || (ctx && ctx.defaultFormat) || undefined;
    delete options.defaultFormat;
    options.inputFormat = String(inputMime || '').split('/')[1];
    return options;
}

/** The JSON the synchronous endpoint has always answered with, minus the download block. */
function describe(toolId, result) {
    return {
        tool: toolId,
        output: { mime: result.mime, ext: result.ext, size: result.buffer.length, sizeKB: Math.round(result.buffer.length / 1024 * 10) / 10 },
        ...(result.savings && { savings: result.savings }),
        ...(result.dimensions && { dimensions: result.dimensions }),
        ...(result.crop && { crop: result.crop }),
    };
}

async function processBuffer(buffer, toolId, options) {
    const tool = getTool(toolId);
    if (!tool) throw Object.assign(new Error(`Unknown tool: ${toolId}`), { code: 'tools.job.invalid', status: 400 });
    return tool.handler(buffer, options);
}

/** Job type img.process: input { tool, format?, quality?, width?, … } + one image file. */
function defineJobs(system) {
    const known = new Set(listTools().map(t => t.id));
    system.define({
        type: 'img.process',
        version: 1,
        minFiles: 1,
        maxFiles: 1,
        maxAttempts: 3,
        onRestart: 'requeue',          // a pure function of the stored input: safe to run again
        timeoutMs: 5 * 60 * 1000,
        validate(input) {
            if (!known.has(String(input.tool || 'convert'))) return `Unknown tool: ${input.tool}. Known: ${[...known].join(', ')}`;
            for (const k of Object.keys(input)) if (k !== 'tool' && !OPTION_KEYS.includes(k)) return `Unknown option: ${k}`;
            return null;
        },
        async run({ input, files, outDir, progress, signal }) {
            const toolId = String(input.tool || 'convert');
            const src = files[0];
            progress(5, 'Reading the image');
            const buffer = await fsp.readFile(src.path);
            if (signal.aborted) throw new Error('cancelled');
            progress(20, 'Processing');
            const result = await processBuffer(buffer, toolId, buildOptions(input, null, src.mime));
            progress(90, 'Saving');
            const base = path.basename(src.name || 'image', path.extname(src.name || '')) || 'openvibeimg-output';
            const name = `${base}.${result.ext}`;
            const out = path.join(outDir, `result.${result.ext}`);
            fs.writeFileSync(out, result.buffer);
            return { files: [{ path: out, name, mime: result.mime }], data: describe(toolId, result) };
        },
    });
}

module.exports = { buildOptions, describe, processBuffer, defineJobs, OPTION_KEYS };
