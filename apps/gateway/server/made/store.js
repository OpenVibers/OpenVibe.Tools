'use strict';
// ═══════════════════════════════════════════════════════════════
// Tools people make (plan 2026-11-13 §AD.7 step 2; contract tools.made-tool@1; migration 0016): the rows, and what
// a person may send to make or change one. The routes (./routes.js) decide who may do what; this file checks the
// shape and keeps the rows.
//
//   create(owner, body, { compileSchema })       a new tool, version 1 (409 tools.made.slug_taken: the owner has that slug)
//   update(id, owner, patch, { compileSchema })  the owner's change: the next version
//   remove(id, owner)           the owner deletes it
//   get(id)                     one tool, or null
//   listMine(owner)             the owner's tools, newest change first
//   listPublic({ q, limit })    public tools, the most run first
//   counted(id)                 one more run
//   present(row, ownerName?)    the row as tools.made-tool@1
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');

const SLUG = /^[a-z][a-z0-9-]{1,39}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ENTRY = /^[A-Za-z0-9._/-]+\.m?js$/;
const KINDS = ['prompt', 'code', 'chain'];
const NETS = ['deny', 'public', 'openvibe-only'];
const HOSTINGS = ['openvibe', 'mine', 'shared'];
const VISIBILITIES = ['private', 'unlisted', 'public'];
const MAX_SCHEMA_BYTES = 16 * 1024;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** mtl_ + a ULID (time first, then 80 random bits). */
function newId(now = Date.now()) {
    let t = now;
    let time = '';
    for (let i = 0; i < 10; i++) { time = CROCKFORD[t % 32] + time; t = Math.floor(t / 32); }
    const bytes = crypto.randomBytes(16);
    let rand = '';
    for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i] % 32];
    return `mtl_${time}${rand}`;
}

class Invalid extends Error {
    constructor(detail, errors = []) { super(detail); this.status = 422; this.code = 'tools.made.invalid'; this.errors = errors; }
}

const oneLine = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

/** A JSON Schema of an object, small enough to keep. */
function objectSchema(v, field) {
    if (!v || typeof v !== 'object' || Array.isArray(v) || v.type !== 'object') throw new Invalid(`${field} is a JSON Schema of an object ({ "type": "object", … })`, [{ pointer: `/${field}` }]);
    if (Buffer.byteLength(JSON.stringify(v)) > MAX_SCHEMA_BYTES) throw new Invalid(`${field} is at most 16 KB`, [{ pointer: `/${field}` }]);
    return v;
}

/**
 * The fields of a make (all required but the defaults) or of a change (only what is sent), checked → column values.
 * `current` is the row being changed (its kind decides what a change may carry).
 */
function fieldsFrom(body, current = null, { compileSchema } = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Invalid('Send the tool as a JSON object');
    const make = !current;
    const out = {};
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
    if (make || has('slug')) {
        const slug = String(body.slug || '').trim().toLowerCase();
        if (!SLUG.test(slug)) throw new Invalid('slug is 2 to 40 lower-case letters, digits and hyphens, starting with a letter', [{ pointer: '/slug' }]);
        out.slug = slug;
    }
    if (make || has('name')) {
        out.name = oneLine(body.name, 80);
        if (!out.name) throw new Invalid('name is a few words (at most 80 characters)', [{ pointer: '/name' }]);
    }
    if (make || has('summary')) {
        out.summary = oneLine(body.summary, 200);
        if (!out.summary) throw new Invalid('summary is one sentence: what the tool does (at most 200 characters)', [{ pointer: '/summary' }]);
    }
    const kind = make ? body.kind : current.kind;
    if (make && !KINDS.includes(kind)) throw new Invalid('kind is prompt, code or chain', [{ pointer: '/kind' }]);
    if (!make && has('kind') && body.kind !== current.kind) throw new Invalid('A tool keeps its kind: make a new tool for the other kind', [{ pointer: '/kind' }]);
    if (make) out.kind = kind;
    if (make || has('input')) {
        out.input_schema = objectSchema(body.input, 'input');
        if (compileSchema) compileSchema(out.input_schema, 'input');
    }
    if (make || has('output')) {
        const o = body.output;
        if (!o || typeof o !== 'object' || !['json', 'text'].includes(o.kind)) throw new Invalid('output is { kind: json, schema } or { kind: text }', [{ pointer: '/output' }]);
        out.output = o.kind === 'json' ? { kind: 'json', schema: objectSchema(o.schema, 'output.schema') } : { kind: 'text' };
        if (out.output.schema && compileSchema) compileSchema(out.output.schema, 'output.schema');
    }
    if (kind === 'chain') {
        if (make || has('chain')) {
            const checked = require('./chain').checkChain(body.chain);
            if (checked.error) throw new Invalid(checked.error, [{ pointer: checked.pointer }]);
            out.chain = checked;
        }
        if ((has('prompt') && body.prompt != null) || (has('code') && body.code != null) || (has('source_code') && body.source_code != null)) throw new Invalid('A chain tool runs other tools: no prompt and no code of its own', [{ pointer: '/kind' }]);
        if ((has('net') && body.net !== 'deny') || (has('hosting') && body.hosting !== 'openvibe')) throw new Invalid('A chain runs on OpenVibe; its steps reach what they reach', [{ pointer: '/net' }]);
        if (make) { out.prompt = null; out.code = null; out.net = 'deny'; out.hosting = 'openvibe'; }
    } else if (kind === 'prompt') {
        if (make || has('prompt')) {
            const p = body.prompt;
            if (!p || typeof p !== 'object') throw new Invalid('A prompt tool needs prompt: { instructions, model }', [{ pointer: '/prompt' }]);
            const instructions = String(p.instructions || '').trim().slice(0, 8000);
            if (!instructions) throw new Invalid('prompt.instructions says what the model does with the input', [{ pointer: '/prompt/instructions' }]);
            const model = String(p.model || 'auto').trim();
            if (!MODEL.test(model)) throw new Invalid('prompt.model is a model id from openvibe.exchange, or auto', [{ pointer: '/prompt/model' }]);
            const prompt = { instructions, model };
            if (p.temperature != null) {
                const t = Number(p.temperature);
                if (!(t >= 0 && t <= 2)) throw new Invalid('prompt.temperature is 0 to 2', [{ pointer: '/prompt/temperature' }]);
                prompt.temperature = t;
            }
            if (p.max_tokens != null) {
                const m = Number(p.max_tokens);
                if (!(Number.isInteger(m) && m >= 1 && m <= 16000)) throw new Invalid('prompt.max_tokens is 1 to 16000', [{ pointer: '/prompt/max_tokens' }]);
                prompt.max_tokens = m;
            }
            out.prompt = prompt;
        }
        if ((has('code') && body.code != null) || (has('source_code') && body.source_code != null)) throw new Invalid('A prompt tool has no code', [{ pointer: '/code' }]);
        if ((has('net') && body.net !== 'deny') || (has('hosting') && body.hosting !== 'openvibe')) throw new Invalid('A prompt tool runs on OpenVibe and reaches no network', [{ pointer: '/net' }]);
        if (make) { out.code = null; out.net = 'deny'; out.hosting = 'openvibe'; }
    } else {
        if (has('source_code') && body.source_code != null) {
            // The maker's own run(input) function (made/code.js): its entry and digest are built from it here.
            const checked = require('./code').checkSource(body.source_code);
            if (checked.error) throw new Invalid(checked.error, [{ pointer: '/source_code' }]);
            out.code_text = checked.source;
            out.code = { sha256: checked.sha256, entry: require('./code').ENTRY, bytes: checked.bytes };
        } else if (make || has('code')) {
            const c = body.code;
            if (!c || typeof c !== 'object') throw new Invalid('A code tool needs its code: source_code (a run(input) function), or code: { sha256, entry }', [{ pointer: '/code' }]);
            if (!SHA256.test(String(c.sha256 || ''))) throw new Invalid('code.sha256 is the entry file\'s SHA-256 (64 hex)', [{ pointer: '/code/sha256' }]);
            if (!ENTRY.test(String(c.entry || '')) || String(c.entry).length > 200) throw new Invalid('code.entry is the entry file\'s path (tool.js)', [{ pointer: '/code/entry' }]);
            const code = { sha256: c.sha256, entry: c.entry };
            if (c.source != null) {
                let u = null;
                try { u = new URL(String(c.source)); } catch { /* checked below */ }
                if (!u || u.protocol !== 'https:') throw new Invalid('code.source is an https address', [{ pointer: '/code/source' }]);
                code.source = u.href;
            }
            if (c.bytes != null) {
                const b = Number(c.bytes);
                if (!(Number.isInteger(b) && b >= 1 && b <= 1048576)) throw new Invalid('code.bytes is 1 to 1048576', [{ pointer: '/code/bytes' }]);
                code.bytes = b;
            }
            out.code = code;
        }
        if (has('prompt') && body.prompt != null) throw new Invalid('A code tool has no prompt', [{ pointer: '/prompt' }]);
        if (make || has('net')) {
            const net = make && !has('net') ? 'deny' : body.net;
            if (!NETS.includes(net)) throw new Invalid('net is deny, public or openvibe-only', [{ pointer: '/net' }]);
            out.net = net;
        }
        if (make || has('hosting')) {
            const hosting = make && !has('hosting') ? 'openvibe' : body.hosting;
            if (!HOSTINGS.includes(hosting)) throw new Invalid('hosting is openvibe, mine or shared', [{ pointer: '/hosting' }]);
            out.hosting = hosting;
        }
        if (make) out.prompt = null;
    }
    if (make || has('visibility')) {
        const v = make && !has('visibility') ? 'private' : body.visibility;
        if (!VISIBILITIES.includes(v)) throw new Invalid('visibility is private, unlisted or public', [{ pointer: '/visibility' }]);
        out.visibility = v;
    }
    return out;
}

const iso = (v) => (v instanceof Date ? v : new Date(v)).toISOString();
const json = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

/** A row as tools.made-tool@1. */
function present(row, ownerName = null) {
    return {
        id: row.id,
        owner: { subject: row.owner_subject, ...(ownerName ? { name: String(ownerName).slice(0, 80) } : {}) },
        slug: row.slug,
        name: row.name,
        summary: row.summary,
        kind: row.kind,
        input: json(row.input_schema),
        output: json(row.output),
        prompt: row.prompt == null ? null : json(row.prompt),
        code: row.code == null ? null : json(row.code),
        ...(row.kind === 'chain' ? { chain: row.chain == null ? null : json(row.chain) } : {}),
        net: row.net,
        hosting: row.hosting,
        visibility: row.visibility,
        version: Number(row.version),
        run: { method: 'POST', path: `/api/v1/made-tools/${row.id}/run` },
        runs: Number(row.runs) || 0,
        created_at: iso(row.created_at),
        updated_at: iso(row.updated_at),
    };
}

const COLUMNS = ['slug', 'name', 'summary', 'kind', 'input_schema', 'output', 'prompt', 'code', 'net', 'hosting', 'visibility', 'code_text', 'chain'];
const JSONB = new Set(['input_schema', 'output', 'prompt', 'code', 'chain']);
const MAX_PER_OWNER = 200;

function createMadeTools({ db, now = () => new Date(), baseUrl = 'https://openvibe.tools' } = {}) {
    const codeUrl = (id) => `${String(baseUrl).replace(/\/+$/, '')}/api/v1/made-tools/${id}/code`;
    const taken = (err) => err && (err.code === '23505' || /made_tools_owner_slug/.test(String(err.message || '')));
    const slugTaken = (slug) => Object.assign(new Error(`You already have a tool called ${slug}: pick another short name`), { status: 409, code: 'tools.made.slug_taken' });

    async function create(owner, body, { compileSchema = null } = {}) {
        const f = fieldsFrom(body, null, { compileSchema });
        const count = await db.one('SELECT count(*)::int AS n FROM made_tools WHERE owner_subject = $1', [owner]);
        if (count.n >= MAX_PER_OWNER) throw Object.assign(new Error(`A person keeps at most ${MAX_PER_OWNER} tools: delete one first`), { status: 409, code: 'tools.made.too_many' });
        const at = now();
        const id = newId(at.getTime());
        if (f.code_text != null && f.code) f.code = { ...f.code, source: codeUrl(id) };
        const vals = COLUMNS.map((c) => (JSONB.has(c) ? (f[c] == null ? null : JSON.stringify(f[c])) : (f[c] === undefined ? null : f[c])));
        try {
            const row = await db.one(`INSERT INTO made_tools (id, owner_subject, ${COLUMNS.join(', ')}, version, runs, created_at, updated_at)
                VALUES ($1, $2, ${COLUMNS.map((c, i) => `$${i + 3}${JSONB.has(c) ? '::jsonb' : ''}`).join(', ')}, 1, 0, $${COLUMNS.length + 3}, $${COLUMNS.length + 3}) RETURNING *`,
            [id, owner, ...vals, at]);
            return row;
        } catch (err) {
            if (taken(err)) throw slugTaken(f.slug);
            throw err;
        }
    }

    async function get(id) {
        if (!/^mtl_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(id || ''))) return null;
        return db.maybe('SELECT * FROM made_tools WHERE id = $1', [id]);
    }

    async function update(id, owner, patch, { compileSchema = null } = {}) {
        const row = await get(id);
        if (!row || row.owner_subject !== owner) return null;
        const f = fieldsFrom(patch, row, { compileSchema });
        if (f.code_text != null && f.code) f.code = { ...f.code, source: codeUrl(id) };
        const keys = Object.keys(f);
        if (!keys.length) return row;
        const sets = keys.map((k, i) => `${k} = $${i + 3}${JSONB.has(k) ? '::jsonb' : ''}`);
        try {
            return await db.one(`UPDATE made_tools SET ${sets.join(', ')}, version = version + 1, updated_at = $${keys.length + 3} WHERE id = $1 AND owner_subject = $2 RETURNING *`,
                [id, owner, ...keys.map((k) => (JSONB.has(k) ? (f[k] == null ? null : JSON.stringify(f[k])) : f[k])), now()]);
        } catch (err) {
            if (taken(err)) throw slugTaken(f.slug);
            throw err;
        }
    }

    async function remove(id, owner) {
        const gone = (await db.exec('DELETE FROM made_tools WHERE id = $1 AND owner_subject = $2', [id, owner])) > 0;
        // Its triggers go with it (no cascade since a trigger may name a catalogue tool; migration 0021).
        if (gone) await db.exec('DELETE FROM made_tool_triggers WHERE tool_id = $1 AND owner_subject = $2', [id, owner]);
        return gone;
    }

    async function listMine(owner) {
        return db.many('SELECT * FROM made_tools WHERE owner_subject = $1 ORDER BY updated_at DESC LIMIT $2', [owner, MAX_PER_OWNER]);
    }

    async function listPublic({ q = '', limit = 50 } = {}) {
        const n = Math.max(1, Math.min(100, Number(limit) || 50));
        const words = oneLine(q, 100).toLowerCase().split(' ').filter(Boolean).slice(0, 6);
        const where = words.map((_, i) => `lower(name || ' ' || summary || ' ' || slug) LIKE $${i + 2}`);
        return db.many(`SELECT * FROM made_tools WHERE visibility = 'public'${where.length ? ` AND ${where.join(' AND ')}` : ''} ORDER BY runs DESC, updated_at DESC LIMIT $1`,
            [n, ...words.map((w) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)]);
    }

    /** Every public tool, for OpenVibe Search (search-index.js): the newest first, only what a document needs. */
    async function listForSearch({ limit = 5000 } = {}) {
        return db.many(`SELECT id, slug, name, summary, kind, updated_at FROM made_tools WHERE visibility = 'public' ORDER BY updated_at DESC LIMIT $1`, [Math.max(1, Math.min(20000, Number(limit) || 5000))]);
    }

    async function counted(id) {
        await db.exec('UPDATE made_tools SET runs = runs + 1 WHERE id = $1', [id]);
    }

    return { create, get, update, remove, listMine, listPublic, listForSearch, counted, present, codeUrl };
}

module.exports = { createMadeTools, fieldsFrom, present, newId, Invalid, SLUG };
