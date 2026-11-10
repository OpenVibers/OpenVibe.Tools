'use strict';
// Only local byte transforms are advertised. No caller token, URL, path or executable is accepted.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { MAX_BYTES, TYPES, bytes } = require('./protocol');
const { detect } = require('../../_shared/guard/sniff');
const { poolFromEnv } = require('../../_shared/jobs/pool');
function definitions() {
    const defs = new Map(), pools = [], tools = [];
    const hasAudio = ['ffmpeg', 'ffprobe'].every(bin => require('node:child_process').spawnSync(bin, ['-version'], { stdio: 'ignore', timeout: 3000 }).status === 0);
    for (const app of ['img', 'docs', 'audio']) {
        try {
            if (app === 'audio' && !hasAudio) continue;
            const catalog = require(`../../${app}/server/tools`);
            tools.push(...catalog.listTools().filter(t => t.available !== false).map(t => `${app}.process:${t.id}`));
            const process = require(`../../${app}/server/process`);
            const pool = app === 'audio' ? null : poolFromEnv(app, path.resolve(__dirname, `../../${app}/server/worker.js`), { size: 1, maxQueue: 0 });
            if (pool) pools.push(pool);
            process.defineJobs({ define: def => defs.set(def.type, def), JobError: Error }, pool);
        } catch { /* A missing dependency removes this capability, rather than accepting work it cannot run. */ }
    }
    return { defs, tools, close: () => Promise.all(pools.map(p => p.close())) };
}
function createRuntime({ slots = 2, dry = false, registry = definitions(), root = os.tmpdir() } = {}) {
    if (!Number.isInteger(slots) || slots < 1 || slots > 8) throw new Error('slots must be 1..8');
    const active = new Map();
    function status() { return { tools: dry ? [] : (registry.tools || []), capabilities: dry ? [] : [...registry.defs.keys()].filter(k => TYPES.includes(k)), slots, free: dry ? 0 : slots - active.size, load: os.loadavg()[0], dry }; }
    async function run(job) {
        const def = registry.defs.get(job.type);
        if (dry || !TYPES.includes(job.type) || !def || active.size >= slots || active.has(job.id) || !/^[a-f0-9]{32}$/.test(job.id || '')) throw new Error('job refused');
        if (!job.input || typeof job.input !== 'object' || Array.isArray(job.input) || JSON.stringify(job.input).length > 65536) throw new Error('invalid input');
        if (!Array.isArray(job.files) || job.files.length < def.minFiles || job.files.length > def.maxFiles) throw new Error('invalid files');
        const ctrl = new AbortController();
        active.set(job.id, ctrl);
        let dir, result;
        const timer = setTimeout(() => ctrl.abort(), def.timeoutMs);
        try {
            dir = await fs.mkdtemp(path.join(root, 'ov-tools-job-'));
            const outDir = path.join(dir, 'out');
            await fs.mkdir(outDir);
            let total = 0;
            const files = [];
            for (const f of job.files) {
                const b = bytes(f); total += b.length;
                if (total > MAX_BYTES) throw new Error('job exceeds worker transfer limit');
                const detected = detect(b);
                const allowed = job.type === 'img.process' ? /^image\// : job.type === 'docs.process' ? /^(application\/pdf|image\/)/ : /^(audio|video)\//;
                // SVG can contain external resource references. Keep it on the host.
                if (!detected || !allowed.test(detected.mime) || detected.mime === 'image/svg+xml') throw new Error('unsupported file');
                const local = path.join(dir, `${files.length}.${detected.ext}`);
                await fs.writeFile(local, b, { mode: 0o600 });
                files.push({ path: local, name: `${files.length}.${detected.ext}`, mime: detected.mime, size: b.length });
            }
            const invalid = def.validate(job.input, files);
            if (invalid) throw new Error('invalid tool options');
            if (ctrl.signal.aborted) throw new Error('cancelled');
            result = await def.run({ input: job.input, files, outDir, signal: ctrl.signal, progress() {} });
            if (ctrl.signal.aborted) throw new Error('cancelled');
            const output = [];
            total = 0;
            for (const f of result.files || []) {
                const size = (await fs.stat(f.path)).size; total += size;
                if (total > MAX_BYTES) throw new Error('result exceeds worker transfer limit');
                output.push({ name: path.basename(f.name), mime: f.mime, bytes: (await fs.readFile(f.path)).toString('base64') });
            }
            return { files: output, data: result.data || {} };
        } finally {
            clearTimeout(timer);
            active.delete(job.id);
            // Audio tools write into their own configured temp directory.
            for (const f of result?.files || []) await fs.rm(f.path, { force: true }).catch(() => {});
            if (dir) await fs.rm(dir, { recursive: true, force: true });
        }
    }
    return { status, run, cancel: id => active.get(id)?.abort(), cancelAll: () => { for (const c of active.values()) c.abort(); }, close: async () => { for (const c of active.values()) c.abort(); await registry.close(); } };
}
module.exports = { createRuntime, definitions };
