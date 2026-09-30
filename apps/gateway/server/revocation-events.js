'use strict';
/**
 * Sign-out everywhere reaches OpenVibe.Tools (roadmap WS-B task 4; Contracts 0.39.0
 * network.user.token_valid_after). The gateway is the one consumer: POST /internal/events (the
 * endpoint of its Events subscription, TOOLS_EVENTS_SECRET, signature v2 only, never through the
 * proxy) writes each person's cutoff into PostgreSQL through openvibe-sdk/auth createPgRevocationStore
 * (the `token_revocations` table of the one `tools` database, migrations/0003); every app's guard
 * reads it (apps/_shared/guard/revocations.js). The subscription is created at boot when EVENTS_URL,
 * the service secret and TOOLS_EVENTS_SECRET are set (grant tools events.subscription.manage).
 *
 * The gateway owns the write, so it also bumps the shared Valkey version the readers watch: with it,
 * a revocation reaches every app on their next read rather than after their cache ttl.
 */
const express = require('express');
const { createPgRevocationStore } = require('openvibe-sdk/auth');

const TOPIC = 'network.user.token_valid_after';
let store = null;
let storeDb = null;
let storeValkey = null;

/** The gateway calls this once, at boot, with the one `tools` database and the shared Valkey. */
function configure({ db = null, valkey = null } = {}) { storeDb = db; storeValkey = valkey; store = null; }

async function cutoffs() {
    if (store) return store;
    if (!storeDb) throw new Error('revocation-events: configure({ db }) was not called');
    const s = createPgRevocationStore(storeDb, { table: 'token_revocations' });
    await s.load();
    store = s;
    return store;
}
/** Close the cutoff store (graceful stop); the next request loads it again. */
function close() { store = null; }
const secrets = () => String(process.env.TOOLS_EVENTS_SECRET || '').split(',').map((s) => s.trim()).filter((s) => s.length >= 32);
const stats = { received: 0, revoked: 0, refused: 0 };

function handler() {
    const { parseDelivery } = require('openvibe-sdk/events');
    return [express.raw({ type: () => true, limit: '256kb' }), async (req, res) => {
        if (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['cf-connecting-ip']) return res.status(404).json({ error: 'Not found' });
        const keys = secrets();
        if (!keys.length) return res.status(503).json({ error: 'TOOLS_EVENTS_SECRET is not set' });
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        let d = null;
        for (const k of keys) { d = parseDelivery(raw, req.headers, k, { requireV2: true }); if (d) break; }
        if (!d || !d.event) { stats.refused++; return res.status(401).json({ error: 'bad signature' }); }
        stats.received++;
        const outcome = await (await cutoffs()).apply(d.event);
        if (outcome === 'revoked') {
            stats.revoked++;
            if (storeValkey) { try { await storeValkey.client.incr(storeValkey.key('token_revocations_version')); } catch { /* the readers fall back to their ttl */ } }
        }
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

module.exports = { handler, ensureSubscription, close, configure, stats, TOPIC, _cutoffs: cutoffs };
