'use strict';
// The one `tools` database for a test run (plan T8): one PGlite database per test directory, migrated
// with the repo's migrations. It is kept across a satellite restart (the data must survive it), so a
// test that restarts a satellite calls testDb() with the same directory again; closeAllTestDbs() at the
// end of the run. PGlite runs PostgreSQL in process.
const fs = require('fs');
const path = require('path');
const { dep } = require('./deps');

const MIGRATIONS = path.resolve(__dirname, '..', '..', '..', 'migrations');
const quiet = { log() {}, warn() {}, error() {} };
const dbs = new Map();

async function testDb(dir) {
    if (!dbs.has(dir)) {
        fs.mkdirSync(path.join(dir, 'pglite'), { recursive: true });
        const db = dep('openvibe-sdk/db').createDb({ pglite: path.join(dir, 'pglite'), service: 'tools-test', log: quiet });
        await db.migrate({ dir: MIGRATIONS, log: quiet });
        dbs.set(dir, db);
    }
    return dbs.get(dir);
}

async function closeAllTestDbs() {
    for (const db of dbs.values()) await db.close().catch(() => {});
    dbs.clear();
}

module.exports = { testDb, closeAllTestDbs, MIGRATIONS, quiet };
