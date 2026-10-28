-- phase: expand
-- domain_snapshots: the public registration facts (RDAP: registrar, dates, status, name servers, DNSSEC) of each domain
-- someone looked up on the WHOIS and RDAP tools, kept over time (apps/gateway/server/net/history.js; the owner,
-- 2026-10-28: "caching of Whois data or domain lookups… historical or archive data… lists… comparisons"). A new row only
-- when the facts change; otherwise the last row's last_seen moves. Never a registrant's contact details, never who looked.
-- domain_lookups: how often each domain was looked up, for the "most looked up" and "expiring soon" lists (a domain is
-- listed only after five lookups, so nobody's own new domain shows there). Additive: two new empty tables.
CREATE TABLE IF NOT EXISTS domain_snapshots (
    id         bigserial PRIMARY KEY,
    domain     text NOT NULL,
    facts      jsonb NOT NULL,
    digest     text NOT NULL,
    first_seen timestamptz NOT NULL DEFAULT now(),
    last_seen  timestamptz NOT NULL DEFAULT now(),
    seen       integer NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS domain_snapshots_domain ON domain_snapshots (domain, first_seen DESC);

CREATE TABLE IF NOT EXISTS domain_lookups (
    domain     text PRIMARY KEY,
    lookups    integer NOT NULL DEFAULT 0,
    last_at    timestamptz NOT NULL DEFAULT now(),
    registrar  text,
    expires_at timestamptz
);
CREATE INDEX IF NOT EXISTS domain_lookups_lookups ON domain_lookups (lookups DESC);
CREATE INDEX IF NOT EXISTS domain_lookups_expires ON domain_lookups (expires_at);
