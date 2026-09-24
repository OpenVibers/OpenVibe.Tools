'use strict';
// A worker module for pool.test.js: each op exercises one thing the pool must survive.
const { threadId } = require('worker_threads');

const spin = (ms) => { const end = Date.now() + ms; let x = 0; while (Date.now() < end) x += Math.random(); return x; };

module.exports = {
    echo: async (payload) => ({ payload, threadId }),
    double: async ({ buf }) => ({ out: Buffer.concat([Buffer.from(buf), Buffer.from(buf)]), small: Buffer.from('ok'), threadId }),
    spin: async ({ ms }) => { spin(ms); return { threadId }; },
    // Keeps every chunk reachable until the heap limit ends the thread.
    hog: async () => { const keep = []; for (;;) keep.push(new Array(1e6).fill(Math.random())); },
    fail: async ({ status, code, extra }) => { throw Object.assign(new Error('refused on purpose'), { status, code, expose: true, extra, guardReason: 'test' }); },
    crash: async () => { setTimeout(() => { throw new Error('boom'); }, 1); return new Promise(() => {}); },
    env: async ({ name }) => ({ value: process.env[name] || null }),
};
