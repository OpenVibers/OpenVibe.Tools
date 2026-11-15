'use strict';
// ═══════════════════════════════════════════════════════════════
// Chains: tools made of tools (plan 2026-11-13 §AD.12 (e); tools.made-tool@1 1.1.0). A chain runs 2 to 8 tools in
// order. A step's input values may be templates: {{input.<field>}} (the chain's own input) or {{steps.<n>.<path>}} (an
// earlier step's result: its data, or its text for a text result). A value that is only a template takes the value as it
// is; a template inside other words is written in as text. Every step is one run through the gateway's own run API
// over loopback, with the caller's own credentials and address: the person who runs the chain runs each step, and every
// rule of one run applies to it. The first failed step ends the chain and says which step.
// ═══════════════════════════════════════════════════════════════

const MADE_ID = /^mtl_[0-9A-HJKMNP-TV-Z]{26}$/;
const TOOL_ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const ONLY = /^\s*\{\{\s*((?:input|steps)(?:\.[A-Za-z0-9_-]+)*)\s*\}\}\s*$/;
const ANY = /\{\{\s*((?:input|steps)(?:\.[A-Za-z0-9_-]+)*)\s*\}\}/g;
const MAX_STEPS = 8;
const MAX_STEP_INPUT = 8 * 1024;

/** A path in the chain's context: input.a.b, steps.0.c. */
function lookup(ctx, path) {
    const parts = path.split('.');
    let v = parts[0] === 'input' ? ctx.input : ctx.steps;
    for (const p of parts.slice(1)) {
        if (v == null) return undefined;
        v = Array.isArray(v) && /^\d+$/.test(p) ? v[Number(p)] : v[p];
    }
    return v;
}

/** A step's input with its templates filled in. */
function fill(value, ctx) {
    if (typeof value === 'string') {
        const only = ONLY.exec(value);
        if (only) { const v = lookup(ctx, only[1]); return v === undefined ? null : v; }
        return value.replace(ANY, (_, path) => { const v = lookup(ctx, path); return v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v); });
    }
    if (Array.isArray(value)) return value.map((v) => fill(v, ctx));
    if (value && typeof value === 'object') { const out = {}; for (const [k, v] of Object.entries(value)) out[k] = fill(v, ctx); return out; }
    return value;
}

/** A chain from a make or change request, checked → { steps, output_from } or { error, pointer }. */
function checkChain(chain) {
    if (!chain || typeof chain !== 'object' || !Array.isArray(chain.steps)) return { error: 'A chain tool needs chain: { steps: [{ tool, input }, …] }', pointer: '/chain' };
    if (chain.steps.length < 2 || chain.steps.length > MAX_STEPS) return { error: `A chain has 2 to ${MAX_STEPS} steps`, pointer: '/chain/steps' };
    const steps = [];
    for (const [i, s] of chain.steps.entries()) {
        const tool = String((s && s.tool) || '');
        if (!MADE_ID.test(tool) && !TOOL_ID.test(tool)) return { error: `Step ${i + 1} names no tool`, pointer: `/chain/steps/${i}/tool` };
        const input = s.input && typeof s.input === 'object' && !Array.isArray(s.input) ? s.input : null;
        if (!input) return { error: `Step ${i + 1}'s input is an object`, pointer: `/chain/steps/${i}/input` };
        if (Buffer.byteLength(JSON.stringify(input)) > MAX_STEP_INPUT) return { error: `Step ${i + 1}'s input is at most 8 KB`, pointer: `/chain/steps/${i}/input` };
        // A step reads only steps before it.
        for (const m of JSON.stringify(input).matchAll(/\{\{\s*steps\.(\d+)/g)) {
            if (Number(m[1]) >= i) return { error: `Step ${i + 1} reads step ${Number(m[1]) + 1}, which has not run yet`, pointer: `/chain/steps/${i}/input` };
        }
        const name = s.name == null ? null : String(s.name).replace(/\s+/g, ' ').trim().slice(0, 80) || null;
        steps.push({ tool, ...(name ? { name } : {}), input });
    }
    const output = chain.output_from === 'all' ? 'all' : 'last';
    return { steps, output_from: output };
}

/**
 * Run a chain as the caller. base: the gateway's own loopback origin; headers: the caller's Authorization / Cookie /
 * Origin / X-Forwarded-For. → { ok: true, result: { data } | { text }, steps } | { ok: false, step, error }
 */
async function runChain(chain, input, { base, headers, fetchImpl = globalThis.fetch, signal } = {}) {
    const ctx = { input: input || {}, steps: [] };
    const report = [];
    for (const [i, step] of chain.steps.entries()) {
        const made = MADE_ID.test(step.tool);
        const path = made ? `/api/v1/made-tools/${step.tool}/run` : `/api/v1/tools/${encodeURIComponent(step.tool)}/run`;
        const stepInput = fill(step.input, ctx);
        const t0 = Date.now();
        let res, body;
        try {
            res = await fetchImpl(base + path, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
                body: JSON.stringify(made ? { input: stepInput } : { input: stepInput, wait_ms: 30000 }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000) });
            body = await res.json().catch(() => null);
        } catch { return { ok: false, step: i, error: `Step ${i + 1} (${step.tool}) did not answer in time`, steps: report }; }
        const failed = !res.ok || !body || body.state !== 'succeeded';
        if (failed) {
            const e = (body && (body.error || body)) || {};
            return { ok: false, step: i, error: `Step ${i + 1} (${step.name || step.tool}): ${String(e.detail || e.title || `answered ${res.status}`).slice(0, 300)}`, steps: report };
        }
        const r = body.result || {};
        const value = r.data !== undefined ? r.data : r.text !== undefined ? r.text : r;
        ctx.steps.push(value);
        report.push({ tool: step.tool, ...(step.name ? { name: step.name } : {}), took_ms: Date.now() - t0 });
    }
    const last = ctx.steps[ctx.steps.length - 1];
    if (chain.output_from === 'all') return { ok: true, result: { data: { steps: ctx.steps } }, steps: report };
    return { ok: true, result: typeof last === 'string' ? { text: last } : { data: last && typeof last === 'object' && !Array.isArray(last) ? last : { value: last } }, steps: report };
}

module.exports = { checkChain, runChain, fill, lookup };
