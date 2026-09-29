'use strict';
// better-sqlite3 for the operational scripts that read the pre-cutover SQLite files (the importer, the
// analytics prune's SQLite branch, the guard abuse report). No app depends on it any more (plan T8), so
// scripts/ has its own package.json: `npm --prefix scripts install`. An app that still has it installed
// (a host before the cutover deploy) is the fallback.
const path = require('path');

const APPS = path.join(__dirname, '..', 'apps');

function loadSqlite() {
    for (const dir of [__dirname, ...['gateway', 'maps', 'food', 'img', 'yt', 'audio', 'text', 'docs'].map((a) => path.join(APPS, a))]) {
        try { return require(require.resolve('better-sqlite3', { paths: [dir] })); } catch { /* next */ }
    }
    throw new Error('better-sqlite3 is not installed for scripts/ (run npm --prefix scripts install)');
}

module.exports = { loadSqlite };
