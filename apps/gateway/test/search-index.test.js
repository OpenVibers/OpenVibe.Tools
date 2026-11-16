'use strict';
/** Tools → Search: one search.index-document@1 per available tool, re-sent only when it changes, tombstoned when it leaves. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const contracts = require('openvibe-contracts');
const { createSearchIndexer } = require('../server/search-index');

const stored = new Map();   // id -> { revision, deleted, doc }
const calls = [];
const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    calls.push(`${opts.method} ${u.pathname}`);
    assert.strictEqual(opts.headers.Authorization, 'Bearer svc');
    const reply = (status, body) => ({ status, ok: status < 300, json: async () => body });
    if (opts.method === 'GET') return reply(200, { owner: 'tools', documents: [...stored].map(([id, d]) => ({ type: 'tool', id, revision: d.revision, deleted: d.deleted })), next_after: null });
    const id = u.pathname.split('/').pop();
    const prev = stored.get(id);
    if (opts.method === 'PUT') {
        const doc = { ...JSON.parse(opts.body), owner: 'tools', type: 'tool', id };
        const v = contracts.validate('search.index-document@1', doc);
        assert.ok(v.valid, JSON.stringify(v.errors));
        if (prev && doc.revision <= prev.revision) return reply(409, { code: 'search.stale_revision' });
        stored.set(id, { revision: doc.revision, deleted: false, doc });
        return reply(200, { outcome: 'applied' });
    }
    const revision = Number(u.searchParams.get('revision'));
    stored.set(id, { revision, deleted: true });
    return reply(200, { outcome: 'applied' });
};

const tool = (id, over = {}) => ({ id, family: 'dev', name: `${id} tool`, summary: `Does ${id}`, status: 'stable', execution: 'client', api: true, hosts: [`${id}.openvibe.tools`], keywords: [id, 'online'], ...over });
let tools = [tool('yaml'), tool('uuid'), tool('ping', { status: 'unavailable' })];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-search-'));
const make = () => createSearchIndexer({ snapshot: () => ({ tools, updated_at: '2026-09-24T00:00:00.000Z' }), searchUrl: 'http://search.test', tokens: { authHeaders: async () => ({ Authorization: 'Bearer svc' }) }, stateFile: path.join(dir, 'search-index.json'), fetchImpl, log: { warn() {} } });

(async () => {
    let ix = make();
    let s = await ix.run();
    assert.deepStrictEqual([s.upserted, s.unchanged, s.failed], [2, 0, 0]);
    assert.deepStrictEqual([...stored.keys()].sort(), ['uuid', 'yaml'], 'an unavailable tool is not indexed');
    const y = stored.get('yaml').doc;
    assert.strictEqual(y.canonical_url, 'https://yaml.openvibe.tools');
    assert.deepStrictEqual(y.facets, { family: 'dev', execution: 'client', api: true });
    assert.strictEqual(y.publication_state, 'published');

    calls.length = 0;
    s = await ix.run();
    assert.deepStrictEqual(calls, ['GET /api/v1/owners/tools/documents'], 'a quiet registry costs one listing');

    tools = [tool('yaml', { summary: 'Now faster' })];
    s = await ix.run();
    assert.strictEqual(stored.get('yaml').revision, 2, 'a change goes one revision up');
    assert.strictEqual(stored.get('yaml').doc.summary, 'Now faster');
    assert.deepStrictEqual(stored.get('uuid'), { revision: 2, deleted: true }, 'a removed tool is tombstoned above its revision');

    fs.rmSync(path.join(dir, 'search-index.json'));
    ix = make();
    s = await ix.run();
    assert.strictEqual(stored.get('yaml').revision, 3, 'lost state: re-sent above the stored revision, never refused as stale');
    assert.strictEqual(s.failed, 0);

    // The public tools people make: found beside the catalogue (one tool system, 11-15), id mtl.<ULID>, linked to /make.
    const MADE = 'mtl_01JCZ3NDEKTSV4RRFFQ69G5FAW';
    let made = [{ id: MADE, slug: 'reply-kindly', name: 'Reply kindly', summary: 'Drafts a kind reply.', kind: 'prompt', updated_at: new Date('2026-11-15T10:00:00Z') }];
    const withMade = () => createSearchIndexer({ snapshot: () => ({ tools, updated_at: '2026-09-24T00:00:00.000Z' }), searchUrl: 'http://search.test', tokens: { authHeaders: async () => ({ Authorization: 'Bearer svc' }) }, stateFile: path.join(dir, 'search-index.json'), fetchImpl, log: { warn() {} },
        madeTools: async () => { if (made === 'down') throw new Error('database down'); return made; } });
    ix = withMade();
    s = await ix.run();
    const m = stored.get('mtl.01JCZ3NDEKTSV4RRFFQ69G5FAW');
    assert.ok(m && !m.deleted, 'a public made tool is a document');
    assert.deepStrictEqual([m.doc.canonical_url, m.doc.title, m.doc.facets], [`https://openvibe.tools/make#${MADE}`, 'Reply kindly', { family: 'made', execution: 'prompt', api: true }]);
    assert.strictEqual(m.doc.updated_at, '2026-11-15T10:00:00.000Z');
    made = 'down';
    s = await ix.run();
    assert.strictEqual(stored.get('mtl.01JCZ3NDEKTSV4RRFFQ69G5FAW').deleted, false, 'made tools that cannot be read are left as they are');
    made = [];
    s = await ix.run();
    assert.strictEqual(stored.get('mtl.01JCZ3NDEKTSV4RRFFQ69G5FAW').deleted, true, 'a tool made private or deleted is tombstoned');
    assert.strictEqual(stored.get('yaml').deleted, false, 'the catalogue stays');
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('search index: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
