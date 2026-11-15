'use strict';
// A scheduled made tool tells its owner what it answered (plan 2026-11-13 §AD.12 (g)): one OpenVibe.Network notification
// per run (POST /internal/notifications/push by subject; contracts network.notification-push-request@1; capability
// network.notifications.push as service 'tools', Network #1021). Best effort: off without Tools' client secret, never
// retried (a person told twice is worse than once), and a failure never stops a schedule. → { sent, reason? }

const SUBJECT = /^usr_[0-9A-HJKMNP-TV-Z]{26}$/;
const clip = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** What an answer says, in a line: the text, or each field "name: value". */
function answerLine(result) {
    if (!result) return '';
    if (result.text != null) return String(result.text);
    const d = result.data;
    if (d && typeof d === 'object' && !Array.isArray(d)) return Object.entries(d).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' · ');
    return d === undefined ? '' : JSON.stringify(d);
}

function createRunNotifier({ networkUrl, tokens = null, fetchImpl = globalThis.fetch, baseUrl = 'https://openvibe.tools', log = console } = {}) {
    const enabled = !!(networkUrl && tokens);
    /** A schedule ran: the tool's name, what it answered (or why it failed), and the way back to the tool. */
    async function scheduleRan({ subject, tool, says, out }) {
        if (!enabled) return { sent: false, reason: 'off' };
        if (!SUBJECT.test(String(subject || '')) || !tool) return { sent: false, reason: 'bad_input' };
        const ok = out && out.state === 'succeeded';
        const message = ok ? clip(answerLine(out.result) || 'It ran.', 300) : clip(`It did not run: ${(out && out.error && (out.error.detail || out.error.title)) || 'the run failed'}`, 300);
        try {
            const res = await fetchImpl(`${networkUrl}/internal/notifications/push`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(await tokens.authHeaders()) },
                body: JSON.stringify({
                    subject, type: ok ? 'TOOL_RAN' : 'TOOL_FAILED', category: 'service', service: 'tools', priority: ok ? 'normal' : 'high',
                    title: clip(tool.name, 80), message, url: `${baseUrl}/make#${tool.id}`,
                    rich_content: { tool: tool.id, schedule: clip(says, 80), state: ok ? 'succeeded' : 'failed' },
                }),
                signal: AbortSignal.timeout(10_000),
            });
            return res.ok ? { sent: true } : { sent: false, reason: `network_${res.status}` };
        } catch (err) {
            if (log && log.warn) log.warn(`[made-notify] ${(err && err.message) || err}`);
            return { sent: false, reason: 'error' };
        }
    }
    return { enabled, scheduleRan };
}

module.exports = { createRunNotifier, answerLine };
