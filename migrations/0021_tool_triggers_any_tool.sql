-- phase: expand
-- made_tool_triggers.tool_id names any tool (the owner, 11-15: "make sure all existing tools use the same universal shared
-- modular system that users can make tools with"): a tool people made (mtl_…) or a catalogue tool (dns, qr, …), so a
-- schedule or a private link runs a catalogue tool the way it runs a made one. The foreign key to made_tools goes: the
-- code deletes a made tool's triggers with it (made/store.js remove, made/triggers.js removeForTool), and a trigger whose
-- tool is gone answers "The tool is gone" and is paused. Additive for the release before it: it only wrote made tool
-- ids, which stay valid.
ALTER TABLE made_tool_triggers DROP CONSTRAINT IF EXISTS made_tool_triggers_tool_id_fkey;
