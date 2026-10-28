'use strict';
// Domain history (server/net/history.js, migration 0008) on a real in-memory PGlite database:
//   - a domain's RDAP facts are kept (registrar, dates, status, name servers, DNSSEC) and never its contacts' details;
//   - the same facts again move the last snapshot's last_seen; changed facts write a new snapshot, and the history says
//     what changed and when;
//   - the lists show only domains looked up five times or more ("most looked up", "expiring soon");
//   - the routes: a WHOIS lookup records without holding up its answer; anyone reads GET /api/v1/domains/:domain and
//     /api/v1/domains (any origin, cached a minute).
const assert = require('assert');
const http = require('http');
const express = require('express');
const { createDb } = require('openvibe-sdk/db');
const { openToolsDb } = require('../../_shared/db');
const { createDomainHistory, factsFromRdap, changesBetween } = require('../server/net/history');
const createNetRoutes = require('../server/net/routes');
const { createDomainHistoryRoutes } = require('../server/net/history-routes');

const rdap = ({ registrar = 'Cloudflare, Inc.', expires = '2027-03-01T00:00:00Z', ns = ['NS1.EXAMPLE.NET', 'ns2.example.net'], status = ['client transfer prohibited'] } = {}) => ({
    ldhName: 'EXAMPLE.ORG', status, secureDNS: { delegationSigned: false },
    events: [{ eventAction: 'registration', eventDate: '2019-03-01T10:00:00Z' }, { eventAction: 'expiration', eventDate: expires }, { eventAction: 'last update of RDAP database', eventDate: new Date().toISOString() }],
    entities: [
        { roles: ['registrar'], handle: '1910', vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', registrar]]] },
        { roles: ['registrant'], vcardArray: ['vcard', [['fn', {}, 'text', 'Alice Private'], ['email', {}, 'text', 'alice@example.org'], ['tel', {}, 'text', '+1 555 0100']]] },
    ],
    nameservers: ns.map((n) => ({ ldhName: n })),
});

(async () => {
    // ── the facts ──
    const f = factsFromRdap(rdap());
    assert.deepStrictEqual(f, { registrar: 'Cloudflare, Inc.', created: '2019-03-01T10:00:00.000Z', updated: null, expires: '2027-03-01T00:00:00.000Z', status: ['client transfer prohibited'], nameservers: ['ns1.example.net', 'ns2.example.net'], dnssec: false });
    assert.ok(!/Alice|alice@|555/.test(JSON.stringify(f)), 'never a contact\'s name, email or phone');
    assert.deepStrictEqual(changesBetween(f, { ...f, registrar: 'Gandi SAS' }), [{ field: 'registrar', before: 'Cloudflare, Inc.', after: 'Gandi SAS' }]);

    // ── on a real database ──
    const { db, ready } = openToolsDb({ createDb, service: 'tools-test', log: { warn() {}, info() {}, log() {}, error() {} } });
    await ready;
    let clock = Date.parse('2026-10-01T00:00:00Z');
    const h = createDomainHistory({ db, log: { warn() {} }, now: () => new Date(clock) });
    assert.strictEqual((await h.record('Example.org', rdap())).changed, true, 'the first lookup writes a snapshot');
    clock += 86400000;
    assert.strictEqual((await h.record('example.org', rdap())).changed, false, 'the same facts again: no new snapshot');
    clock += 86400000;
    assert.strictEqual((await h.record('example.org', rdap({ registrar: 'Gandi SAS', ns: ['a.ns.gandi.net', 'b.ns.gandi.net'], expires: '2028-03-01T00:00:00Z' }))).changed, true, 'a transfer is a new snapshot');
    const hist = await h.history('EXAMPLE.ORG');
    assert.strictEqual(hist.snapshots.length, 2);
    assert.strictEqual(hist.snapshots[1].seen, 2, 'the first snapshot was seen twice');
    assert.strictEqual(hist.first_seen, '2026-10-01T00:00:00.000Z');
    assert.strictEqual(hist.lookups, 3);
    assert.deepStrictEqual(hist.changes[0].changes.map((c) => c.field), ['registrar', 'expires', 'nameservers'], 'what changed: the registrar, the expiry and the name servers');
    assert.strictEqual(hist.changes[0].at, '2026-10-03T00:00:00.000Z');
    assert.strictEqual(await h.record('not a domain', rdap()), null, 'only domain names are kept');

    // ── the lists: five lookups or more ──
    let lists = await h.lists();
    assert.deepStrictEqual(lists.most_looked_up, [], 'three lookups: not listed yet');
    for (let i = 0; i < 2; i++) await h.record('example.org', rdap({ registrar: 'Gandi SAS', ns: ['a.ns.gandi.net', 'b.ns.gandi.net'], expires: '2026-11-15T00:00:00Z' }));
    lists = await h.lists();
    assert.deepStrictEqual(lists.most_looked_up.map((d) => [d.domain, d.lookups]), [['example.org', 5]]);
    assert.deepStrictEqual(lists.expiring_soon.map((d) => d.domain), ['example.org'], 'expires within 60 days');

    // ── the routes ──
    const fetchRdap = async (u) => ({ ok: true, status: 200, headers: new Map([['content-type', 'application/rdap+json']]), json: async () => (/rdap\.org|bootstrap|dns\.json/.test(String(u)) ? { services: [[['org'], ['https://rdap.example/']]] } : rdap({ registrar: 'Porkbun LLC' })), text: async () => '' });
    const app = express();
    const routesHistory = createDomainHistory({ db, log: { warn() {} } });
    app.use('/api/net', createNetRoutes(null, (_q, _s, n) => n(), { fetch: fetchRdap, history: routesHistory }));
    app.use('/api/v1/domains', createDomainHistoryRoutes({ history: routesHistory }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const root = `http://127.0.0.1:${server.address().port}`;
    const get = async (p) => { const r = await fetch(root + p); return { status: r.status, json: await r.json(), cors: r.headers.get('access-control-allow-origin') }; };
    const who = await get('/api/net/whois/fresh-domain.org');
    assert.strictEqual(who.status, 200, JSON.stringify(who.json).slice(0, 200));
    for (let i = 0; i < 30 && !(await get('/api/v1/domains/fresh-domain.org')).json.snapshots.length; i++) await new Promise((r) => setTimeout(r, 50));
    const one = await get('/api/v1/domains/Fresh-Domain.org');
    assert.deepStrictEqual([one.json.ok, one.json.snapshots.length, one.json.snapshots[0].facts.registrar, one.cors], [true, 1, 'Porkbun LLC', '*'], 'a WHOIS lookup is kept, and anyone may read it');
    assert.strictEqual((await get('/api/v1/domains/1.2.3.4')).status, 400, 'a domain name, not an address');
    const all = await get('/api/v1/domains');
    assert.ok(all.json.ok && Array.isArray(all.json.most_looked_up) && all.json.min_lookups === 5);
    server.close();
    await db.close();
    console.log('domain history: facts without contacts, snapshots on change, lists after five lookups, routes ok');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
