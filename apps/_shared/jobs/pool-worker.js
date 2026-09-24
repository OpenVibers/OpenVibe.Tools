'use strict';
// One worker thread of ./pool.js: requires the app's worker module once, then runs one message at a
// time (op → module[op](payload)) and answers { id, ok, result } or { id, ok: false, error }. Result
// buffers are transferred back, never copied; an error keeps the fields the HTTP and job layers read.
const { parentPort, workerData } = require('worker_threads');
const { transferables } = require('./pool');

const mod = require(workerData.module);
const FIELDS = ['name', 'message', 'status', 'code', 'expose', 'retryable', 'guardReason', 'detail', 'extra'];

function plain(err) {
    const out = {};
    for (const k of FIELDS) {
        const v = err && err[k];
        if (v === undefined) continue;
        try { out[k] = k === 'extra' ? JSON.parse(JSON.stringify(v)) : v; } catch { /* not clonable: left out */ }
    }
    if (!out.message) out.message = String(err || 'The tool failed');
    return out;
}

parentPort.on('message', async ({ id, op, payload }) => {
    try {
        const fn = mod[op];
        if (typeof fn !== 'function') throw Object.assign(new Error(`The worker module has no ${op}()`), { status: 500 });
        const result = await fn(payload);
        // Some native buffers (sharp's) cannot be detached: those are copied instead.
        try { parentPort.postMessage({ id, ok: true, result }, [...transferables(result)]); } catch { parentPort.postMessage({ id, ok: true, result }); }
    } catch (err) {
        parentPort.postMessage({ id, ok: false, error: plain(err) });
    }
});
