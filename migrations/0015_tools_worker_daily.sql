-- phase: expand
-- Owner infrastructure counters survive expiry of the underlying job and its attempt rows.
CREATE TABLE IF NOT EXISTS tools_worker_daily (
    worker_id TEXT NOT NULL,
    day TEXT NOT NULL,
    jobs BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (worker_id, day)
);
LOCK TABLE tool_worker_attempts IN SHARE ROW EXCLUSIVE MODE;
INSERT INTO tools_worker_daily (worker_id, day, jobs)
SELECT worker_id, to_char(to_timestamp(at / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD'), COUNT(*)
FROM tool_worker_attempts GROUP BY 1, 2
ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION tools_count_worker_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO tools_worker_daily (worker_id, day, jobs)
    VALUES (NEW.worker_id, to_char(to_timestamp(NEW.at / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD'), 1)
    ON CONFLICT (worker_id, day) DO UPDATE SET jobs = tools_worker_daily.jobs + 1;
    RETURN NEW;
END;
$$;
CREATE TRIGGER tools_worker_attempt_count AFTER INSERT ON tool_worker_attempts
FOR EACH ROW EXECUTE FUNCTION tools_count_worker_attempt();
