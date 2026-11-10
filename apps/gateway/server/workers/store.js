'use strict';
const crypto = require('node:crypto');
const { hash } = require('../../../worker/server/protocol');
function createStore(db) {
    return {
        async mint({ label, location = 'home' }) {
            if (typeof label !== 'string' || !/^[\w .-]{1,80}$/.test(label) || !['home', 'host'].includes(location)) throw new Error('invalid worker label or location');
            const id = `wrk_${crypto.randomBytes(12).toString('hex')}`;
            const token = crypto.randomBytes(32).toString('base64url');
            await db.prepare('INSERT INTO tools_workers (id,label,location,token_hash,created_at) VALUES (?,?,?,?,?)').run(id, label, location, hash(token), Date.now());
            return { id, token }; // One response only; listing never selects token_hash.
        },
        lookup: id => db.prepare('SELECT id,token_hash,location,draining FROM tools_workers WHERE id=? AND revoked=FALSE').get(id),
        list: () => db.prepare('SELECT id,label,location,draining,revoked,created_at FROM tools_workers ORDER BY created_at').all(),
        routing: () => db.prepare('SELECT enabled,worker_order FROM tools_worker_routing WHERE id=1').get(),
    };
}
module.exports = { createStore };
