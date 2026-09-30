'use strict';
// The guard's Lua on a real Valkey (npm run test:pg sets VALKEY_URL; guard.test.js runs the same rules
// on an in-process emulation): quota.js CHARGE decides and charges every bucket and day allowance of a
// run at once, so a run refused on the day leg spends no bucket token and concurrent runs never
// overshoot the day; store.js DAY_CHARGE is the same all-or-nothing check-and-increment for the day
// counters alone. Keys live under a random prefix and are deleted at the end.
const assert = require('assert');
const crypto = require('crypto');
const { dep } = require('./deps');
const { createQuotas } = require('../guard/quota');
const { createGuardStore } = require('../guard/store');

const quiet = { log() {}, warn() {}, error() {} };

(async () => {
    if (!process.env.VALKEY_URL) {
        console.log('guard valkey: skipped (no VALKEY_URL: npm run test:pg runs the Lua on a real Valkey)');
        return;
    }
    const prefix = `ov:tools-test:${crypto.randomBytes(6).toString('hex')}:`;
    const valkey = dep('openvibe-sdk/valkey').createValkey({ url: process.env.VALKEY_URL, prefix, log: quiet });
    try {
        const table = {
            fetch: { anonymous: { perMinute: 1, burst: 5, perDay: 3 } },
            wide: { anonymous: { perMinute: 600, burst: 600, perDay: 3 } },
            session: { session: { perMinute: 60, burst: 10, perDay: 100 }, anonymous: { perMinute: 60, burst: 10, perDay: 100 } },
        };
        let clock = Date.UTC(2026, 8, 23, 23, 59, 58);
        const store = createGuardStore({ valkey, app: 'test', now: () => clock, log: quiet });
        const q = createQuotas({ store, valkey, quotas: () => table, now: () => clock, log: quiet });
        const anon = (ip) => ({ tier: 'anonymous', ipKey: `ip:${ip}`, key: `ip:${ip}` });

        // A day refusal spends nothing: 2 runs fit, cost-2 runs are refused on the day leg (2 + 2 > 3)
        // though the bucket holds 3, and the next day a cost-3 run still finds those 3 tokens.
        const c = anon('a');
        for (let i = 0; i < 2; i++) assert.ok((await q.check(c, { quotaClass: 'fetch', cost: 1 })).ok);
        for (let i = 0; i < 5; i++) assert.strictEqual((await q.check(c, { quotaClass: 'fetch', cost: 2 })).binding, 'day');
        clock += 2000;
        assert.strictEqual((await q.check(c, { quotaClass: 'fetch', cost: 3 })).ok, true, 'the refused runs took no token');
        const short = await q.check(c, { quotaClass: 'fetch', cost: 1 });
        assert.strictEqual(short.ok, false, 'and now the bucket is empty');

        // Report mode charges a refused run (the work happens anyway).
        const rep = anon('r');
        for (let i = 0; i < 3; i++) assert.ok((await q.check(rep, { quotaClass: 'wide', cost: 1 })).ok);
        assert.strictEqual((await q.check(rep, { quotaClass: 'wide', cost: 1 }, { report: true })).ok, false);
        const used = await store.dayCharge(new Date(clock).toISOString().slice(0, 10), [{ key: 'ip:r', cls: 'wide', n: 0, limit: 0 }], { commit: false });
        assert.deepStrictEqual(used.used, [4], 'report mode counted the refused run');

        // Concurrency: 30 runs at once against a day allowance of 3.
        const all = await Promise.all(Array.from({ length: 30 }, () => q.check(anon('c'), { quotaClass: 'wide', cost: 1 })));
        assert.strictEqual(all.filter((r) => r.ok).length, 3, 'exactly 3 of 30 concurrent runs');

        // A session run charges the session and its address together, all or nothing.
        const s1 = { tier: 'session', key: 'session:1', ipKey: 'ip:s' };
        assert.ok((await q.check(s1, { quotaClass: 'session', cost: 10 })).ok);
        const s2 = { tier: 'session', key: 'session:2', ipKey: 'ip:s' };
        const r = await q.check(s2, { quotaClass: 'session', cost: 10 });
        assert.ok(r.ok || r.scope === 'address', 'the address share binds, not the fresh session');

        // DAY_CHARGE alone (quotas without Valkey): atomic and all or nothing.
        const day = '2026-09-24';
        const direct = await Promise.all(Array.from({ length: 12 }, () => store.dayCharge(day, [{ key: 'k', cls: 'c', n: 1, limit: 4 }])));
        assert.strictEqual(direct.filter((x) => x.ok).length, 4, 'dayCharge: 4 of 12');
        const both = await store.dayCharge(day, [{ key: 'k2', cls: 'c', n: 1, limit: 5 }, { key: 'k', cls: 'c', n: 1, limit: 4 }]);
        assert.strictEqual(both.ok, false);
        assert.deepStrictEqual((await store.dayCharge(day, [{ key: 'k2', cls: 'c', n: 0, limit: 0 }], { commit: false })).used, [0], 'k2 untouched');
        const forced = await store.dayCharge(day, [{ key: 'k', cls: 'c', n: 1, limit: 4 }], { force: true });
        assert.deepStrictEqual([forced.ok, forced.used], [false, [4]], 'force (report mode) charges past the limit');

        // The salt: one per day, shared.
        await store.warm();
        const other = createGuardStore({ valkey, app: 'other', now: () => clock, log: quiet });
        await other.warm();
        assert.strictEqual(other.salt(), store.salt(), 'one salt in Valkey');

        console.log('guard valkey: CHARGE (a refused run spends nothing, report mode counts, 3 of 30 concurrent, session + address), DAY_CHARGE (atomic, all or nothing, force), shared salt: all checks passed');
    } finally {
        const keys = await valkey.client.keys(`${prefix}*`);
        if (keys.length) await valkey.client.del(...keys);
        await valkey.close();
    }
})().catch((err) => { console.error(err); process.exit(1); });
