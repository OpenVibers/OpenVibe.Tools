'use strict';
const crypto = require('node:crypto');
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_FRAME = 48 * 1024 * 1024;
const TYPES = ['img.process', 'docs.process', 'audio.process'];
const hash = token => crypto.createHash('sha256').update(token).digest('hex');
const signature = (key, id, timestamp, nonce) => crypto.createHmac('sha256', key).update(`${id}\n${timestamp}\n${nonce}`).digest('hex');
function sign(token, id) {
    const timestamp = String(Date.now()), nonce = crypto.randomBytes(16).toString('hex');
    return { 'x-worker-id': id, 'x-worker-time': timestamp, 'x-worker-nonce': nonce, 'x-worker-signature': signature(hash(token), id, timestamp, nonce) };
}
function verify(key, headers, now = Date.now()) {
    const id = headers['x-worker-id'], ts = headers['x-worker-time'], nonce = headers['x-worker-nonce'], sig = headers['x-worker-signature'];
    if (!/^wrk_[a-f0-9]{24}$/.test(id || '') || !/^\d{13}$/.test(ts || '') || Math.abs(now - Number(ts)) > 30000 || !/^[a-f0-9]{32}$/.test(nonce || '') || !/^[a-f0-9]{64}$/.test(sig || '')) return false;
    return crypto.timingSafeEqual(Buffer.from(signature(key, id, ts, nonce), 'hex'), Buffer.from(sig, 'hex'));
}
function bytes(file) {
    if (!file || typeof file.bytes !== 'string' || file.bytes.length > Math.ceil(MAX_BYTES / 3) * 4) throw new Error('invalid file bytes');
    const b = Buffer.from(file.bytes, 'base64');
    if (!b.length || b.length > MAX_BYTES || b.toString('base64') !== file.bytes) throw new Error('file exceeds worker transfer limit');
    return b;
}
module.exports = { MAX_BYTES, MAX_FRAME, TYPES, hash, sign, verify, bytes };
