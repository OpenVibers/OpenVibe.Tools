'use strict';
// The job store in the one shared `tools` database (plan T8): tool_job_events and tool_job_references
// carry no `app`, so every statement on them goes through the owning tool_jobs row. Another app that
// knows a job id reads no events or references, cannot add or drop one, cannot claim, finish or remove
// the job, and its own writes on a foreign id change nothing.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../jobs/store');
const { testDb, closeAllTestDbs } = require('./testdb');

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-jobs-scope-'));
    try {
        const db = await testDb(dir);
        const img = createStore(db, { app: 'img' });
        const docs = createStore(db, { app: 'docs' });
        const now = Date.now();
        await img.insert({ id: 'job_scope_1', type: 't', type_version: 1, owner: 'session:o', input_json: '{}', files_json: '[]', idempotency_key: null, request_hash: null, max_attempts: 1, ttl_ms: 60_000, now, env: 'production' });

        // Events.
        const seq = await img.appendEvent('job_scope_1', 'progress', { p: 1 });
        assert.ok(seq > 0);
        assert.strictEqual(await docs.appendEvent('job_scope_1', 'progress', { p: 2 }), 0, 'another app appends nothing to a foreign job');
        assert.strictEqual((await img.eventsAfter('job_scope_1', 0)).length, 1);
        assert.deepStrictEqual(await docs.eventsAfter('job_scope_1', 0), [], "another app reads none of its events");
        assert.strictEqual(await img.lastSeq('job_scope_1'), seq);
        assert.strictEqual(await docs.lastSeq('job_scope_1'), 0);

        // References.
        assert.strictEqual(await img.addReference('job_scope_1', 'paste:1'), true);
        assert.strictEqual(await docs.addReference('job_scope_1', 'paste:2'), false, 'another app cannot reference it');
        assert.deepStrictEqual((await img.references('job_scope_1')).map((r) => r.ref), ['paste:1']);
        assert.deepStrictEqual(await docs.references('job_scope_1'), []);
        assert.strictEqual(await img.referenceCount('job_scope_1'), 1);
        assert.strictEqual(await docs.referenceCount('job_scope_1'), 0);
        assert.strictEqual(await docs.dropReference('job_scope_1', 'paste:1'), false, 'nor drop one');
        assert.strictEqual(await img.referenceCount('job_scope_1'), 1);

        // The job row itself.
        assert.strictEqual(await docs.get('job_scope_1'), null);
        assert.strictEqual(await docs.claim('job_scope_1'), false);
        assert.strictEqual(await docs.requestCancel('job_scope_1'), false);
        assert.strictEqual(await img.claim('job_scope_1'), true);
        assert.strictEqual(await docs.setProgress('job_scope_1', 50, 'x'), false);
        assert.strictEqual(await docs.finish('job_scope_1', { state: 'failed' }), false);
        assert.strictEqual(await img.finish('job_scope_1', { state: 'succeeded', result: {} }), true);
        await docs.remove('job_scope_1');
        assert.ok(await img.get('job_scope_1'), 'another app cannot remove it');
        assert.strictEqual((await img.eventsAfter('job_scope_1', 0)).length, 1, 'nor its events');
        assert.strictEqual(await img.dropReference('job_scope_1', 'paste:1'), true);
        await img.remove('job_scope_1');
        assert.strictEqual(await img.get('job_scope_1'), null);
        assert.strictEqual(Number((await db.prepare('SELECT COUNT(*) AS n FROM tool_job_events WHERE job_id = ?').get('job_scope_1')).n), 0, 'its own remove takes the events');

        console.log('jobs store scope: events, references and job writes go through the owning app: all checks passed');
    } finally {
        await closeAllTestDbs();
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exit(1); });
