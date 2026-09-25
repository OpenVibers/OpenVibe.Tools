'use strict';
// Sign-out everywhere across Tools (WS-B task 4): the gateway's POST /internal/events (signature v2,
// never through the proxy) writes the person's cutoff into the shared file; any app's guard reader then
// refuses their older tokens and accepts newer ones; forged, foreign and proxied deliveries change nothing.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-tools-revoke-'));
process.env.TOOLS_REVOCATIONS_DB = path.join(tmp, 'shared', 'token-revocations.db');
process.env.TOOLS_EVENTS_SECRET = 't'.repeat(40);
const express = require('express');
const Database = require('better-sqlite3');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const events = require('../server/revocation-events');
const { createCutoffReader } = require('../../_shared/guard/revocations');

const SUBJECT = 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3';
const at = Date.parse('2026-09-25T12:00:00Z');
const ev = (over = {}) => ({ event_id: 'evt_01J8Z3Q4R5S6T7V8W9X0Y1Z2A3', event_type: events.TOPIC, version: 1, source: 'network',
    payload: { subject: { type: 'user', id: SUBJECT }, valid_after: new Date(at).toISOString(), reason: 'password_changed' }, ...over });

(async () => {
    const app = express();
    app.post('/internal/events', ...events.handler());
    const srv = http.createServer(app);
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/internal/events`;
    const post = (event, { secret = process.env.TOOLS_EVENTS_SECRET, headers = {} } = {}) => {
        const body = JSON.stringify({ event, seq: 1 });
        return fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json', ...signDeliveryHeaders(body, secret), ...headers } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
    };
    let clock = 1_000_000;
    const reader = createCutoffReader({ Database, file: process.env.TOOLS_REVOCATIONS_DB, ttlMs: 5000, now: () => clock });
    try {
        const old = { subject_id: SUBJECT, iat: at / 1000 - 30 };
        assert.strictEqual(reader.isRevoked(old), false, 'no file yet: nothing revoked');
        assert.strictEqual((await post(ev(), { secret: 'y'.repeat(40) })).status, 401);
        assert.strictEqual((await post(ev(), { headers: { 'cf-connecting-ip': '1.2.3.4' } })).status, 404);
        assert.strictEqual((await post(ev({ source: 'live' }))).body.outcome, 'ignored:source');
        assert.strictEqual((await post(ev())).body.outcome, 'revoked');
        assert.ok(fs.existsSync(process.env.TOOLS_REVOCATIONS_DB), 'the shared file exists');
        clock += 20_000;   // past the reader's retry pause and memo
        assert.strictEqual(reader.isRevoked(old), true, 'another app sees the cutoff');
        assert.strictEqual(reader.isRevoked({ subject_id: SUBJECT, iat: at / 1000 + 1 }), false);
        assert.strictEqual(reader.isRevoked({ subject_id: 'usr_01J8Z3Q4R5S6T7V8W9X0Y1Z2B4', iat: 1 }), false);
        assert.strictEqual((await post(ev())).body.outcome, 'unchanged');
        const guardSrc = fs.readFileSync(path.join(__dirname, '../../_shared/guard/index.js'), 'utf8');
        assert.ok(/if \(claims && !cutoffs\.isRevoked\(claims\)\)/.test(guardSrc), 'every app\'s guard checks it');
    } finally {
        srv.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    console.log('tools revocations: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
