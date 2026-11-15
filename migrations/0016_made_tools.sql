-- phase: expand
-- made_tools: tools people make (plan 2026-11-13 §AD.7 step 2; contract tools.made-tool@1; apps/gateway/server/made).
-- A prompt tool is instructions and a model, run through OpenVibe.AI as the person who runs it; a code tool is one
-- JavaScript entry pinned by its sha256, run as a skill-runner function job (placed by OpenVibe.Run). The owner's
-- content: exported with their account and erased with it (account-data.js). `runs` counts runs by anyone, never who.
-- Additive: one new empty table.
CREATE TABLE IF NOT EXISTS made_tools (
    id            text PRIMARY KEY,
    owner_subject text NOT NULL,
    slug          text NOT NULL,
    name          text NOT NULL,
    summary       text NOT NULL,
    kind          text NOT NULL CHECK (kind IN ('prompt', 'code')),
    input_schema  jsonb NOT NULL,
    output        jsonb NOT NULL,
    prompt        jsonb,
    code          jsonb,
    net           text NOT NULL DEFAULT 'deny' CHECK (net IN ('deny', 'public', 'openvibe-only')),
    hosting       text NOT NULL DEFAULT 'openvibe' CHECK (hosting IN ('openvibe', 'mine', 'shared')),
    visibility    text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'unlisted', 'public')),
    version       integer NOT NULL DEFAULT 1,
    runs          bigint NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS made_tools_owner_slug ON made_tools (owner_subject, slug);
CREATE INDEX IF NOT EXISTS made_tools_public ON made_tools (runs DESC, updated_at DESC) WHERE visibility = 'public';
