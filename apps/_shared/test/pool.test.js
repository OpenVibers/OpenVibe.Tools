'use strict';
// The worker pool (apps/_shared/jobs/pool.js): work runs off the event loop, at most `size` at once
// with the rest queued in order and refused past maxQueue (503 tools.busy), buffers come back as
// Buffers, a tool's error keeps its status/code/extra, a run past its timeout or whose signal aborts
// has its worker terminated (504 tools.run.timeout, tools.job.cancelled), a run over the heap limit
// fails cleanly with 413 tools.input.too_large, a crashed worker fails its run, and after each of
// those the pool keeps working with fresh workers. Idle workers stop.
const assert = require('assert');
const path = require('path');
const { createPool, poolFromEnv, transferables, revive } = require('../jobs/pool');

const MODULE = path.join(__dirname, 'fixtures', 'pool-module.js');
const rejects = (p) => p.then(() => { throw new Error('expected a rejection'); }, (err) => err);

(async () => {
    const pool = createPool({ name: 'test', module: MODULE, size: 2, memoryMb: 48, maxQueue: 3, idleMs: 300 });
    try {
        // ── Runs, and buffers come back as Buffers ──
        const r = await pool.run('echo', { a: 1, list: [1, 2] });
        assert.deepStrictEqual(r.payload, { a: 1, list: [1, 2] });
        assert.ok(r.threadId > 0, 'ran in a worker thread');
        const src = Buffer.alloc(64 * 1024, 7);
        const d = await pool.run('double', { buf: src }, { transfer: true });
        assert.ok(Buffer.isBuffer(d.out) && d.out.length === 128 * 1024 && d.out[5] === 7, 'a Buffer back');
        assert.ok(Buffer.isBuffer(d.small) && d.small.toString() === 'ok', 'a small (pooled) Buffer back too');
        assert.strictEqual(src.length, 0, 'transfer: the input moved instead of being copied');
        const pooled = Buffer.from('tiny');
        assert.strictEqual(transferables({ pooled }).size, 0, 'a pooled Buffer is never detached');
        assert.ok(Buffer.isBuffer(revive({ x: new Uint8Array([1]) }).x));

        // ── The event loop stays free while a worker is busy ──
        const t0 = Date.now();
        const busy = pool.run('spin', { ms: 600 });
        let ticks = 0;
        const ticker = setInterval(() => ticks++, 20);
        await busy;
        clearInterval(ticker);
        assert.ok(Date.now() - t0 >= 550);
        assert.ok(ticks >= 15, `timers kept firing during 600 ms of work (${ticks})`);

        // ── At most `size` at once, the rest queued; past maxQueue refused ──
        const started = Date.now();
        const runs = [0, 1, 2, 3, 4].map(() => pool.run('spin', { ms: 200 }));
        const refused = await rejects(pool.run('spin', { ms: 1 }));
        assert.deepStrictEqual([refused.status, refused.code, refused.retryAfter], [503, 'tools.busy', 10], '2 running + 3 queued: the next is refused');
        const threads = await Promise.all(runs);
        const took = Date.now() - started;
        assert.ok(took >= 550, `five 200 ms runs two at a time take three rounds (${took} ms)`);
        assert.ok(new Set(threads.map(x => x.threadId)).size <= 2, 'never more than two workers');
        assert.strictEqual(pool.stats().refused, 1);

        // ── A tool's error keeps its fields ──
        const e = await rejects(pool.run('fail', { status: 422, code: 'tools.pdf.wrong_password', extra: { a: 1 } }));
        assert.deepStrictEqual([e.message, e.status, e.code, e.expose, e.guardReason, e.extra], ['refused on purpose', 422, 'tools.pdf.wrong_password', true, 'test', { a: 1 }]);

        // ── Timeout: the worker is terminated, the pool carries on ──
        const before = pool.stats().killed;
        const to = await rejects(pool.run('spin', { ms: 5000 }, { timeoutMs: 150 }));
        assert.deepStrictEqual([to.status, to.code, to.guardReason], [504, 'tools.run.timeout', 'timeout']);
        assert.strictEqual(pool.stats().killed, before + 1, 'its worker was terminated');
        assert.ok((await pool.run('echo', 1)).threadId > 0, 'a fresh worker takes the next run');

        // ── Abort (a cancelled job, a client that left): running and queued ──
        const ac = new AbortController();
        const running = rejects(pool.run('spin', { ms: 5000 }, { signal: ac.signal }));
        const other = pool.run('spin', { ms: 5000 }, { timeoutMs: 100 }).catch(x => x);
        const queued = rejects(pool.run('spin', { ms: 5000 }, { signal: ac.signal }));
        await new Promise(r => setTimeout(r, 50));
        ac.abort();
        for (const x of await Promise.all([running, queued])) assert.deepStrictEqual([x.status, x.code], [409, 'tools.job.cancelled']);
        await other;
        const pre = new AbortController(); pre.abort();
        assert.strictEqual((await rejects(pool.run('echo', 1, { signal: pre.signal }))).code, 'tools.job.cancelled', 'already aborted: never starts');

        // ── Over the heap limit: fails cleanly, the pool carries on ──
        const oom = await rejects(pool.run('hog', {}, { timeoutMs: 20000 }));
        assert.deepStrictEqual([oom.status, oom.code, oom.guardReason], [413, 'tools.input.too_large', 'memory'], oom.message);
        assert.match(oom.message, /48 MB/);
        assert.strictEqual(pool.stats().out_of_memory, 1);
        assert.ok((await pool.run('echo', 2)).threadId > 0, 'still working after a worker ran out of memory');

        // ── A crash fails its run and nothing else ──
        const crash = await rejects(pool.run('crash', {}));
        assert.deepStrictEqual([crash.status, crash.code], [500, 'tools.job.failed']);
        assert.strictEqual((await rejects(pool.run('nope', {}))).status, 500, 'an unknown op is an error, not a hang');
        assert.deepStrictEqual((await pool.run('echo', 3)).payload, 3);

        // ── Idle workers stop ──
        await new Promise(r => setTimeout(r, 700));
        assert.strictEqual(pool.stats().workers, 0, 'no worker kept after idleMs');
        assert.deepStrictEqual((await pool.run('echo', 4)).payload, 4, 'and one starts again on demand');

        // ── Sizing from the environment ──
        const p2 = poolFromEnv('docs', MODULE, { env: { TOOLS_WORKERS: '3', TOOLS_WORKERS_DOCS: '1', TOOLS_WORKER_MEMORY_MB: '256', TOOLS_WORKER_QUEUE: '5', MARK: 'x' } });
        assert.deepStrictEqual([p2.size, p2.memoryMb, p2.maxQueue], [1, 256, 5], 'the per-app override wins');
        assert.deepStrictEqual(await p2.run('env', { name: 'MARK' }), { value: 'x' }, 'workers see the environment they were given');
        await p2.close();
        const p3 = poolFromEnv('img', MODULE, { env: {} });
        assert.deepStrictEqual([p3.size, p3.memoryMb, p3.maxQueue], [2, 512, 64], 'defaults');
        await p3.close();
        assert.strictEqual((await rejects(p3.run('echo', 1))).code, 'tools.busy', 'a closed pool refuses');
    } finally {
        await pool.close();
    }
    console.log('pool: off the event loop, size cap + queue + refusal, buffers, error fields, timeout/abort terminate, heap limit 413, crash, idle stop, env sizing: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
