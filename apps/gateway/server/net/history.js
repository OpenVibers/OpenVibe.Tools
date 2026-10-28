'use strict';
// Domain history: the public registration facts of every domain looked up on the WHOIS and RDAP tools, kept over time
// (migration 0008; the owner, 2026-10-28: "all our platforms should also be keeping… historical data or trends… caching
// of Whois data or domain lookups… historical or archive data or like lists or other useful tools… comparisons").
//
// What is kept is what RDAP publishes for anyone: the registrar, the registration, change and expiry dates, the status
// codes, the name servers and whether DNSSEC is on. Never a registrant's, admin's or tech contact's name, address, email
// or phone, and never who looked. A new snapshot is written only when those facts change; a lookup that finds them the
// same moves the last snapshot's last_seen. The lists ("most looked up", "expiring soon") show a domain only after
// MIN_LISTED lookups, so a person checking their own new domain never puts it on a public list.
const crypto = require('crypto');

const MIN_LISTED = 5;
const MAX_SNAPSHOTS = 200;

const lower = (s) => String(s || '').trim().toLowerCase();

/** The public facts of an RDAP domain answer (the route's summary or the raw RDAP document). */
function factsFromRdap(data) {
    const d = data || {};
    const events = (d.events || []).map((e) => ({ action: e.eventAction || e.action, date: e.eventDate || e.date }));
    const at = (...names) => { const e = events.find((x) => names.includes(String(x.action || '').toLowerCase())); return e && e.date ? new Date(e.date).toISOString() : null; };
    const registrarEntity = (d.entities || []).find((e) => (e.roles || []).includes('registrar'));
    const vcardName = (e) => (e && e.vcardArray && Array.isArray(e.vcardArray[1]) ? (e.vcardArray[1].find((v) => v[0] === 'fn') || [])[3] : null) || (e && e.name) || null;
    const nameservers = (d.nameservers || []).map((ns) => lower(typeof ns === 'string' ? ns : ns.ldhName || ns.unicodeName)).filter(Boolean).sort();
    return {
        registrar: registrarEntity ? String(vcardName(registrarEntity) || registrarEntity.handle || '').slice(0, 200) || null : null,
        created: at('registration'),
        updated: at('last changed'),   // never "last update of RDAP database": that moves every day by itself
        expires: at('expiration'),
        status: [...new Set((d.status || []).map((s) => lower(s)))].sort(),
        nameservers: [...new Set(nameservers)],
        dnssec: d.secureDNS && typeof d.secureDNS.delegationSigned === 'boolean' ? d.secureDNS.delegationSigned : null,
    };
}

const digestOf = (facts) => crypto.createHash('sha256').update(JSON.stringify(facts)).digest('hex').slice(0, 32);

/** What changed between two snapshots' facts: [{ field, before, after }]. */
function changesBetween(a, b) {
    const out = [];
    for (const field of ['registrar', 'created', 'expires', 'status', 'nameservers', 'dnssec']) {
        const x = a ? a[field] : null, y = b ? b[field] : null;
        if (JSON.stringify(x) !== JSON.stringify(y)) out.push({ field, before: x === undefined ? null : x, after: y === undefined ? null : y });
    }
    return out;
}

function createDomainHistory({ db, log = console, now = () => new Date() } = {}) {
    /** Keep one lookup's facts (RDAP domain answers only); never throws into the tool's answer. */
    async function record(domain, rdap) {
        if (!db) return null;
        const name = lower(domain);
        if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name) || name.length > 253 || !/[a-z]/.test(name.split('.').pop())) return null;
        const facts = factsFromRdap(rdap);
        const digest = digestOf(facts);
        const at = now().toISOString();
        try {
            const last = await db.maybe('SELECT id, digest FROM domain_snapshots WHERE domain = $1 ORDER BY first_seen DESC, id DESC LIMIT 1', [name]);
            if (last && last.digest === digest) await db.exec('UPDATE domain_snapshots SET last_seen = $2, seen = seen + 1 WHERE id = $1', [last.id, at]);
            else await db.exec('INSERT INTO domain_snapshots (domain, facts, digest, first_seen, last_seen) VALUES ($1, $2::jsonb, $3, $4, $4)', [name, JSON.stringify(facts), digest, at]);
            await db.exec(`INSERT INTO domain_lookups (domain, lookups, last_at, registrar, expires_at) VALUES ($1, 1, $2, $3, $4)
                ON CONFLICT (domain) DO UPDATE SET lookups = domain_lookups.lookups + 1, last_at = EXCLUDED.last_at, registrar = EXCLUDED.registrar, expires_at = EXCLUDED.expires_at`,
            [name, at, facts.registrar, facts.expires]);
            return { changed: !last || last.digest !== digest, facts };
        } catch (err) {
            if (log.warn) log.warn('[tools] domain history not kept:', err.message);
            return null;
        }
    }

    /** One domain's history: its snapshots (newest first) and what changed at each. */
    async function history(domain) {
        const name = lower(domain);
        const rows = await db.many('SELECT facts, first_seen, last_seen, seen FROM domain_snapshots WHERE domain = $1 ORDER BY first_seen DESC, id DESC LIMIT $2', [name, MAX_SNAPSHOTS]);
        const snapshots = rows.map((r) => ({ facts: typeof r.facts === 'string' ? JSON.parse(r.facts) : r.facts, first_seen: new Date(r.first_seen).toISOString(), last_seen: new Date(r.last_seen).toISOString(), seen: Number(r.seen) }));
        const changes = [];
        for (let i = 0; i < snapshots.length - 1; i++) {
            const diff = changesBetween(snapshots[i + 1].facts, snapshots[i].facts);
            if (diff.length) changes.push({ at: snapshots[i].first_seen, changes: diff });
        }
        const lookups = await db.maybe('SELECT lookups FROM domain_lookups WHERE domain = $1', [name]);
        return { domain: name, snapshots, changes, lookups: lookups ? Number(lookups.lookups) : 0, first_seen: snapshots.length ? snapshots[snapshots.length - 1].first_seen : null };
    }

    /** The public lists: the most looked up domains and those of them expiring within 60 days (MIN_LISTED lookups each). */
    async function lists({ limit = 20 } = {}) {
        const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
        const most = await db.many('SELECT domain, lookups, registrar, expires_at FROM domain_lookups WHERE lookups >= $1 ORDER BY lookups DESC, domain LIMIT $2', [MIN_LISTED, n]);
        const soon = await db.many(`SELECT domain, lookups, registrar, expires_at FROM domain_lookups
            WHERE lookups >= $1 AND expires_at IS NOT NULL AND expires_at > $2 AND expires_at < $3 ORDER BY expires_at LIMIT $4`,
        [MIN_LISTED, now().toISOString(), new Date(now().getTime() + 60 * 86400000).toISOString(), n]);
        const row = (r) => ({ domain: r.domain, lookups: Number(r.lookups), registrar: r.registrar || null, expires: r.expires_at ? new Date(r.expires_at).toISOString() : null });
        return { most_looked_up: most.map(row), expiring_soon: soon.map(row), min_lookups: MIN_LISTED };
    }

    return { record, history, lists };
}

module.exports = { createDomainHistory, factsFromRdap, changesBetween, MIN_LISTED };
