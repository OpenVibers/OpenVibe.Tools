'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { MAX_FRAME, bytes, TYPES } = require('../../worker/server/protocol');
// This is a fixed loopback channel, not a URL supplied by a job or a person.
async function requestPlacement(id, signal, fetchImpl = fetch) {
    const port = Number(process.env.TOOLS_GATEWAY_INTERNAL_PORT || 4001);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid gateway port');
    const r = await fetchImpl(`http://127.0.0.1:${port}/api/internal/workers/dispatch`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ job_id: id }), signal, redirect: 'error',
    });
    if (!r.ok) throw new Error('gateway unavailable');
    let size = 0; const chunks = [];
    for await (const chunk of r.body) { size += chunk.length; if (size > MAX_FRAME) throw new Error('placement response too large'); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function executePlaced({ row, def, context, receipt, request = requestPlacement, now = Date.now }) {
    let placement = { mode: 'host', attempts: [] };
    if (TYPES.includes(row.type) && row.execution_prefer !== 'host') {
        try { placement = await request(row.id, context.signal); }
        catch { if (context.signal.aborted) throw new Error('cancelled'); }
    }
    receipt.attempts = placement.attempts || [];
    if (placement.mode === 'failed') {
        Object.assign(receipt, receipt.attempts.at(-1));
        throw new Error('The remote worker could not complete this job');
    }
    if (placement.mode === 'remote') {
        Object.assign(receipt, receipt.attempts.at(-1));
        const files = [];
        for (const [i, f] of placement.result.files.entries()) {
            const local = path.join(context.outDir, `remote-${i}`);
            await fs.writeFile(local, bytes(f));
            files.push({ path: local, name: path.basename(f.name), mime: f.mime });
        }
        return { files, data: { ...placement.result.data, execution: receipt } };
    }
    const started = now();
    const attempt = { worker: 'host', location: 'host', took_ms: 0, state: 'failed' };
    receipt.attempts.push(attempt);
    Object.assign(receipt, { worker: 'host', location: 'host' });
    try {
        const out = await def.run(context);
        attempt.state = 'succeeded';
        return { ...out, data: { ...(out?.data || {}), execution: receipt } };
    } finally {
        attempt.took_ms = now() - started;
        if (context.signal.aborted) attempt.state = 'cancelled';
        receipt.took_ms = attempt.took_ms;
    }
}
module.exports = { executePlaced, requestPlacement };
