'use strict';
// A worker thread of the gateway's engine pool (apps/_shared/jobs/pool.js): runs one browser tool's
// server engine (apps/gateway/server/dev/engines.js, apps/text/server/engines.js) on a run's input,
// off the event loop and bounded (the descriptor's timeoutMs terminates it; a heap limit applies).
const loaded = new Map();

module.exports = {
    /** { module, name, input } → { data } | { text } */
    async run({ module, name, input }) {
        if (!loaded.has(module)) loaded.set(module, require(module));
        const fn = (loaded.get(module).ENGINES || {})[name];
        if (typeof fn !== 'function') throw Object.assign(new Error(`No server engine ${name}`), { status: 500 });
        return fn(input || {});
    },
};
