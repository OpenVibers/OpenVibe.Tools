-- phase: expand
-- made_tools.chain: a chain tool's steps (plan 2026-11-13 §AD.12 (e); tools.made-tool@1 1.1.0): 2 to 8 tools run in
-- order, each step's input from the chain's input or an earlier step ({{input.x}}, {{steps.n.path}}). kind 'chain'
-- joins the check. The owner's content, exported and erased with made_tools. Additive: one new column, a wider check.
ALTER TABLE made_tools ADD COLUMN IF NOT EXISTS chain jsonb;
ALTER TABLE made_tools DROP CONSTRAINT IF EXISTS made_tools_kind_check;
ALTER TABLE made_tools ADD CONSTRAINT made_tools_kind_check CHECK (kind IN ('prompt', 'code', 'chain'));
