'use strict';
// Domain history, readable by anyone (net/history.js): the WHOIS and RDAP pages' History card, the API and the SDK.
//
//   GET /api/v1/domains            the lists: the most looked up domains and those of them expiring within 60 days
//                                  (each looked up five times or more, so nobody's own new domain shows)
//   GET /api/v1/domains/:domain    one domain: its snapshots (registrar, dates, status, name servers, DNSSEC), newest
//                                  first, what changed when, and how often it was looked up
//
// Public registration facts only (RDAP's own), answered to any origin without credentials, kept a minute by caches.
const express = require('express');

const DOMAIN = /^(?=.{3,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/;

function createDomainHistoryRoutes({ history }) {
    const r = express.Router();
    r.use((req, res, next) => { res.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' }); next(); });
    r.get('/', async (req, res) => {
        try { res.json({ ok: true, ...(await history.lists({ limit: req.query.limit })) }); } catch { res.status(500).json({ ok: false, error: 'Domain history could not be read' }); }
    });
    r.get('/:domain', async (req, res) => {
        const domain = String(req.params.domain || '').trim().toLowerCase().replace(/\.$/, '');
        if (!DOMAIN.test(domain) || !/[a-z]/.test(domain.split('.').pop())) return res.status(400).json({ ok: false, error: 'Enter a full domain name (like example.com)' });
        try { res.json({ ok: true, ...(await history.history(domain)) }); } catch { res.status(500).json({ ok: false, error: 'Domain history could not be read' }); }
    });
    return r;
}

module.exports = { createDomainHistoryRoutes };
