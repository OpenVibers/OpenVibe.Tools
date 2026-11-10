-- phase: expand
CREATE TABLE IF NOT EXISTS tools_workers (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT 'home',
    token_hash TEXT NOT NULL,
    draining BOOLEAN NOT NULL DEFAULT FALSE,
    revoked BOOLEAN NOT NULL DEFAULT FALSE,
    created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS tools_worker_routing (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    worker_order TEXT NOT NULL DEFAULT '["home","host"]'
);
INSERT INTO tools_worker_routing (id) VALUES (1) ON CONFLICT DO NOTHING;
