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
 *
 * The same route answers the two account topics (ADR-033, ./account-data.js): what Tools holds about a person
 * is exported on request and erased when the account goes. They arrive on the same signed endpoint.
 */
const express = require('express');
const { createPgRevocationStore } = require('openvibe-sdk/auth');
const { TOPICS: ACCOUNT_TOPICS } = require('openvibe-sdk/account-data');

const TOPIC = 'network.user.token_valid_after';
let store = null;
let storeDb = null;
let storeValkey = null;
let accountData = null;
let accountSend = null;

/** The gateway calls this once, at boot, with the one `tools` database and the shared Valkey. */
function configure({ db = null, valkey = null, account: account = null, send = null } = {}) {
    storeDb = db; storeValkey = valkey; store = null; accountData = account; accountSend = send;
}

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
        // The account topics (ADR-033): what Tools holds about a person is exported or erased here, not revoked.
        if (ACCOUNT_TOPICS.includes(d.event.event_type)) {
            if (!accountData) return res.status(503).json({ error: 'no account-data module is configured' });
            try {
                const outcome = await accountData.apply(d.event, { send: accountSend });
                return res.json({ event_id: d.event.event_id || null, outcome });
            } catch (err) {
                console.warn(`[account-data] event ${d.event.event_id} (${d.event.event_type}) failed: ${(err && err.message) || err}`);
                return res.status(503).json({ error: 'not applied; Events will retry' });
            }
        }
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
    // The cutoff topic and the two account topics (ADR-033) share this endpoint and this secret.
    let made = false;
    for (const topic of [TOPIC, ...ACCOUNT_TOPICS]) {
        if (subs.some((s) => s.topic_pattern === topic && s.endpoint === endpoint)) continue;
        const r = await fetchImpl(`${eventsUrl}/api/v1/subscriptions`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ topic_pattern: topic, endpoint, secret }) });
        if (r.status === 409) continue;
        if (!r.ok) throw new Error(`Events answered ${r.status} creating the ${topic} subscription`);
        made = true;
        log.log && log.log(`[Events] subscription created: ${topic} → ${endpoint}`);
    }
    return made ? 'created' : 'exists';
}

module.exports = { handler, ensureSubscription, close, configure, stats, TOPIC, _cutoffs: cutoffs };
