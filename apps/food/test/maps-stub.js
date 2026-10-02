'use strict';
// A stand-in for the maps satellite for the food tests (apps/food/test/*): one local HTTP server, no
// external network and no maps process. Its mode decides what /api/* answers, and every request it
// saw is recorded (path, query keys, headers) so a test can check what food forwarded.
const http = require('http');

const SECRET = 'sk-live-UPSTREAM-SECRET';
const INTERNAL_URL = 'https://maps.internal:9001/internal/secret';

/**
 * @returns {Promise<{ base, setMode, requests, close }>} modes:
 *   ok      — 200 { ok, items }
 *   boom    — 500 JSON that carries an upstream URL and key (and an X-Upstream-Secret header)
 *   badjson — 200 whose body is not JSON
 *   hang    — never answers, so food's own 15 s timeout fires
 *   skipped — 200 { ok, sources: [{ skipped: true }] }, what maps answers with no provider key set
 */
function startMapsStub() {
    let mode = 'ok';
    const requests = [];
    const server = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://stub.invalid');
        requests.push({ path: u.pathname, params: [...u.searchParams.keys()], headers: req.headers });
        if (u.pathname === '/api/ready') {                                  // food boots only once this answers
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ status: 'ok' }));
        }
        if (mode === 'boom') {
            res.writeHead(500, { 'Content-Type': 'application/json', 'X-Upstream-Secret': SECRET });
            return res.end(JSON.stringify({ error: 'upstream blew up', url: INTERNAL_URL, key: SECRET }));
        }
        if (mode === 'badjson') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end('{this is not json');
        }
        if (mode === 'hang') return;
        if (mode === 'skipped') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true, sources: [{ name: 'RIDB', skipped: true, reason: 'RIDB_API_KEY is not set' }], items: [] }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, items: [{ name: 'rice' }] }));
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        requests,
        setMode(m) { mode = m; },
        close: () => new Promise((r) => server.close(r)),
    })));
}

module.exports = { startMapsStub, SECRET, INTERNAL_URL };
