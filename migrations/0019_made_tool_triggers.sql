-- phase: expand
-- made_tool_triggers: a made tool runs without anyone pressing Run (plan 2026-11-13 §AD.12 (g); the owner, 11-15: tools
-- "from gui to cmd or whatever and beyond"; Val Town and Pipedream close in 2027). A link trigger is a secret URL (only
-- its SHA-256 and its last four characters are kept) that runs the tool as its owner with the request's input; a
-- schedule runs it every hour or every day with a fixed input. Every run is the owner's: their allowance pays. The last
-- answer is kept to show on /make. The owner's content, exported (without the hash) and erased with the account
-- (account-data.js); deleting the tool deletes its triggers. Additive: one new empty table.
CREATE TABLE IF NOT EXISTS made_tool_triggers (
    id            text PRIMARY KEY,
    tool_id       text NOT NULL REFERENCES made_tools (id) ON DELETE CASCADE,
    owner_subject text NOT NULL,
    kind          text NOT NULL CHECK (kind IN ('link', 'schedule')),
    token_hash    text UNIQUE,
    token_hint    text,
    every_minutes integer CHECK (every_minutes IN (60, 1440)),
    at_minute     integer CHECK (at_minute >= 0 AND at_minute < 1440),
    input         jsonb NOT NULL DEFAULT '{}'::jsonb,
    enabled       boolean NOT NULL DEFAULT true,
    next_run_at   timestamptz,
    last_run_at   timestamptz,
    last_state    text,
    last_result   jsonb,
    runs          bigint NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CHECK ((kind = 'link' AND token_hash IS NOT NULL) OR (kind = 'schedule' AND every_minutes IS NOT NULL AND at_minute IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS made_tool_triggers_tool ON made_tool_triggers (tool_id);
CREATE INDEX IF NOT EXISTS made_tool_triggers_owner ON made_tool_triggers (owner_subject);
CREATE INDEX IF NOT EXISTS made_tool_triggers_due ON made_tool_triggers (next_run_at) WHERE kind = 'schedule' AND enabled;
