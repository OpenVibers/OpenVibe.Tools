'use strict';
const assert = require('assert');
const path = require('path');
const prune = require(path.resolve(__dirname, '..', '..', '..', 'scripts', 'analytics-prune.js'));
const report = require(path.resolve(__dirname, '..', '..', '..', 'scripts', 'guard-abuse-report.js'));
const { openToolsDb } = require('../db');
(async () => {
    await assert.rejects(prune.pgMain(['--app', 'yt'], () => {}), /--app does not apply/);
    const before = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://nobody@127.0.0.1:1/none';
    try {
        await assert.rejects(Promise.resolve().then(() => prune.main(['--app', 'yt', '--apply'], () => {})), /unknown option|--app does not apply/);
    } finally {
        if (before === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = before;
    }
    assert.throws(() => report.parseArgs(['--db', 'old.db']), /unknown option/);
    assert.throws(() => report.parseArgs(['--pg']), /unknown option/);
    const priorEnv = process.env.NODE_ENV;
    const priorUrl = process.env.DATABASE_URL;
    process.env.NODE_ENV = 'production';
    delete process.env.DATABASE_URL;
    let created = false;
    try {
        assert.throws(() => openToolsDb({ createDb: () => { created = true; } }), /DATABASE_URL is required in production/);
        assert.strictEqual(created, false, 'production fails before PGlite can open');
    } finally {
        if (priorEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = priorEnv;
        if (priorUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorUrl;
    }
    assert.deepStrictEqual(report.parseArgs(['--url', 'postgres://test/db', '--json']), { url: 'postgres://test/db', json: true });
    console.log('ops scripts: PostgreSQL commands reject obsolete SQLite options');
})().catch((err) => { console.error(err); process.exit(1); });
