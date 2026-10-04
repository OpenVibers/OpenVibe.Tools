'use strict';
// ═══════════════════════════════════════════════════════════════
// Usage readings → OpenVibe.Billing (plan T5 step 7): post(reading) sends one platform.usage-sample@1
// to POST /api/v1/usage with Tools' service token (Network client_credentials, OV_OAUTH_CLIENT_ID/SECRET,
// audience OV_BILLING_AUDIENCE, default openvibe.billing; the Tools client needs the grant
// billing.usage.record). Billing dedupes on the reading's idempotency_key (a replay answers 200), so a
// retry is safe.
//
// Inert unless OV_BILLING_URL is set. post() never throws: a refused post (or no token) is logged and
// answered { ok: false, status, error }, so the caller keeps the reading for its next flush. Never called
// inside a job's transaction (./jobs/usage.js stores the reading there and posts it from the flush).
// No dependencies: required by relative path.
// ═══════════════════════════════════════════════════════════════

const PATH = '/api/v1/usage';
const TIMEOUT_MS = 10000;

function createBillingClient({ env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console } = {}) {
    const base = String(env.OV_BILLING_URL || '').trim().replace(/\/+$/, '');
    if (!base) return { enabled: false, post: async () => ({ ok: false, skipped: true }) };
    const network = String(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000').replace(/\/+$/, '');
    const audience = env.OV_BILLING_AUDIENCE || 'openvibe.billing';
    let token = null, tokenExp = 0;

    async function bearer() {
        if (token && now() < tokenExp) return token;
        const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: env.OV_OAUTH_CLIENT_ID || 'tools', client_secret: env.OV_OAUTH_CLIENT_SECRET || '', audience });
        const r = await fetchImpl(`${network}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.access_token) throw Object.assign(new Error(`token: ${r.status} ${j.error || ''}`.trim()), { status: r.status });
        token = j.access_token; tokenExp = now() + Math.max(30, (Number(j.expires_in) || 300) - 60) * 1000;
        return token;
    }

    /** One reading → Billing. { ok: true, status } when stored (201) or replayed (200); else logged, { ok: false, status, error }. */
    async function post(reading) {
        try {
            const r = await fetchImpl(`${base}${PATH}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${await bearer()}` },
                body: JSON.stringify(reading), signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            if (r.ok) return { ok: true, status: r.status };
            if (r.status === 401) token = null;
            const text = (await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
            const error = `${r.status} ${text}`.trim();
            log.error(`[Billing] reading ${reading && reading.idempotency_key} refused: ${error}`);
            return { ok: false, status: r.status, error };
        } catch (err) {
            const error = String(err && err.message || err).slice(0, 300);
            log.error(`[Billing] reading ${reading && reading.idempotency_key} not sent: ${error}`);
            return { ok: false, status: err && err.status || 0, error };
        }
    }

    return { enabled: true, post };
}

module.exports = { createBillingClient };
