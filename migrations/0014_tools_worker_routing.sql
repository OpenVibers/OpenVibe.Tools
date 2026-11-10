-- phase: expand
ALTER TABLE tool_jobs ADD COLUMN IF NOT EXISTS execution_prefer TEXT NOT NULL DEFAULT 'auto';
CREATE TABLE IF NOT EXISTS tool_worker_attempts (
    job_id TEXT NOT NULL REFERENCES tool_jobs(id) ON DELETE CASCADE,
    job_attempt INTEGER NOT NULL,
    attempt INTEGER NOT NULL,
    worker_id TEXT NOT NULL,
    location TEXT NOT NULL,
    took_ms BIGINT NOT NULL,
    state TEXT NOT NULL,
    at BIGINT NOT NULL,
    PRIMARY KEY (job_id, job_attempt, attempt)
);
CREATE INDEX IF NOT EXISTS tool_worker_attempts_day ON tool_worker_attempts(at, worker_id);
