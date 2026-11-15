-- phase: expand
-- made_tool_triggers.notify: a schedule tells its owner what it answered, one Network notification per run (plan
-- 2026-11-13 §AD.12 (g); made/notify.js; Network #1021 grants Tools network.notifications.push as service 'tools'). On
-- for a schedule unless its owner turns it off; a link answers its caller and tells nobody. Additive: one new column,
-- false for the triggers made before it (their owners were never asked).
ALTER TABLE made_tool_triggers ADD COLUMN IF NOT EXISTS notify boolean NOT NULL DEFAULT false;
