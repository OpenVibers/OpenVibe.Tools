'use strict';
// Provider keys live in the satellite's config (apps/maps/server/config.js) and are handed to each
// source — never read from the environment inside a source module, never a key in the code.
// The transport is mocked (setEgress), so nothing touches the network:
//   1. the RIDB key the caller passes reaches the RIDB request,
//   2. that key never appears in the search results a caller gets back,
//   3. with no RIDB key, RIDB sends nothing and search still answers (an empty list),
//   4. no file under apps/ carries the USDA demo API key placeholder.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { createEgress } = require('../../_shared/egress');
const { setEgress } = require('../server/egress');

const RIDB_KEY = 'sentinel-ridb-key-not-a-secret';

// A guard whose transport records every request and answers 200 with a small JSON body.
const requests = [];
setEgress(createEgress({
    lookup: (host, opts, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }]),
    httpsRequest: (opts, cb) => {
        requests.push({ hostname: opts.hostname, path: opts.path, opts: { headers: opts.headers } });
        const req = new EventEmitter();
        req.destroy = () => {};
        req.end = () => process.nextTick(() => {
            const res = new EventEmitter();
            res.statusCode = 200; res.statusMessage = 'OK'; res.headers = {}; res.destroy = () => {};
            cb(res);
            process.nextTick(() => { res.emit('data', Buffer.from('{"RECDATA":[]}')); res.emit('end'); });
        });
        return req;
    },
}));

const ridb = require('../server/sources/ridb');

(async () => {
    let failures = 0;
    const check = async (name, fn) => {
        try { await fn(); console.log(`  ✓ ${name}`); }
        catch (e) { failures++; console.log(`  ✗ ${name}\n    ${String(e.stack || e.message).split('\n').slice(0, 8).join('\n    ')}`); }
    };

    await check('the injected RIDB key reaches the RIDB request', async () => {
        requests.length = 0;
        await ridb.search(47.6062, -122.3321, 25, RIDB_KEY);
        assert.ok(requests.length > 0, 'RIDB sent a request');
        for (const r of requests) {
            assert.ok(/recreation\.gov/.test(`https://${r.hostname}${r.path}`), `request goes to RIDB: ${r.hostname}${r.path}`);
            assert.strictEqual(r.opts.headers && r.opts.headers.apikey, RIDB_KEY, `apikey header on ${r.hostname}${r.path}`);
        }
    });

    await check('the RIDB key never appears in the search results a caller gets back', async () => {
        requests.length = 0;
        const results = await ridb.search(47.6062, -122.3321, 25, RIDB_KEY);
        assert.ok(Array.isArray(results), 'search answers with a list');
        assert.ok(!JSON.stringify(results).includes(RIDB_KEY), 'the key is not in the results');
    });

    await check('with no RIDB key, RIDB sends no request and search still answers', async () => {
        for (const key of ['', undefined, null]) {
            requests.length = 0;
            const results = await ridb.search(47.6062, -122.3321, 25, key);
            assert.strictEqual(requests.length, 0, `no request sent for key ${JSON.stringify(key)}`);
            assert.deepStrictEqual(results, [], 'search answers with an empty list');
        }
    });

    await check('no file under apps/ carries the USDA demo API key', async () => {
        const root = path.join(__dirname, '..', '..');
        const needle = ['DEMO', 'KEY'].join('_'); // split so this file does not match itself
        const hits = [];
        (function walk(dir) {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                if (e.name === 'node_modules' || e.name === '.git') continue;
                const p = path.join(dir, e.name);
                if (e.isDirectory()) walk(p);
                else if (fs.readFileSync(p).includes(needle)) hits.push(path.relative(root, p));
            }
        })(root);
        assert.deepStrictEqual(hits, [], `files carrying the demo key: ${hits.join(', ')}`);
    });

    if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
    console.log('\nprovider keys come from config: all checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
