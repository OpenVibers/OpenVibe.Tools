'use strict';
// A counting semaphore with a bounded wait list: at most `max` holders, at most `queue` waiting, each
// for at most `waitMs`. acquire() → a release function, or a Busy error ('queue' | 'timeout').
// createPacer spaces calls to an upstream that asks for it (below).

class Busy extends Error {
    constructor(reason) { super(reason === 'queue' ? 'Too many requests are waiting' : 'Waited too long for a free slot'); this.reason = reason; }
}

function createSemaphore({ max = 2, queue = 8, waitMs = 30_000 } = {}) {
    let active = 0;
    const waiting = [];

    function release() {
        const next = waiting.shift();
        if (next) { clearTimeout(next.timer); next.resolve(once()); } else active = Math.max(0, active - 1);
    }
    function once() {
        let done = false;
        return () => { if (!done) { done = true; release(); } };
    }

    function acquire() {
        if (active < max) { active++; return Promise.resolve(once()); }
        if (waiting.length >= queue) return Promise.reject(new Busy('queue'));
        return new Promise((resolve, reject) => {
            const w = { resolve, timer: null };
            w.timer = setTimeout(() => {
                const i = waiting.indexOf(w);
                if (i >= 0) waiting.splice(i, 1);
                reject(new Busy('timeout'));
            }, waitMs);
            waiting.push(w);
        });
    }

    return { acquire, stats: () => ({ active, waiting: waiting.length, max, queue }) };
}

/**
 * A pacer for an upstream with a usage policy (Nominatim: one request a second): run() starts each
 * call at least `minIntervalMs` after the previous one, with at most `queue` calls waiting; a call
 * that would wait longer than `maxWaitMs` is refused with Busy('queue') rather than piling up.
 */
function createPacer({ minIntervalMs = 1000, queue = 20, maxWaitMs = 15_000 } = {}) {
    let next = 0, waiting = 0;
    async function run(fn) {
        const t = Date.now();
        const at = Math.max(t, next);
        if (waiting >= queue || at - t > maxWaitMs) throw new Busy('queue');
        next = at + minIntervalMs;
        waiting++;
        try {
            if (at > t) await new Promise(r => setTimeout(r, at - t));
        } finally { waiting--; }
        return fn();
    }
    return { run, stats: () => ({ waiting }) };
}

module.exports = { createSemaphore, createPacer, Busy };
