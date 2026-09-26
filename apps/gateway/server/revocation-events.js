'use strict';
/**
 * Sign-out everywhere reaches OpenVibe.Tools (roadmap WS-B task 4; Contracts 0.39.0
 * network.user.token_valid_after). The gateway is the one consumer: POST /internal/events (the
 * endpoint of its Events subscription, TOOLS_EVENTS_SECRET, signature v2 only, never through the
 * proxy) writes each person's cutoff into the shared file every app's guard reads
 * (apps/_shared/guard/revocations.js). The subscription is created at boot when EVENTS_URL, the
 * service secret and TOOLS_EVENTS_SECRET are set (grant tools events.subscription.manage).
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const { revocationsFile } = require('../../_shared/guard/revocations');

const TOPIC = 'network.user.token_valid_after';
let store = null;
let storeDb = null;
function cutoffs() {
    if (store) return store;
    const Database = require('better-sqlite3');
    const file = revocationsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new Database(file);
    storeDb = db;
    // A rollback journal, not WAL: the other apps open the file read-only under ProtectSystem=strict and could not
    // create a WAL's -shm file. Writes are one row per sign-out-everywhere.
    db.pragma('journal_mode = DELETE');
    db.pragma('busy_timeout = 2000');
    store = require('openvibe-sdk/auth').createRevocationStore(db, { table: 'token_revocations' });
    return store;
}
/** Close the cutoff store (graceful stop); the next request opens it again. */
function close() {
    const db = storeDb;
    store = null;
    storeDb = null;
    if (db) try { db.close(); } catch { /* already closed */ }
}
const secrets = () => String(process.env.TOOLS_EVENTS_SECRET || '').split(',').map((s) => s.trim()).filter((s) => s.length >= 32);
const stats = { received: 0, revoked: 0, refused: 0 };

function handler() {
    const { parseDelivery } = require('openvibe-sdk/events');
    return [express.raw({ type: () => true, limit: '256kb' }), (req, res) => {
        if (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['cf-connecting-ip']) return res.status(404).json({ error: 'Not found' });
        const keys = secrets();
        if (!keys.length) return res.status(503).json({ error: 'TOOLS_EVENTS_SECRET is not set' });
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        let d = null;
        for (const k of keys) { d = parseDelivery(raw, req.headers, k, { requireV2: true }); if (d) break; }
        if (!d || !d.event) { stats.refused++; return res.status(401).json({ error: 'bad signature' }); }
        stats.received++;
        const outcome = cutoffs().apply(d.event);
        if (outcome === 'revoked') stats.revoked++;
        res.json({ event_id: d.event.event_id || null, outcome });
    }];
}

async function ensureSubscription({ port, fetchImpl = globalThis.fetch, log = console } = {}) {
    const eventsUrl = String(process.env.EVENTS_URL || '').replace(/\/+$/, '');
    const secret = secrets()[0];
    const clientSecret = process.env.OV_OAUTH_CLIENT_SECRET || '';
    if (!eventsUrl || !secret || !clientSecret) return 'off';
    const { createServiceTokenClient } = require('openvibe-sdk/auth');
    const tokens = createServiceTokenClient({
        tokenUrl: `${String(process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '')}/oauth/token`,
        clientId: process.env.OV_OAUTH_CLIENT_ID || 'tools', clientSecret, fetch: fetchImpl,
    });
    const endpoint = process.env.TOOLS_EVENTS_ENDPOINT || `http://127.0.0.1:${port}/internal/events`;
    const token = await tokens.getToken({ audience: 'openvibe.events', scope: 'events.subscription.manage' });
    const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
    const list = await fetchImpl(`${eventsUrl}/api/v1/subscriptions`, { headers });
    if (!list.ok) throw new Error(`Events answered ${list.status} listing subscriptions`);
    const subs = ((await list.json()).subscriptions || []);
    if (subs.some((s) => s.topic_pattern === TOPIC && s.endpoint === endpoint)) return 'exists';
    const r = await fetchImpl(`${eventsUrl}/api/v1/subscriptions`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ topic_pattern: TOPIC, endpoint, secret }) });
    if (r.status === 409) return 'exists';
    if (!r.ok) throw new Error(`Events answered ${r.status} creating the ${TOPIC} subscription`);
    log.log && log.log(`[Events] subscription created: ${TOPIC} → ${endpoint}`);
    return 'created';
}

module.exports = { handler, ensureSubscription, close, stats, TOPIC, _cutoffs: cutoffs };
