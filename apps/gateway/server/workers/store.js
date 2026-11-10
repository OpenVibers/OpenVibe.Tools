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
        async setRouting({ enabled, order }) {
            if (typeof enabled !== 'boolean' || !Array.isArray(order) || order.length > 128 || !order.length || new Set(order).size !== order.length || order.some(k => typeof k !== 'string' || !/^(home|host|wrk_[a-f0-9]{24})$/.test(k))) throw new Error('invalid routing');
            for (const id of order.filter(k => k.startsWith('wrk_'))) if (!await db.prepare('SELECT id FROM tools_workers WHERE id=? AND revoked=FALSE').get(id)) throw new Error('unknown worker');
            if (!order.includes('host')) order = [...order, 'host'];
            await db.prepare('UPDATE tools_worker_routing SET enabled=?,worker_order=? WHERE id=1').run(enabled, JSON.stringify(order));
            return { enabled, order };
        },
        lookup: id => db.prepare('SELECT id,token_hash,location,draining FROM tools_workers WHERE id=? AND revoked=FALSE').get(id),
        list: () => db.prepare('SELECT id,label,location,draining,revoked,created_at FROM tools_workers ORDER BY created_at').all(),
        routing: () => db.prepare('SELECT enabled,worker_order FROM tools_worker_routing WHERE id=1').get(),
    };
}
module.exports = { createStore };
