'use strict';
// /made-sandbox (plan 2026-11-13 §AD.12 (c)): where a code tool people made runs in the browser. Its own policy, not the
// site's: no network (default-src 'none', so no connect-src), scripts only inline and the Worker's blob, framed only by
// openvibe.tools; the code runs in a Worker (an endless loop never freezes the tab) and answers only its parent.
const assert = require('assert');
const http = require('http');
const express = require('express');
const { sandboxPage, POLICY, PAGE } = require('../server/made/sandbox');

(async () => {
    const app = express();
    app.use((req, res, next) => { res.set('X-Frame-Options', 'SAMEORIGIN'); res.set('Content-Security-Policy', "default-src 'self'"); next(); });
    app.get('/made-sandbox', sandboxPage);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((ok) => server.once('listening', ok));
    try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/made-sandbox`);
        assert.strictEqual(res.status, 200);
        const csp = res.headers.get('content-security-policy');
        assert.strictEqual(csp, POLICY, 'its own policy replaces the site\'s');
        assert.match(csp, /default-src 'none'/);
        assert.ok(!/connect-src/.test(csp), 'no network: nothing names a host to reach');
        assert.match(csp, /worker-src blob:/);
        assert.match(csp, /frame-ancestors 'self'/);
        assert.strictEqual(res.headers.get('x-frame-options'), null, 'framed by openvibe.tools (frame-ancestors says who)');
        const html = await res.text();
        assert.ok(html.includes('new Worker(') && html.includes('e.source !== parent'), 'a Worker runs the code; only the parent is heard');
        assert.strictEqual(html, PAGE);
    } finally { server.close(); }
    console.log('made sandbox: its own policy (no network, blob Workers, framed by openvibe.tools), the code in a Worker');
})().catch((err) => { console.error(err); process.exit(1); });
