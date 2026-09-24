'use strict';
// ═══════════════════════════════════════════════════════════════
// A worker_threads pool for the CPU-bound tools (pdf-lib in docs, sharp in img): the work leaves the
// event loop, so /api/health, the job routes and every other request stay responsive while a large
// merge or conversion runs, and each run is bounded.
//
//   const pool = createPool({ name: 'docs', module: require.resolve('./worker'), size: 2, memoryMb: 512 });
//   const out = await pool.run('process', { tool, input, options }, { timeoutMs, signal, transfer: true });
//
// `module` exports async functions (op → fn(payload)); each worker thread requires it once. At most
// `size` runs at once (the concurrency cap every caller shares: jobs and the synchronous endpoints
// alike); more wait in order, up to `maxQueue`, beyond which run() refuses at once (503 tools.busy,
// Retry-After). Each worker has V8 resourceLimits (`memoryMb` old generation): a run that needs more
// fails with 413 tools.input.too_large and its worker is replaced; nothing else is affected. A run
// past its `timeoutMs`, or whose `signal` aborts (a cancelled job, a client that went away), has its
// worker terminated at once — pdf-lib and sharp cannot be interrupted any other way — and fails with
// 504 tools.run.timeout or tools.job.cancelled. Workers are started on demand and stopped after
// `idleMs` without work, so an idle satellite holds no extra heap.
//
// Buffers cross by copy, or by transfer when asked (transfer: true moves the payload's own
// ArrayBuffers; results always come back transferred) — never a pooled Buffer's shared slab. A
// Uint8Array in the result comes back as a Buffer.
//
// Errors a tool throws keep what the HTTP and job layers read: message, status, code, expose,
// retryable, guardReason, detail, extra.
//
// Environment (read by poolFromEnv): TOOLS_WORKERS (default 2), TOOLS_WORKERS_<APP>,
// TOOLS_WORKER_MEMORY_MB (default 512), TOOLS_WORKER_MEMORY_MB_<APP>, TOOLS_WORKER_QUEUE (default 64),
// TOOLS_WORKER_IDLE_MS (default 60000).
// No dependencies (node:worker_threads).
// ═══════════════════════════════════════════════════════════════

const path = require('path');
const { Worker } = require('worker_threads');

const WORKER = path.join(__dirname, 'pool-worker.js');
const ERROR_FIELDS = ['status', 'code', 'expose', 'retryable', 'guardReason', 'detail', 'extra'];

function fail(message, fields) {
    return Object.assign(new Error(message), fields);
}

/** The ArrayBuffers a value can hand over without touching anyone else's memory (depth-limited walk). */
function transferables(value, out = new Set(), depth = 0) {
    if (!value || depth > 4) return out;
    if (ArrayBuffer.isView(value)) {
        const ab = value.buffer;
        // A small Buffer shares Node's 8 KB pool slab with other Buffers: never detach that.
        if (ab instanceof ArrayBuffer && value.byteOffset === 0 && value.byteLength === ab.byteLength) out.add(ab);
        return out;
    }
    if (Array.isArray(value)) { for (const v of value) transferables(v, out, depth + 1); return out; }
    if (typeof value === 'object') for (const v of Object.values(value)) transferables(v, out, depth + 1);
    return out;
}

/** Uint8Arrays (what a Buffer becomes after structured clone) back to Buffers, depth-limited. */
function revive(value, depth = 0) {
    if (!value || depth > 4) return value;
    if (value instanceof Uint8Array && !Buffer.isBuffer(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) value[i] = revive(value[i], depth + 1); return value; }
    if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
        for (const k of Object.keys(value)) value[k] = revive(value[k], depth + 1);
    }
    return value;
}

/**
 * @param {object} o
 * @param {string} o.module          absolute path of the module the workers run
 * @param {string} [o.name]          for errors and stats
 * @param {number} [o.size=2]        runs at once
 * @param {number} [o.memoryMb=512]  V8 old-generation limit per worker
 * @param {number} [o.maxQueue=64]   runs waiting before run() refuses (0 = no waiting at all)
 * @param {number} [o.idleMs=60000]  a worker without work for this long is stopped
 * @param {object} [o.env]           the workers' environment (default: this process's)
 */
function createPool(o) {
    if (!o || !o.module) throw new TypeError('createPool needs the worker module');
    const name = o.name || path.basename(o.module, '.js');
    const size = Math.max(1, Number.isFinite(o.size) ? Math.floor(o.size) : 2);
    const memoryMb = Math.max(16, Number.isFinite(o.memoryMb) ? Math.floor(o.memoryMb) : 512);
    const maxQueue = Math.max(0, Number.isFinite(o.maxQueue) ? Math.floor(o.maxQueue) : 64);
    const idleMs = Number.isFinite(o.idleMs) ? o.idleMs : 60_000;
    const resourceLimits = { maxOldGenerationSizeMb: memoryMb, maxYoungGenerationSizeMb: Math.min(64, Math.max(8, Math.round(memoryMb / 8))) };

    const workers = new Set();     // { worker, task, idleTimer, ready }
    const queue = [];              // tasks waiting for a worker
    const counts = { completed: 0, failed: 0, killed: 0, out_of_memory: 0, timed_out: 0, cancelled: 0, refused: 0, started: 0 };
    let seq = 0, closed = false;

    function spawn() {
        const w = { worker: null, task: null, idleTimer: null };
        w.worker = new Worker(WORKER, { workerData: { module: o.module }, resourceLimits, env: o.env || process.env, stdout: false, stderr: false });
        w.worker.unref();          // an idle worker never keeps the process alive; a busy one does (start())
        counts.started++;
        w.worker.on('message', (msg) => settle(w, msg));
        w.worker.on('error', (err) => {
            // An uncaught throw or the heap limit: the worker is gone either way.
            const t = w.task;
            w.task = null;
            if (!t) return;
            if (err && err.code === 'ERR_WORKER_OUT_OF_MEMORY') {
                counts.out_of_memory++;
                finish(t, fail(`This file needs more memory than a tool may use here (${memoryMb} MB); try a smaller file or fewer pages.`, { status: 413, code: 'tools.input.too_large', expose: true, guardReason: 'memory' }));
            } else {
                finish(t, fail('The tool stopped unexpectedly while working on this file.', { status: 500, code: 'tools.job.failed', cause: err }));
            }
        });
        w.worker.on('exit', () => {
            workers.delete(w);
            clearTimeout(w.idleTimer);
            if (w.task) { const t = w.task; w.task = null; finish(t, fail('The tool stopped unexpectedly while working on this file.', { status: 500, code: 'tools.job.failed' })); }
            dispatch();
        });
        workers.add(w);
        return w;
    }

    function kill(w) {
        w.task = null;
        workers.delete(w);
        clearTimeout(w.idleTimer);
        counts.killed++;
        w.worker.terminate().catch(() => {});
    }

    function finish(t, err, result) {
        if (t.done) return;
        t.done = true;
        clearTimeout(t.timer);
        if (t.signal && t.onAbort) t.signal.removeEventListener('abort', t.onAbort);
        if (err) { counts.failed++; t.reject(err); } else { counts.completed++; t.resolve(result); }
        setImmediate(dispatch);
    }

    function settle(w, msg) {
        const t = w.task;
        if (!t || !msg || msg.id !== t.id) return;
        w.task = null;
        idle(w);
        if (msg.ok) return finish(t, null, revive(msg.result));
        const e = msg.error || {};
        const err = new Error(e.message || 'The tool failed');
        for (const k of ERROR_FIELDS) if (e[k] !== undefined) err[k] = e[k];
        if (e.name && e.name !== 'Error') err.name = e.name;
        return finish(t, err);
    }

    function idle(w) {
        clearTimeout(w.idleTimer);
        w.worker.unref();
        if (idleMs > 0) {
            w.idleTimer = setTimeout(() => { if (!w.task && !queue.length) { workers.delete(w); w.worker.terminate().catch(() => {}); } }, idleMs);
            if (w.idleTimer.unref) w.idleTimer.unref();
        }
    }

    function start(w, t) {
        clearTimeout(w.idleTimer);
        w.worker.ref();
        w.task = t;
        t.worker = w;
        if (t.timeoutMs > 0) {
            t.timer = setTimeout(() => {
                if (w.task !== t) return;
                counts.timed_out++;
                kill(w);
                finish(t, fail(`The tool ran longer than ${Math.round(t.timeoutMs / 1000)} s and was stopped.`, { status: 504, code: 'tools.run.timeout', expose: true, guardReason: 'timeout' }));
            }, t.timeoutMs);
            if (t.timer.unref) t.timer.unref();
        }
        try {
            try { w.worker.postMessage({ id: t.id, op: t.op, payload: t.payload }, t.transfer ? [...transferables(t.payload)] : []); } catch (err) {
                if (!t.transfer) throw err;
                w.worker.postMessage({ id: t.id, op: t.op, payload: t.payload });   // a buffer that cannot be detached: copied
            }
        } catch (err) {
            w.task = null;
            idle(w);
            finish(t, fail(`The input could not be handed to the tool (${err.message})`, { status: 500, code: 'tools.job.failed' }));
        }
        t.payload = null;
    }

    function dispatch() {
        if (closed) return;
        while (queue.length) {
            let w = [...workers].find(x => !x.task);
            if (!w) {
                if (workers.size >= size) return;
                w = spawn();
            }
            start(w, queue.shift());
        }
    }

    /**
     * Run `op` of the worker module with `payload`.
     * @param {string} op
     * @param {*} payload                 structured-clonable
     * @param {object} [opts]
     * @param {number} [opts.timeoutMs]   stop the worker after this long (0 = no limit of its own)
     * @param {AbortSignal} [opts.signal] stop it when this aborts (cancel, client gone)
     * @param {boolean} [opts.transfer]   move the payload's buffers instead of copying them
     */
    function run(op, payload, opts = {}) {
        return new Promise((resolve, reject) => {
            if (closed) return reject(fail('The worker pool is shutting down', { status: 503, code: 'tools.busy', retryAfter: 5 }));
            if (opts.signal && opts.signal.aborted) return reject(fail('cancelled', { status: 409, code: 'tools.job.cancelled' }));
            const busy = [...workers].filter(w => w.task).length;
            if (busy >= size && queue.length >= maxQueue) {
                counts.refused++;
                return reject(fail('The server is busy with other files right now; try again in a moment.', { status: 503, code: 'tools.busy', retryAfter: 10, expose: true, guardReason: 'busy.workers' }));
            }
            const t = { id: ++seq, op, payload, resolve, reject, timeoutMs: opts.timeoutMs || 0, signal: opts.signal || null, transfer: !!opts.transfer, done: false };
            if (t.signal) {
                t.onAbort = () => {
                    if (t.done) return;
                    counts.cancelled++;
                    const i = queue.indexOf(t);
                    if (i >= 0) queue.splice(i, 1);
                    else if (t.worker && t.worker.task === t) kill(t.worker);
                    finish(t, fail('cancelled', { status: 409, code: 'tools.job.cancelled' }));
                };
                t.signal.addEventListener('abort', t.onAbort, { once: true });
            }
            queue.push(t);
            dispatch();
        });
    }

    function stats() {
        const busy = [...workers].filter(w => w.task).length;
        return { name, size, memory_mb: memoryMb, workers: workers.size, busy, queued: queue.length, max_queue: maxQueue, ...counts };
    }

    /** Stop every worker; waiting runs fail with 503. */
    async function close() {
        closed = true;
        for (const t of queue.splice(0)) finish(t, fail('The worker pool is shutting down', { status: 503, code: 'tools.busy', retryAfter: 5 }));
        await Promise.all([...workers].map(w => { const t = w.task; w.task = null; if (t) finish(t, fail('The worker pool is shutting down', { status: 503, code: 'tools.busy', retryAfter: 5 })); clearTimeout(w.idleTimer); return w.worker.terminate().catch(() => {}); }));
        workers.clear();
    }

    return { run, stats, close, size, memoryMb, maxQueue };
}

function envInt(env, names, fallback) {
    for (const n of names) {
        const v = parseInt(env[n], 10);
        if (Number.isFinite(v) && v >= 0) return v;
    }
    return fallback;
}

/** A pool sized from the environment (see the header) for `app` ('img', 'docs', 'gateway'). */
function poolFromEnv(app, module, { env = process.env, size, memoryMb, maxQueue, idleMs } = {}) {
    const A = String(app).toUpperCase();
    return createPool({
        name: app, module, env,
        size: envInt(env, [`TOOLS_WORKERS_${A}`, 'TOOLS_WORKERS'], size != null ? size : 2) || 1,
        memoryMb: envInt(env, [`TOOLS_WORKER_MEMORY_MB_${A}`, 'TOOLS_WORKER_MEMORY_MB'], memoryMb != null ? memoryMb : 512),
        maxQueue: envInt(env, [`TOOLS_WORKER_QUEUE_${A}`, 'TOOLS_WORKER_QUEUE'], maxQueue != null ? maxQueue : 64),
        idleMs: envInt(env, ['TOOLS_WORKER_IDLE_MS'], idleMs != null ? idleMs : 60_000),
    });
}

module.exports = { createPool, poolFromEnv, transferables, revive };
