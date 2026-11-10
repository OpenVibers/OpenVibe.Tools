'use strict';
function ownerGuard({ verify, extractToken, origin, username = process.env.OWNER_USERNAME || 'goosely' }) {
    return async (req, res, next) => {
        res.set('Cache-Control', 'no-store');
        try {
            const claims = await verify(extractToken(req));
            if (!claims || String(claims.username || '').toLowerCase() !== username.toLowerCase()) return res.status(403).json({ error: 'Owner access required' });
            if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin !== origin) return res.status(403).json({ error: 'Origin required' });
            next();
        } catch { res.status(403).json({ error: 'Owner access required' }); }
    };
}
module.exports = { ownerGuard };
