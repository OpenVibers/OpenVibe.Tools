'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('../../gateway/node_modules/express');
const { testDb, closeAllTestDbs } = require('../../_shared/test/testdb');
const { createStore } = require('../../gateway/server/workers/store');
const { createAdmin } = require('../../gateway/server/workers/admin');
const { ownerGuard } = require('../../gateway/server/workers/owner');
const { hash } = require('../server/protocol');
(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tools-owner-test-'));
    let server;
    try {
        const db = await testDb(dir), store = createStore(db);
        const minted = await store.mint({ label: 'Tower one', location: 'home' });
        const stored = await store.lookup(minted.id);
        assert.equal(stored.token_hash, hash(minted.token)); assert.notEqual(stored.token_hash, minted.token);
        const at = Date.UTC(2026, 10, 10, 12), day = '2026-11-10';
        await db.prepare("INSERT INTO tool_jobs (id,type,owner,state,created_at,updated_at) VALUES ('job-test','img.process','test-owner','running',?,?)").run(at, at);
        const insert = () => db.prepare("INSERT INTO tool_worker_attempts (job_id,job_attempt,attempt,worker_id,location,took_ms,state,at) VALUES ('job-test',1,0,?,'home',10,'succeeded',?) ON CONFLICT DO NOTHING").run(minted.id, at);
        await insert(); await insert();
        assert.equal(Number((await store.daily(day))[0].jobs), 1, 'replayed assignment does not double-count');
        await db.prepare("DELETE FROM tool_jobs WHERE id='job-test'").run();
        assert.equal(Number((await store.daily(day))[0].jobs), 1, 'daily count survives job expiry/cascade');
        let terminated = false;
        const c = { id: minted.id, slots: 2, free: 1, active_jobs: 1, load: 0.2, latency_ms: 35, draining: false, ws: { terminate() { terminated = true; } } };
        const hub = { connections: new Map([[c.id, c]]), stats: () => [{ id: c.id, slots: c.slots, free: c.free, active_jobs: c.active_jobs, load: c.load, latency_ms: c.latency_ms, draining: c.draining }] };
        const guard = ownerGuard({ verify: async t => t === 'owner-test' ? { username: 'test-owner' } : { username: 'someone' }, extractToken: r => r.headers.authorization, origin: 'https://openvibe.tools', username: 'test-owner' });
        const app = express();
        app.use('/api/v1/owner', createAdmin({ express, guard, store, hub, now: () => at, ports: { img: 1, docs: 2, audio: 3, yt: 4 }, fetchImpl: async url => {
            assert.match(url, /^http:\/\/127\.0\.0\.1:[1-4]\/api\/health$/);
            return { ok: true, json: async () => ({ jobs: { concurrency: 2, executing: 1 } }) };
        } }));
        server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
        const base = `http://127.0.0.1:${server.address().port}/api/v1/owner`;
        async function call(p, method = 'GET', body, auth = 'owner-test', origin = 'https://openvibe.tools') {
            return fetch(base + p, { method, headers: { authorization: auth, origin, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
        }
        let response = await call('/workers');
        assert.equal(response.headers.get('cache-control'), 'no-store');
        let fleet = await response.json();
        assert.equal(fleet.routing.enabled, false); assert.equal(fleet.workers[0].free, 4);
        assert.equal(fleet.workers[1].jobs_today, 1); assert.equal(fleet.workers[1].online, true);
        assert(!JSON.stringify(fleet).includes(minted.token)); assert(!JSON.stringify(fleet).includes(stored.token_hash));
        assert.equal((await call('/workers', 'GET', undefined, 'not-owner')).status, 403);
        assert.equal((await call('/workers', 'POST', { label: 'refused' }, 'owner-test', 'https://elsewhere.example')).status, 403);
        response = await call(`/workers/${minted.id}/drain`, 'PUT', { draining: true });
        assert.equal(response.status, 200); assert.equal(c.draining, true); assert.equal(terminated, false, 'drain keeps existing work alive');
        assert.equal((await call(`/workers/${minted.id}/drain`, 'PUT', { draining: 'true' })).status, 400);
        response = await call('/worker-routing', 'PUT', { enabled: true, order: [minted.id, 'home'] });
        assert.deepEqual((await response.json()).order, [minted.id, 'home', 'host']);
        assert.equal((await call(`/workers/${minted.id}`, 'DELETE')).status, 200);
        assert.equal(terminated, true); assert.equal(await store.lookup(minted.id), undefined);
        console.log('worker owner: hashed credentials, owner/origin guard, fleet/load/slots, persistent UTC counts, immediate drain, routing and revocation passed');
    } finally {
        if (server) await new Promise(r => server.close(r));
        await closeAllTestDbs(); await fs.rm(dir, { recursive: true, force: true });
    }
})().catch(e => { console.error(e); process.exitCode = 1; });
