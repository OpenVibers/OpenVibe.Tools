'use strict';
// The account export and deletion that reaches OpenVibe.Tools (ADR-033): the gateway's POST /internal/events
// (signature v2, never through the proxy) answers the two account topics. Ada's tool jobs are in her export and
// gone with the rows that hang under them; the billing reading of an ended job stays, without her name; Bo's jobs
// stay his. The guard fails when a new table with a person column is neither covered nor exempted with a reason.
const assert = require('assert');
const http = require('http');
const path = require('path');

process.env.TOOLS_EVENTS_SECRET = 't'.repeat(40);
const express = require('express');
const { createDb } = require('openvibe-sdk/db');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { uncovered } = require('openvibe-sdk/account-data');
const events = require('../server/revocation-events');
const accountDataLib = require('../server/account-data');
const { MIGRATIONS } = require('../../_shared/db');

const A = 'usr_01JZ0000000000000000000AAA';
const B = 'usr_01JZ0000000000000000000BBB';
const EXP = 'exp_01JZ0000000000000000000EXP';
const DEL = 'del_01JZ0000000000000000000DEX';

const ev = (id, type, payload) => ({ event_id: id, event_type: type, source: 'network', version: 1, timestamp: new Date().toISOString(), payload });

(async () => {
    const db = createDb({ pglite: true, service: 'account-data-test' });
    await db.migrate({ dir: MIGRATIONS, log: { log() {}, warn() {}, error() {} } });

    const accountData = accountDataLib.create({ db, log: { log() {}, warn() {}, error() {} } });
    const sent = [];
    const send = async (p, body) => { sent.push({ path: p, body }); return { ok: true, status: 201 }; };
    events.configure({ db, account: accountData, send });

    const app = express();
    app.post('/internal/events', ...events.handler());
    const srv = http.createServer(app);
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/internal/events`;
    const post = (event, { secret = process.env.TOOLS_EVENTS_SECRET, headers = {} } = {}) => {
        const body = JSON.stringify({ event, seq: 1 });
        return fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json', ...signDeliveryHeaders(body, secret), ...headers } })
            .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    };

    try {
        // ── the guard: every table with a person column is covered or exempted with a reason ──
        const missing = await uncovered(db, {
            tables: [...accountDataLib.TABLES, ...accountDataLib.GUARDED],
            exempt: {
                account_data_events: 'the ledger of requests itself: which export and deletion Tools applied',
                analytics_events: 'the tracker\'s own rows: its user_id is a local counter, not a subject, and the rows are not keyed by a person',
            },
        });
        assert.deepStrictEqual(missing, [], `a table with a person column is neither covered nor exempted: ${missing.join(', ')}`);

        // ── the export: their jobs, nobody else's ──
        for (const [subject, name] of [[A, 'ada'], [B, 'bo']]) {
            await db.exec(`INSERT INTO tool_jobs (id, app, type, owner, state, input_json, files_json, tool, project_id, created_at, updated_at)
                VALUES ($1, 'img', 'png.thumbnail', $2, 'succeeded', $3, '[]', 'png.thumbnail', 'proj_1', 1, 2)`, [`job_${name}`, `user:${subject}`, `{"name":"${name}.png"}`]);
            await db.exec("INSERT INTO tool_job_events (job_id, event, data, at) VALUES ($1, 'done', '{}', 2)", [`job_${name}`]);
            await db.exec("INSERT INTO tool_job_references (job_id, ref, created_at) VALUES ($1, 'media_1', 2)", [`job_${name}`]);
            await db.exec("INSERT INTO tool_job_billing_readings (job_id, app, reading, created_at) VALUES ($1, 'img', $2, 2)", [`job_${name}`, JSON.stringify({ subject: `user:${subject}`, quantity: 1 })]);
        }

        const r = await post(ev('evt_01JZ0000000000000000000E01', 'network.account.export_requested', { export_id: EXP, subject: A }));
        assert.deepStrictEqual([r.status, r.body.outcome], [200, 'exported']);
        const part = sent.find((c) => c.path === `/internal/account-exports/${EXP}/parts`);
        assert.ok(part, 'the part was posted to Network');
        const jobs = part.body.files.find((f) => f.name === 'tool-jobs.json');
        assert.ok(jobs, 'tool-jobs.json is in the part');
        assert.deepStrictEqual(jobs.content.map((j) => j.id), ['job_ada'], 'only her own job');
        assert.ok(!JSON.stringify(part.body).includes(B), 'nobody else\'s rows');
        const readings = part.body.files.find((f) => f.name === 'billing-readings.json');
        assert.ok(readings && readings.content.length === 1, 'the billing reading of her job is in the part');

        // ── the deletion: the jobs and the rows under them go; the money record stays, without her ──
        const d = await post(ev('evt_01JZ0000000000000000000D01', 'network.account.deleted', { deletion_id: DEL, subject: A, aliases: [] }));
        assert.deepStrictEqual([d.status, d.body.outcome], [200, 'erased']);
        assert.strictEqual(Number(await db.value('SELECT count(*)::int FROM tool_jobs WHERE owner = $1', [`user:${A}`])), 0, 'her job is gone');
        assert.strictEqual(Number(await db.value('SELECT count(*)::int FROM tool_job_events WHERE job_id = $1', ['job_ada'])), 0, 'the event log under it is gone');
        assert.strictEqual(Number(await db.value('SELECT count(*)::int FROM tool_job_references WHERE job_id = $1', ['job_ada'])), 0, 'the references under it are gone');
        assert.strictEqual(Number(await db.value('SELECT count(*)::int FROM tool_jobs WHERE owner = $1', [`user:${B}`])), 1, 'Bo\'s job stays');
        assert.strictEqual(Number(await db.value('SELECT count(*)::int FROM tool_job_events WHERE job_id = $1', ['job_bo'])), 1, 'Bo\'s event log stays');
        const reading = await db.value("SELECT reading->>'subject' FROM tool_job_billing_readings WHERE job_id = 'job_ada'");
        assert.strictEqual(reading, 'user:deleted', 'the money record stays, without her name');
        const confirmation = sent.find((c) => c.path === `/internal/account-deletions/${DEL}/confirmations`);
        assert.ok(confirmation, 'the confirmation was sent');
        assert.ok(confirmation.body.erased.tool_jobs >= 1, 'the erased jobs are counted');

        // ── the route: an unsigned delivery is refused, a proxied one never arrives ──
        assert.strictEqual((await post(ev('evt_01JZ0000000000000000000E02', 'network.account.export_requested', { export_id: EXP, subject: A }), { secret: 'y'.repeat(40) })).status, 401);
        assert.strictEqual((await post(ev('evt_01JZ0000000000000000000E02', 'network.account.export_requested', { export_id: EXP, subject: A }), { headers: { 'cf-connecting-ip': '1.2.3.4' } })).status, 404);
    } finally {
        srv.close();
        await db.close();
        events.close();
    }
    console.log('tools account-data: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
