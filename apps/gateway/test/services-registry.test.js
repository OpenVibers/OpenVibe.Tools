'use strict';
// The catalog resolves other services through Network's registry (GET /api/v1/registry/services):
// origins and names come from the registry, placeholders/retired services are not linked, the last
// good answer survives a failed refresh, and until the registry answers the local list is used and
// the catalog says so.
const assert = require('assert');
const { createServiceDirectory } = require('../server/registry/services');

const manifest = (id, status, origin, name) => ({ id, name: name || `OpenVibe.${id}`, status, publicOrigin: origin, domains: [], runtime: { status: 'up', checked_at: '2026-09-22T00:00:00Z' } });
const answer = (services) => async () => ({ ok: true, status: 200, json: async () => ({ services, contracts_version: '0.7.0' }) });
const broken = async () => { throw new Error('connect ECONNREFUSED'); };

(async () => {
    // ── The directory on its own ────────────────────────────
    let changes = 0;
    let fetchImpl = broken;
    const dir = createServiceDirectory({ url: 'http://registry.test/api/v1/registry/services', publicUrl: 'https://openvibe.network/api/v1/registry/services', fetchImpl: (...a) => fetchImpl(...a), onChange: () => { changes++; } });
    assert.strictEqual(dir.snapshot().source, 'fallback', 'before the registry answers: the local list, and it says so');
    assert.strictEqual(dir.origin('community'), 'https://openvibe.community');
    assert.strictEqual(await dir.refresh(), false);
    assert.strictEqual(dir.snapshot().source, 'fallback');
    assert.match(dir.status().last_error, /ECONNREFUSED/);

    fetchImpl = answer([
        manifest('network', 'stable', 'https://openvibe.network'),
        manifest('community', 'alpha', 'https://community.example.org', 'OpenVibe.Community'),
        manifest('live', 'retired', 'https://openvibe.live'),
        manifest('wiki', 'placeholder', 'https://openvibe.wiki'),
        manifest('media', 'beta', 'javascript:alert(1)'),
        { id: 'BAD ID', publicOrigin: 'https://x.example' },
    ]);
    assert.strictEqual(await dir.refresh(), true);
    assert.strictEqual(changes, 1, 'a new list rebuilds the catalog');
    assert.strictEqual(dir.origin('community'), 'https://community.example.org', 'origins come from the registry');
    assert.deepStrictEqual(dir.linkable().map(s => s.id), ['network', 'community'], 'placeholders, retired services and bad origins are not linked');
    assert.strictEqual(dir.origin('media'), 'https://openvibe.media', 'a service without a usable origin falls back to the known one');
    const snap = dir.snapshot();
    assert.strictEqual(snap.source, 'registry');
    assert.strictEqual(snap.registry, 'https://openvibe.network/api/v1/registry/services', 'the catalog names the public registry, not the internal address');
    assert.ok(snap.as_of);
    assert.ok(!JSON.stringify(snap).includes('runtime'), 'health readings are not frozen into the cached catalog');

    await dir.refresh();
    assert.strictEqual(changes, 1, 'the same list does not rebuild anything');
    const asOf = dir.snapshot().as_of;
    fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });
    assert.strictEqual(await dir.refresh(), false);
    assert.strictEqual(dir.origin('community'), 'https://community.example.org', 'a failed refresh keeps the last good list');
    assert.strictEqual(dir.snapshot().as_of, asOf);
    fetchImpl = answer([]);
    assert.strictEqual(await dir.refresh(), false, 'an empty list is not accepted');

    // ── Wired into the gateway catalog and pages ────────────
    const realFetch = globalThis.fetch;
    globalThis.fetch = answer([
        manifest('network', 'stable', 'https://openvibe.network', 'OpenVibe.Network'),
        manifest('community', 'alpha', 'https://community.example.org', 'OpenVibe.Community'),
        manifest('games', 'stable', 'https://openvibe.games', 'OpenVibe.Games'),
        manifest('media', 'beta', 'https://openvibe.media', 'OpenVibe.Media'),
        manifest('live', 'placeholder', 'https://openvibe.live', 'OpenVibe.Live'),
    ]);
    try {
        const registry = require('../server/registry');
        const site = require('../server/pages/site');
        const before = registry.catalog();
        assert.strictEqual(before.services.source, 'fallback');
        assert.strictEqual(before.tools.find(t => t.id === 'pastes').url, 'https://openvibe.community/pastes');
        await registry.services.refresh();
        const after = registry.catalog();
        assert.strictEqual(after.services.source, 'registry');
        assert.notStrictEqual(after.updated, before.updated, 'the catalog was rebuilt');
        assert.strictEqual(after.tools.find(t => t.id === 'pastes').url, 'https://community.example.org/pastes', 'the pastes tool points where the registry says Community is');
        const html = site.renderNotFound();
        assert.ok(html.includes('href="https://community.example.org/"'), 'the network links use registry origins');
        assert.ok(!html.includes('href="https://openvibe.live/"'), 'a service the registry calls a placeholder is not linked');
    } finally {
        globalThis.fetch = realFetch;
    }

    console.log('registry-driven catalog: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
