-- phase: expand
-- made_tools.code_text: a code tool's source as its maker wrote it (a run(input) function, at most 64 KiB), kept with
-- the tool (plan 2026-11-13 §AD.12 (c)). The entry a runner gets (tool.js: the source and the wrapper that reads the
-- input and writes the output) is built from it; code.sha256 is that entry's digest, served at
-- GET /api/v1/made-tools/:id/code. The owner's content: exported and erased with made_tools. Additive: one new column.
ALTER TABLE made_tools ADD COLUMN IF NOT EXISTS code_text text;
