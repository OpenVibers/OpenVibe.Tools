'use strict';
// A boot recovery that fails (the database not reachable yet) must not strand queued jobs: start()
// rejects and leaves the system unstarted, a second start() recovers and runs them, and setupJobs
// (apps/_shared/jobs/index.js) retries on its own with a backoff until the system is running.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { dep } = require('./deps');
const jobs = require('../jobs');
const { testDb, closeAllTestDbs } = require('./testdb');

const express = dep('express');
const contracts = dep('openvibe-contracts');
const quiet = { log() {}, warn() {}, error() {} };

/** The db handle with the recovery's "running jobs" query failing the first `n` times. */
function flaky(db, n) {
    const out = Object.create(db);
    out.fails = n;
    out.prepare = (sql) => {
        const s = db.prepare(sql);
        if (!/^SELECT \* FROM tool_jobs WHERE app = @app AND state = 'running'$/.test(sql.trim())) return s;
        return {
            get: (...a) => s.get(...a),
            run: (...a) => s.run(...a),
            all: async (...a) => { if (out.fails > 0) { out.fails--; throw new Error('database not reachable yet'); } return s.all(...a); },
        };
    };
    return out;
}

async function until(fn, what, ms = 5000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 20)); }
    throw new Error(`timed out: ${what}`);
}

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-jobs-retry-'));
    try {
        // 1. The job system: a failed start() leaves it unstarted; the next one recovers.
        {
            const dir = path.join(root, 'system');
            const db = flaky(await testDb(dir), 1);
            const system = jobs.createJobSystem({ db, contracts, service: 'retry-a', dataDir: dir, log: quiet });
            system.define({ type: 'test.noop', maxFiles: 1, async run() { return { files: [], data: { ok: true } }; } });
            const { job } = await system.submit({ owner: 'session:x', type: 'test.noop', input: {} });
            assert.strictEqual(job.state, 'queued');
            await assert.rejects(system.start(), /not reachable yet/);
            assert.strictEqual(system.isRunning(), false, 'a failed recovery leaves the system unstarted');
            assert.strictEqual((await system.get(job.id)).state, 'queued', 'the queued job waits');
            await system.start();
            assert.strictEqual(system.isRunning(), true);
            await until(async () => (await system.get(job.id)).state === 'succeeded', 'the queued job runs after the second start');
            system.stop();
        }

        // 2. setupJobs retries by itself.
        {
            const dir = path.join(root, 'setup');
            const db = flaky(await testDb(dir), 2);
            const app = express();
            const system = jobs.setupJobs({
                app, service: 'retry-b', dataDir: dir, db, contracts, getPublicKey: () => null, issuer: 'https://openvibe.network',
                define: (s) => s.define({ type: 'test.noop', maxFiles: 1, async run() { return { files: [], data: {} }; } }),
                bootRetryMs: 20, log: quiet,
            });
            await until(() => system.isRunning(), 'setupJobs retried the boot until it started');
            assert.strictEqual(db.fails, 0, 'after both failures');
            const { job } = await system.submit({ owner: 'session:y', type: 'test.noop', input: {} });
            await until(async () => (await system.get(job.id)).state === 'succeeded', 'a job runs');
            system.close();
        }

        console.log('jobs start retry: a failed boot recovery leaves the system unstarted, start() again resumes queued jobs, setupJobs retries with a backoff: all checks passed');
    } finally {
        await closeAllTestDbs();
        fs.rmSync(root, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exit(1); });
