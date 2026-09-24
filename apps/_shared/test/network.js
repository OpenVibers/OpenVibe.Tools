'use strict';
// A stand-in OpenVibe.Network for tests that run real Tools processes: it serves the JWKS endpoint
// (GET /api/.well-known/jwks → { public_key }) and signs the tokens the Network would issue — a
// person's browser sign-in (aud openvibe.tools, subject_id usr_…) and service or app principals
// (client credentials: aud openvibe.tools, cap[]). Point OV_NETWORK_URL and OV_NETWORK_INTERNAL_URL
// at `url`; the issuer is `url` too.
const crypto = require('crypto');
const http = require('http');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

async function startNetwork() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const srv = http.createServer((req, res) => {
        if (req.url.startsWith('/api/.well-known/jwks')) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ public_key: publicKey, algorithm: 'RS256' })); }
        res.statusCode = 404; return res.end('{}');
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}`;
    const now = () => Math.floor(Date.now() / 1000);
    const sign = (claims) => {
        const head = b64({ alg: 'RS256', typ: 'JWT' });
        const body = b64(claims);
        const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
        return `${head}.${body}.${sig}`;
    };
    let n = 0;
    const ulid = () => `01J${crypto.randomBytes(16).toString('hex').toUpperCase().replace(/[^0-9A-HJKMNP-TV-Z]/g, 'Z').slice(0, 23)}`;
    return {
        url, issuer: url, publicKey,
        /** A signed-in person (what the Network puts in ov_token). */
        user(extra = {}) {
            n++;
            return sign({ iss: url, sub: String(1000 + n), id: 1000 + n, subject_id: `usr_${ulid()}`, username: `person${n}`, aud: ['openvibe.live', 'openvibe.tools', 'openvibe.network'], iat: now(), exp: now() + 3600, ...extra });
        },
        /** A service principal's client-credentials token with these capabilities. */
        service(cap, extra = {}) {
            return sign({ iss: url, sub: `svc:${extra.name || 'partner'}`, actor_type: 'service', aud: ['openvibe.tools'], cap, ns: [], iat: now(), exp: now() + 900, jti: `tok_${crypto.randomBytes(12).toString('hex')}`, ...extra, name: undefined });
        },
        sign,
        close: () => new Promise(r => srv.close(r)),
    };
}

module.exports = { startNetwork };
