-- phase: expand
-- tool_job_billing_readings (plan T5 step 7): one platform.usage-sample@1 reading per ended job
-- (succeeded or failed), written in the transaction that records the job's end and posted to
-- OpenVibe.Billing from the jobs tick (apps/_shared/jobs/usage.js). Additive: a new empty table.
CREATE TABLE IF NOT EXISTS tool_job_billing_readings (
    job_id     text PRIMARY KEY,
    app        text NOT NULL DEFAULT '',
    reading    jsonb NOT NULL,
    created_at bigint NOT NULL,
    sent_at    bigint,
    attempts   integer NOT NULL DEFAULT 0,
    last_error text
);
CREATE INDEX IF NOT EXISTS tool_job_billing_readings_unsent ON tool_job_billing_readings (app, attempts, created_at) WHERE sent_at IS NULL;
CREATE INDEX IF NOT EXISTS tool_job_billing_readings_sent ON tool_job_billing_readings (sent_at) WHERE sent_at IS NOT NULL;
