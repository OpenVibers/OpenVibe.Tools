-- phase: expand
-- tool_opens_daily: how many people opened each tool's page on a UTC day (apps/gateway/server/registry/opens.js),
-- for the home page's "Most opened this week". A count per tool per day and nothing else: no address, no person,
-- no page. Additive: a new empty table.
CREATE TABLE IF NOT EXISTS tool_opens_daily (
    tool  text NOT NULL,
    day   date NOT NULL,
    opens integer NOT NULL DEFAULT 0,
    PRIMARY KEY (tool, day)
);
CREATE INDEX IF NOT EXISTS tool_opens_daily_day ON tool_opens_daily (day);
