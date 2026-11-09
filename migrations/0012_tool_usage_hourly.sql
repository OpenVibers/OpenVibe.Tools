-- phase: expand
-- Public discovery totals: successful runs, no inputs, addresses or actor identifiers.
-- Kept separately from expiring jobs. UTC epoch-hour buckets; no historical backfill.
CREATE TABLE IF NOT EXISTS tool_usage_hourly (
    tool text NOT NULL,
    hour bigint NOT NULL,
    uses bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (tool, hour)
);
CREATE INDEX IF NOT EXISTS tool_usage_hourly_hour ON tool_usage_hourly (hour);
