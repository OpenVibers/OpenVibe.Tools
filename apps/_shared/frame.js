'use strict';

// ═══════════════════════════════════════════════════════════════
// The tool frame for the satellites (openvibe-shared ≥ 4.57.1, owner ask 11, part 2).
//
// The network and code tools on openvibe.tools got the shared frame in #155. The satellites that draw
// their own pages — img, text, audio, docs, maps, yt, food — get the same frame here: the head (crumb,
// name, one sentence, terms), the box, the answer, the family, the folds and "People also use".
//
// The markup is openvibe-shared/kit's; this module only chooses the copy and the links. It takes the
// kit and the server from the app that requires it (apps/_shared has no dependencies of its own).
//
// The terms come from the app's real configuration and from nowhere else:
//   • where the work happens, and how long the file is kept, from the app's own cleanup config;
//   • the file's size and count limits, from the app's upload limits;
//   • the anonymous rate, from the guard's quota table (apps/_shared/guard/limits.js) and the tool's
//     own cost in it.
// Nothing here promises a limit the configuration does not have.
// ═══════════════════════════════════════════════════════════════

const { quotas } = require('./guard/limits');

const SITE = 'https://openvibe.tools';

/**
 * The frame's builders, for one app.
 * @param {object} deps  { kit, serve } — openvibe-shared/kit and openvibe-shared/serve
 */
module.exports = function createFrame({ kit, serve }) {
    const esc = kit.esc;

    /** A file size in the words a person reads: "50 MB", "1.5 GB". */
    function size(bytes) {
        const b = Number(bytes) || 0;
        if (b >= 1024 * 1024 * 1024) return `${Math.round(b / (1024 * 1024 * 1024))} GB`;
        if (b >= 1024 * 1024) return `${Math.round(b / (1024 * 1024))} MB`;
        return `${Math.round(b / 1024)} KB`;
    }

    /**
     * The terms of a tool, from its real configuration.
     * @param {object} s
     *   work          'server' (the file goes to our server) or 'browser' (nothing leaves the page)
     *   ttlMs         how long the server keeps the file (the app's cleanup config)
     *   maxBytes      the largest file the app takes (the app's upload limits)
     *   maxFiles      how many files at once (the tool's own descriptor)
     *   quotaClass    the guard's quota class for the tool
     *   cost          what one run costs in quota units (the tool's own descriptor)
     *   unit          what one run is called: 'conversions', 'downloads', 'lookups'
     *   needsAccount  the tool refuses anonymous callers
     * @returns {Array<{text: string, icon: string}>} the head's terms
     */
    function terms(s) {
        const facts = [{ text: 'Free', icon: 'gift' }];
        if (s.work === 'server') {
            if (s.ttlMs) {
                const minutes = Math.max(1, Math.round((Number(s.ttlMs) || 0) / 60000));
                facts.push({ text: `Runs on our server; your file is deleted after ${minutes} minutes`, icon: 'server' });
            } else {
                // A tool that keeps no file: the app says where its work happens, in its own words.
                facts.push({ text: s.serverNote || 'Runs on our server', icon: 'server' });
            }
        } else {
            facts.push({ text: 'Runs in your browser: nothing is sent', icon: 'computer' });
        }
        if (s.maxBytes) {
            facts.push({
                text: s.maxFiles && s.maxFiles > 1
                    ? `Up to ${s.maxFiles} files, ${size(s.maxBytes)} each`
                    : `One file up to ${size(s.maxBytes)}`,
                icon: 'file',
            });
        }
        const q = quotas()[s.quotaClass];
        // One run is "1 download", two are "2 downloads": the unit follows the number.
        const unit = (n) => {
            const u = s.unit || 'runs';
            return n === 1 ? u.replace(/s$/, '') : u;
        };
        if (s.needsAccount) {
            // The tool refuses anonymous callers: the page still works, because the browser gets a
            // session, and that session's rate is the one the guard's table holds.
            const tier = q && q.session ? q.session : null;
            if (tier && tier.perMinute) {
                const n = Math.max(1, Math.floor(tier.perMinute / (s.cost || 1)));
                facts.push({ text: `${n} ${unit(n)} a minute in a browser session`, icon: 'clock' });
            }
            facts.push({ text: 'A browser session: no account needed', icon: 'user' });
        } else {
            if (q && q.anonymous && q.anonymous.perMinute) {
                const n = Math.max(1, Math.floor(q.anonymous.perMinute / (s.cost || 1)));
                facts.push({ text: `${n} ${unit(n)} a minute without an account`, icon: 'clock' });
            }
            facts.push({ text: 'No sign-up', icon: 'user' });
        }
        return facts;
    }

    /** A field's label, from its name: "sampleRate" is "Sample rate". */
    function labelOf(name, labels = {}) {
        if (labels[name]) return labels[name];
        const words = String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
        return words.charAt(0).toUpperCase() + words.slice(1);
    }

    /** An enum's value, in the words a person reads: "bass_boost" is "Bass boost". */
    function humanValue(value) {
        const s = String(value).replace(/[_-]+/g, ' ').trim();
        return s.charAt(0).toUpperCase() + s.slice(1);
    }

    /**
     * One field of a box, from a tool's own descriptor: its type, its range and its default. A field
     * the descriptor does not have is not on the page, and the field reads what the tool reads.
     * @param {string} name the field's name
     * @param {object} s the descriptor's field
     * @param {object} [labels] the field's name in the words a person reads
     * @param {object} [values] the field's values in the words a person reads
     * @returns {string} HTML
     */
    function field(name, s, labels = {}, values = {}) {
        const label = labelOf(name, labels);
        if (s.enum) {
            const value = s.default !== undefined ? s.default : s.enum[0];
            return kit.selectRow({ name, label, value: String(value), options: s.enum.map((v) => [String(v), values[String(v)] || humanValue(v)]) });
        }
        if (s.type === 'boolean') {
            return kit.selectRow({ name, label, value: String(s.default === true), options: [['true', 'Yes'], ['false', 'No']] });
        }
        const min = s.minimum != null ? ` min="${esc(s.minimum)}"` : '';
        const max = s.maximum != null ? ` max="${esc(s.maximum)}"` : '';
        const step = s.type === 'integer' ? ' step="1"' : '';
        if (s.type === 'integer' || s.type === 'number') {
            const value = s.default !== undefined ? ` value="${esc(s.default)}"` : ' value=""';
            return `<label class="ovk-set-row"><span class="ovk-set-text">${esc(label)}</span>`
                + `<input type="number" class="num-input num-input-sm" name="${esc(name)}"${value}${min}${max}${step}></label>`;
        }
        return `<label class="ovk-set-row"><span class="ovk-set-text">${esc(label)}</span>`
            + `<input type="text" class="num-input num-input-sm" name="${esc(name)}" value=""${s.maxLength ? ` maxlength="${esc(s.maxLength)}"` : ''}></label>`;
    }

    /**
     * The tool's head: the crumb, the name, the one sentence and the terms.
     * @param {object} rec { icon, hue, family, crumb: { href, label }, title, task, facts }
     */
    function head(rec) {
        return kit.toolHead({
            icon: rec.icon || 'grid', hue: rec.hue, family: rec.family || '',
            crumb: rec.crumb || null, title: rec.title || '', task: rec.task || '', facts: rec.facts || [],
        });
    }

    /** The one button of a tool page: it says the verb, never "Run". */
    function verbButton(label, { id = '', icon = null, disabled = false, extra = '' } = {}) {
        return `<button type="button"${id ? ` id="${esc(id)}"` : ''} class="ovk-btn ovk-btn--primary ovk-tool-go"${disabled ? ' disabled' : ''}${extra}>`
            + `${icon ? kit.icon(icon) : ''}<span>${esc(label)}</span></button>`;
    }

    /**
     * The folds: About the tool, Questions, and the real call from code.
     * @param {object} rec { name, about, bullets, faq: [[q, a]], api: { path, fields, needsAccount, capability, input } }
     */
    function folds(rec) {
        const out = [];
        const name = rec.name || rec.title || 'this tool';
        if (rec.about) {
            const bullets = (rec.bullets || []).length ? `<ul>${rec.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : '';
            out.push(kit.fold({ id: 'about-this-tool', title: `About ${name}`, body: `<p>${esc(rec.about)}</p>${bullets}` }));
        }
        if ((rec.faq || []).length) {
            const body = rec.faq.map(([q, a]) => `<p><strong>${esc(q)}</strong></p><p>${esc(a)}</p>`).join('');
            out.push(kit.fold({ title: 'Questions', meta: String(rec.faq.length), body }));
        }
        if (rec.api) {
            const a = rec.api;
            const lines = [`curl -X POST ${SITE}${a.path}`];
            if (a.needsAccount) lines.push(`-H 'Authorization: Bearer $OPENVIBE_TOKEN'`);
            lines.push(`-H 'Content-Type: application/json'`, `-d ${shq(JSON.stringify(a.payload || {}))}`);
            const who = a.needsAccount
                ? 'Needs a signed-in browser session or a token with <code>tools.tool.run</code>.'
                : 'No account needed within the free limit; a token with <code>tools.tool.run</code> raises it.';
            out.push(kit.fold({
                title: 'Use it from code', meta: 'API',
                body: `<p>Input: <code>${esc(a.fields || 'none')}</code>. ${who}</p>${kit.snippet({ code: lines.join(' \\\n  ') })}`
                    + `<p><a href="${SITE}/api/v1/tools/${esc(a.id)}/schema">JSON Schema</a> · <a href="${SITE}/api/v1/openapi.json">OpenAPI</a> · <a href="${SITE}/developers">API docs</a></p>`,
            }));
        }
        return out.filter(Boolean);
    }

    // curl quoting for a value with single quotes (the same helper the gateway's frame uses).
    const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

    /**
     * The whole frame for one tool page.
     * @param {object} rec {
     *   id, icon, hue, family, crumb, title, task, facts,   → the head
     *   box,                                                 → the card's markup
     *   familyItems, familyMore, familyTitle,                → the family row
     *   about, bullets, faq, api,                            → the folds
     *   related: [{ href, title, sub }]                      → "People also use"
     * }
     * @returns {string} HTML
     */
    function page(rec) {
        const related = (rec.related || []).filter(Boolean);
        return `<div class="ovk-page ovk-page--wide" data-ov-tool-page="${esc(rec.id || '')}">${kit.tool({
            head: head(rec),
            input: rec.box || '',
            answer: '',
            family: kit.family({
                title: rec.familyTitle || '', more: rec.familyMore || null,
                items: rec.familyItems || [], label: rec.familyLabel || 'More tools',
            }),
            folds: folds(rec),
            related: related.length ? kit.list(related, { title: 'People also use' }) : '',
        })}</div>`;
    }

    /** The browser files a framed page loads (the kit and its behaviour, from this app's own pin). */
    function assets() {
        return {
            css: [serve.url('kit.css'), serve.url('kit-data.css')],
            js: [serve.url('kit.js'), serve.url('kit-web.js'), serve.url('kit-data-web.js')],
        };
    }

    return { terms, field, labelOf, head, verbButton, folds, page, assets, size, SITE };
};
