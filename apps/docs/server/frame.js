'use strict';

// ═══════════════════════════════════════════════════════════════
// The tool frame for the PDF pages (openvibe-shared ≥ 4.57.1, owner ask 11, part 2).
//
// Every PDF host — merge, split, compress, rotate, protect and the rest — is a tool page in the shared
// frame: the head (the family crumb, the tool's name, one sentence, the terms), the box (a drop zone
// and the tool's own options), the answer (the file it made, its size before and after, and Download),
// the family, the folds and "People also use".
//
// The box's options are the tool's own descriptor (server/descriptors.js): a field the descriptor does
// not have is not on the page, and its range and its default are the ones the tool reads. The terms come
// from the app's real configuration: the file's lifetime from config.js's retention, its size from
// config.js's upload limits, and the rate from the guard's quota table.
// ═══════════════════════════════════════════════════════════════

const kit = require('openvibe-shared/kit');
const serve = require('openvibe-shared/serve');
const frame = require('../../_shared/frame')({ kit, serve });
const config = require('./config');
const { DOMAIN_MAP } = require('./domain-map');
const { SPECS } = require('./descriptors');

const HUB = 'https://docs.openvibe.tools/';
const esc = kit.esc;

// The tools, in the order the family row shows them.
const TOOL_LIST = [
    ['merge', 'mergepdf', 'Merge PDFs', 'Merge', 'Combine several PDF files into one.', 'Merge'],
    ['split', 'splitpdf', 'Split PDF', 'Split', 'Cut a PDF into its pages, or into the ranges you name.', 'Split'],
    ['compress', 'compresspdf', 'Compress PDF', 'Compress', 'Make a PDF smaller without losing what is in it.', 'Compress'],
    ['rotate', 'rotatepdf', 'Rotate PDF', 'Rotate', 'Turn the pages of a PDF around.', 'Rotate'],
    ['reorder', 'reorderpdf', 'Reorder Pages', 'Reorder', 'Put the pages of a PDF in the order you want.', 'Reorder'],
    ['watermark', 'watermarkpdf', 'Watermark PDF', 'Watermark', 'Write a word or a name over every page of a PDF.', 'Add watermark'],
    ['protect', 'protectpdf', 'Protect PDF', 'Protect', 'Put a password on a PDF.', 'Protect'],
    ['unlock', 'unlockpdf', 'Unlock PDF', 'Unlock', 'Take the password off a PDF you know.', 'Unlock'],
    ['img2pdf', 'image2pdf', 'Images to PDF', 'Images to PDF', 'Turn pictures into a PDF.', 'Make PDF'],
    ['pdf2img', 'pdf2jpg', 'PDF to Images', 'PDF to images', 'Turn the pages of a PDF into pictures.', 'Make pictures'],
];

const RECS = TOOL_LIST.map(([id, spec, name, short, task, verb]) => ({ id, spec, name, short, task, verb }));
const BY_ID = new Map(RECS.map((r) => [r.id, r]));
const SPEC = new Map(SPECS.map((s) => [s.id, s]));

const HUB_TOOL = {
    id: 'hub', name: 'Docs.OpenVibe', short: 'All tools', task: 'Every PDF tool in one place — the merge page is below, the rest are one click away.', verb: 'Merge',
    op: 'merge', spec: 'mergepdf',
    about: 'Every PDF tool in one place: combine files, cut one up, make it smaller, turn the pages, write on them, protect them and turn pictures into a PDF.',
};

/** The tool a host is for (the JPG and PNG hosts are the same tool as the images one). */
function toolFor(host) {
    const ctx = DOMAIN_MAP[host];
    if (!ctx) return null;
    if (ctx.toolId === 'hub') return HUB_TOOL;
    return BY_ID.get(ctx.toolId) || null;
}

/** The terms of a tool, from the app's real configuration and the tool's own descriptor. */
function termsOf(rec) {
    const spec = SPEC.get(rec.spec);
    return frame.terms({
        work: 'server',
        ttlMs: config.retention.anonTTL,
        maxBytes: config.upload.maxFileSize,
        maxFiles: (spec && spec.files && spec.files.max) || 1,
        quotaClass: (spec && spec.quotaClass) || 'tools-job',
        cost: (spec && spec.cost) || 1,
        unit: 'runs',
        needsAccount: !!(spec && spec.auth && spec.auth.anonymous === false),
    });
}

/** The labels of the descriptor's fields, in the words a person reads. */
const FIELD_LABEL = {
    ranges: 'Pages', angle: 'Turn by', pages: 'Pages', order: 'New order', text: 'Text', fontSize: 'Text size',
    opacity: 'Opacity', rotation: 'Tilt', color: 'Colour', pageSize: 'Page size', format: 'Picture format',
    dpi: 'Resolution (dpi)', password: 'Password', ownerPassword: 'Owner password', allowPrint: 'Allow printing',
    allowCopy: 'Allow copying', level: 'Level',
};

/** The values a person reads better than the code's. */
const VALUE_LABEL = {
    a4: 'A4', letter: 'Letter', legal: 'Legal', fit: 'Fit the picture',
    low: 'Light', medium: 'Medium', high: 'Heavy',
    '90': '90°', '180': '180°', '270': '270°',
    jpg: 'JPG', png: 'PNG',
};

/** The box's options: the tool's own descriptor fields, with their ranges and their defaults. */
function optionsFor(rec) {
    const spec = SPEC.get(rec.spec);
    const props = (spec && spec.input && spec.input.properties) || {};
    const preset = (DOMAIN_MAP[`${rec.id}.openvibe.tools`] || {}).defaultFormat;
    const out = [];
    for (const [name, s] of Object.entries(props)) {
        // A list of page numbers is not a field a person types; the tool reads it from the pages it has.
        if (s.type === 'array') continue;
        const field = { ...s };
        if (name === 'format' && preset) field.default = preset;
        out.push(frame.field(name, field, FIELD_LABEL, VALUE_LABEL));
    }
    return out.join('');
}

/**
 * The operation the box runs: the tool's own id (the registry's key: merge, compress, pdf2img…),
 * or the hub's own default.
 * @param {object} rec the tool record
 * @returns {string}
 */
function opOf(rec) {
    return rec.op || rec.id;
}

/**
 * The box: a drop zone for the document, the tool's options and the one button.
 * @param {object} rec the tool record
 */
function boxFor(rec) {
    const spec = SPEC.get(rec.spec);
    const many = (spec && spec.files && spec.files.max) > 1;
    const accept = (spec && spec.files && spec.files.accept) || ['application/pdf'];
    const drop = kit.drop({
        name: 'file', accept: accept.join(','), id: 'file-input', multiple: many,
        label: many ? 'Drop your documents here' : 'Drop a document here',
        hint: many ? 'Up to 50 files at once' : 'A PDF, a picture, or both',
    });
    return `<form class="ovk-tool-form" id="ovk-docs-form" enctype="multipart/form-data" data-ovk-tool-form>`
        + `<input type="hidden" name="tool" value="${esc(opOf(rec))}">`
        + drop
        + `<p class="ovk-try"><span>Try</span><a href="/sample.pdf" data-ovk-sample="/sample.pdf">A sample document</a></p>`
        + `<div id="options-panel" hidden>${optionsFor(rec)}</div>`
        + `<div class="ovk-tool-buttons">${frame.verbButton(rec.verb, { id: 'process-btn', icon: 'file' })}`
        + `<button type="button" class="ovk-btn ovk-btn--quiet ovk-btn--small" id="clear-btn">${kit.icon('close')}<span>Clear</span></button></div>`
        + `</form>`;
}

/** The family: every PDF tool, with the one on the page marked. */
function familyItems(rec) {
    const hub = { href: HUB, label: 'Docs.OpenVibe', short: 'All tools', current: rec.id === 'hub' };
    const current = rec.id === 'hub' ? 'merge' : rec.id;
    return [hub, ...RECS.map((t) => ({ href: `https://${t.spec}.openvibe.tools/`, label: t.name, short: t.short, current: t.id === current }))];
}

/** "People also use": the tools next to this one in the family. */
function relatedFor(rec) {
    const at = RECS.findIndex((t) => t.id === rec.id);
    const out = [];
    for (let i = 1; out.length < 3 && i < RECS.length + 1; i++) {
        const other = RECS[(at + i) % RECS.length];
        if (other.id !== rec.id) out.push(other);
    }
    return out.map((t) => kit.row({ href: `https://${t.spec}.openvibe.tools/`, title: t.name, sub: t.task }));
}

/**
 * The whole frame for one host.
 * @param {string} host the satellite's own hostname, e.g. 'mergepdf.openvibe.tools'
 * @returns {string} HTML
 */
function frameFor(host) {
    const rec = toolFor(host);
    if (!rec) return '';
    const spec = SPEC.get(rec.spec);
    const fields = spec && spec.input && spec.input.properties ? Object.keys(spec.input.properties).join(', ') : 'none';
    const input = spec && spec.input && spec.input.properties ? Object.fromEntries(
        Object.entries(spec.input.properties).map(([k, v]) => [k, v.default !== undefined ? v.default : '']),
    ) : {};
    const faq = [
        ['Is it free?', 'Yes. Every PDF tool here is free, with a fair-use limit per address so the shared servers stay fast for everyone.'],
        ['How long is my document kept?', 'An hour for a visitor, a day for a signed-in person. Then the file is gone.'],
        ['Are my files safe?', 'They are worked on by our own server and deleted afterwards. Nothing is kept and nothing is shared.'],
    ];
    return frame.page({
        id: rec.id,
        icon: 'file', hue: 25, family: 'pdf',
        crumb: { href: HUB, label: 'PDF tools' },
        title: rec.name, task: rec.task, facts: termsOf(rec),
        box: boxFor(rec),
        familyTitle: 'More PDF tools',
        familyMore: { href: HUB, label: `All ${RECS.length + 1}` },
        familyItems: familyItems(rec),
        about: rec.about || `The ${rec.name.toLowerCase()} tool works on our server: the document is sent to us, changed there and sent back as a file.`,
        faq,
        api: {
            id: rec.spec, path: `/api/v1/tools/${rec.spec}/run`, fields, payload: { input },
            needsAccount: !!(spec && spec.auth && spec.auth.anonymous === false),
        },
        related: relatedFor(rec),
    });
}

module.exports = { frameFor, toolFor, termsOf, boxFor, optionsFor, RECS, HUB_TOOL };
