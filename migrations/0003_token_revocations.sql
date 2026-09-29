-- phase: expand
-- token_revocations (plan T8, decision 4): the sign-out-everywhere cutoffs. The gateway writes them
-- through openvibe-sdk/auth createPgRevocationStore and every app's guard reads them; the PostgreSQL
-- store needs the table to exist (revocationSchema() in the SDK is the same DDL), so it lives here.
-- 0001's note that the SDK creates it at boot is corrected by this file.
CREATE TABLE IF NOT EXISTS token_revocations (
    subject_id     text COLLATE "C" PRIMARY KEY,
    valid_after_ms bigint NOT NULL,
    reason         text,
    updated_at     bigint NOT NULL
);
