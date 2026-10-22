'use strict';
// Tool opens (server/registry/opens.js) and the home sections built on them and on the descriptors:
//   - a person's page load on a tool's host counts once per address, tool and day; crawlers and API calls never do;
//   - what is written is one number per tool and day (no address), and a failed write is kept for the next flush;
//   - the home shows "Most opened this week" only with real counts for at least four tools, plus the API section and
//     a FAQ that is also its FAQPage; a tool's page shows the one request that runs it.
const assert = require('assert');
const http = require('http');
const express = require('express');
const { createOpens } = require('../server/registry/opens');
const { hostRoles } = require('../server/registry/host-middleware');
const registry = require('../server/registry');
const site = require('../server/pages/site');

/** A db stand-in: tool_opens_daily as a Map, the two statements opens.js runs. */
function fakeDb({ failFirst = false } = {}) {
    const rows = new Map();
    const writes = [];
    let fail = failFirst;
    return {
        rows, writes,
        async exec(sql, [tool, day, n]) {
            if (fail) { fail = false; throw new Error('db down'); }
            writes.push([tool, day, n]);
            rows.set(`${tool}|${day}`, (rows.get(`${tool}|${day}`) || 0) + n);
        },
        async many(sql, [since, limit]) {
            const sum = new Map();
            for (const [k, n] of rows) { const [tool, day] = k.split('|'); if (day >= since) sum.set(tool, (sum.get(tool) || 0) + n); }
            return [...sum].map(([tool, opens]) => ({ tool, opens })).sort((a, b) => b.opens - a.opens || a.tool.localeCompare(b.tool)).slice(0, limit);
        },
    };
}

(async () => {
    const DAY = Date.parse('2026-10-22T12:00:00Z');
    let now = DAY;

    // ── counting ──
    {
        const db = fakeDb({ failFirst: true });
        const opens = createOpens({ db, now: () => now, log: { warn() {} } });
        assert.strictEqual(opens.record('dns', '10.0.0.1'), true);
        assert.strictEqual(opens.record('dns', '10.0.0.1'), false, 'the same address again the same day adds nothing');
        assert.strictEqual(opens.record('dns', '10.0.0.2'), true);
        assert.strictEqual(opens.record('whois', '10.0.0.1'), true, 'another tool counts');
        assert.strictEqual(opens.record('', '10.0.0.1'), false, 'no tool, no count');
        assert.strictEqual(await opens.flush(), 0, 'a failed write keeps the counts');
        assert.strictEqual(await opens.flush(), 3);
        assert.deepStrictEqual(db.writes.sort(), [['dns', '2026-10-22', 2], ['whois', '2026-10-22', 1]]);
        for (const w of db.writes) assert.ok(!w.join(' ').includes('10.0.0'), 'no address is written');
        now = DAY + 86_400_000;
        assert.strictEqual(opens.record('dns', '10.0.0.1'), true, 'a new day counts the address again');
        await opens.flush();
        assert.deepStrictEqual(await opens.top(7, 5), [{ tool: 'dns', opens: 3 }, { tool: 'whois', opens: 1 }]);
        db.rows.clear();
        now += 60_000;
        assert.deepStrictEqual(await opens.top(7, 5), [{ tool: 'dns', opens: 3 }, { tool: 'whois', opens: 1 }], 'read at most every 5 minutes');
        await db.exec('', ['dns', '2026-10-14', 9]);
        now = DAY + 9 * 86_400_000;
        assert.deepStrictEqual(await opens.top(7, 5), [], 'the last seven days only');
    }

    // ── the host middleware counts people opening a tool, nothing else ──
    {
        const seen = [];
        const tool = registry.get().tools.find((t) => !t.port && t.hosts.short);
        const mw = hostRoles({ hostOf: (req) => req.headers.host, isLegacyHost: () => false, enforce: false, onOpen: (id, req) => seen.push([id, req.ip]) });
        const chrome = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Safari/537.36';
        const run = (headers, method = 'GET') => new Promise((resolve) => {
            const req = { method, headers: { host: tool.hosts.short, ...headers }, ip: '10.1.1.1', originalUrl: '/' };
            const res = { set() {}, redirect() { resolve('redirect'); }, status() { return this; }, type() { return this; }, send() { resolve('sent'); } };
            mw(req, res, () => resolve('next'));
        });
        await run({ 'user-agent': chrome, accept: 'text/html', 'sec-fetch-dest': 'document' });
        await run({ 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)', accept: 'text/html' });
        await run({ 'user-agent': chrome, accept: 'application/json' });
        await run({ 'user-agent': chrome, accept: 'text/html' }, 'POST');
        assert.deepStrictEqual(seen, [[tool.id, '10.1.1.1']], 'one person opening the page; no crawler, API call or POST');
    }

    // ── the home and a tool page ──
    {
        const db = fakeDb();
        const opens = createOpens({ db, now: () => DAY });
        const app = express();
        app.use(site.createSiteRouter({ opens }));
        const srv = http.createServer(app);
        await new Promise((r) => srv.listen(0, '127.0.0.1', r));
        const base = `http://127.0.0.1:${srv.address().port}`;
        try {
            let home = await (await fetch(`${base}/`)).text();
            assert.ok(!home.includes('Most opened this week'), 'no counts yet: the section is not shown');
            assert.ok(home.includes('Good places to start'), 'the hand-picked list says what it is');
            assert.ok(home.includes('Use any tool from code') && home.includes('/api/v1/openapi.json'), 'the API section');
            assert.ok(/<b>\d+<\/b> with an API/.test(home), 'how many tools have an API');
            assert.ok(home.includes('"@type":"FAQPage"') && home.includes('<summary>Do I need an account?</summary>'), 'the FAQ and its JSON-LD');

            const ids = registry.get().tools.slice(0, 5).map((t) => t.id);
            ids.forEach((id, i) => { for (let k = 0; k <= i; k++) opens.record(id, `10.2.0.${k}`); });
            await opens.flush();
            const fresh = createOpens({ db, now: () => DAY });   // a new process reads the counts the first one wrote
            const app2 = express();
            app2.use(site.createSiteRouter({ opens: fresh }));
            const srv2 = http.createServer(app2);
            await new Promise((r) => srv2.listen(0, '127.0.0.1', r));
            try {
                home = await (await fetch(`http://127.0.0.1:${srv2.address().port}/`)).text();
                assert.ok(home.includes('Most opened this week'), 'real counts for five tools: the section shows');
                assert.ok(home.includes('5 people this week') && home.includes('1 person this week'), 'each with its count');
            } finally { srv2.close(); }

            const page = await (await fetch(`${base}/tool/dns`)).text();
            assert.ok(page.includes('Use it from code') && page.includes('https://openvibe.tools/api/v1/tools/dns/run'), 'a tool page names its request');
            assert.ok(page.includes('/api/v1/tools/dns/schema'), 'and its input schema');
            const file = registry.get().tools.find((t) => t.id === 'mergepdf');
            if (file) {
                const pdf = await (await fetch(`${base}/tool/mergepdf`)).text();
                assert.ok(pdf.includes('-F &#39;file=@document-1.pdf&#39;') || pdf.includes("-F 'file=@document-1.pdf'"), 'a file tool shows a multipart upload');
            }
        } finally { srv.close(); }
    }
    console.log('tool opens: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
