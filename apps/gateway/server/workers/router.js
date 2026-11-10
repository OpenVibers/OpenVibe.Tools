'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { MAX_BYTES, TYPES, bytes } = require('../../../worker/server/protocol');
const { detect } = require('../../../_shared/guard/sniff');
const free = c => Math.min(c.free, c.slots - c.pending.size);
function choose(connections, order, type, tool, excluded = new Set()) {
    const eligible = [...connections.values()].filter(c => !excluded.has(c.id) && !c.draining && free(c) > 0 && c.capabilities.includes(type) && c.tools?.includes(`${type}:${tool}`));
    for (const key of [...order, 'host']) {
        const candidates = eligible.filter(c => c.id === key || c.location === key);
        candidates.sort((a, b) => free(b) - free(a) || (a.latency_ms ?? Infinity) - (b.latency_ms ?? Infinity) || a.id.localeCompare(b.id));
        if (candidates.length) return candidates[0];
        if (key === 'host') return null;
    }
    return null;
}
function createRouter({ hub, store, db, now = Date.now }) {
    const active = new Set();
    async function route(id, signal) {
        const host = attempts => ({ mode: 'host', attempts });
        const config = await store.routing();
        if (!config?.enabled) return host([]);
        if (active.has(id)) throw new Error('job already dispatched');
        const row = await db.prepare('SELECT id,type,state,input_json,files_json,execution_prefer FROM tool_jobs WHERE id=?').get(id);
        if (!row || row.state !== 'running' || !TYPES.includes(row.type) || row.execution_prefer === 'host') return host([]);
        const input = JSON.parse(row.input_json), source = JSON.parse(row.files_json);
        let order; try { order = JSON.parse(config.worker_order); } catch { return host([]); }
        if (!Array.isArray(order) || !order.length) return host([]);
        const tool = String(input.tool || 'convert');
        if (!choose(hub.connections, order, row.type, tool)) return host([]);
        active.add(id);
        try {
            const files = [];
            let total = 0;
            for (const f of source) {
                const stat = await fs.stat(f._path); total += stat.size;
                if (total > MAX_BYTES) return host([]);
                const b = await fs.readFile(f._path);
                const kind = detect(b);
                if (!kind || kind.mime === 'image/svg+xml') return host([]);
                files.push({ name: path.basename(f.name), mime: kind.mime, bytes: b.toString('base64') });
            }
            const excluded = new Set(), attempts = [];
            // One retry after disconnect, including a host retry when no other worker is available.
            for (let n = 0; n < 2; n++) {
                if (signal.aborted) throw new Error('cancelled');
                const worker = choose(hub.connections, order, row.type, tool, excluded);
                if (!worker) return host(attempts);
                excluded.add(worker.id);
                const started = now();
                const attempt = { worker: worker.id, location: worker.location, took_ms: 0, state: 'failed' };
                attempts.push(attempt);
                try {
                    const reply = await hub.dispatch(worker, { type: row.type, input, files }, signal);
                    attempt.took_ms = now() - started;
                    if (!reply.ok) return { mode: 'failed', attempts };
                    const result = reply.result;
                    if (!result || !Array.isArray(result.files) || result.files.length > 50 || !result.data || typeof result.data !== 'object' || Array.isArray(result.data)) throw new Error('invalid worker result');
                    let size = 0;
                    for (const f of result.files) {
                        size += bytes(f).length;
                        if (size > MAX_BYTES || typeof f.name !== 'string' || f.name.length > 200 || typeof f.mime !== 'string' || f.mime.length > 100) throw new Error('invalid worker output');
                        f.name = path.basename(f.name);
                    }
                    attempt.state = 'succeeded';
                    return { mode: 'remote', result, attempts };
                } catch (err) {
                    attempt.took_ms = now() - started;
                    attempt.state = signal.aborted ? 'cancelled' : 'disconnected';
                    if (signal.aborted || err.code !== 'worker.disconnected') return { mode: 'failed', attempts };
                }
            }
            return { mode: 'failed', attempts };
        } finally { active.delete(id); }
    }
    return { route };
}
module.exports = { choose, createRouter, free };
