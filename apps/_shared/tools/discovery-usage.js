'use strict';
// Each completed job counts in its completion transaction. Inline replays bypass this hook.
// Cache hits count as successful uses; failed/cancelled work and page opens do not.
async function recordUse(db, tool, at = Date.now()) {
    if (!db || !tool) return;
    await db.exec(`INSERT INTO tool_usage_hourly (tool, hour, uses) VALUES ($1, $2, 1)
        ON CONFLICT (tool, hour) DO UPDATE SET uses = tool_usage_hourly.uses + 1`,
    [tool, Math.floor(at / 3600000)]);
}
module.exports = { recordUse };
