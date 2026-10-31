'use strict';

// ═══════════════════════════════════════════════════════════════
// The tool frame for the food finder (openvibe-shared ≥ 4.57.1, owner ask 11, part 2).
//
// The finder's page is one tool on one host: the head (the crumb, the name, one sentence, the terms),
// the box (the place search), the answer (the food banks, stores, meal plan, food list and map), the
// family, the folds and "People also use".
//
// The page's own parts are marked in public/index.html and moved into the frame's box and answer slot
// here, so the page keeps its own script, its own ids and its own behaviour.
//
// The terms come from the app's real configuration and from the guard's quota table: the lookups
// happen on our server (the food app proxies them to the maps satellite), and the rate is the one
// the guard holds for the tools-map class.
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const kit = require('openvibe-shared/kit');
const serve = require('openvibe-shared/serve');
const frame = require('../../_shared/frame')({ kit, serve });
const { canonicalHostFor, restampHead } = require('../../_shared/host-role');
const { SPECS } = require('../../maps/server/descriptors');

const esc = kit.esc;
const HOST = 'food.openvibe.tools';
const SITE = 'https://openvibe.tools';
const FILE = path.join(__dirname, '..', 'public', 'index.html');
const SPEC = SPECS.find((s) => s.id === 'food') || {};

// The hubs this tool sits next to.
const HUBS = [
    { href: `${SITE}/maps-and-food`, label: 'Maps & Food', short: 'Maps' },
    { href: 'https://maps.openvibe.tools', label: 'Survival map', short: 'Map' },
    { href: 'https://openvibe.food', label: 'OpenVibe.Food', short: 'Food' },
    { href: `${SITE}/`, label: 'All tools', short: 'All' },
];

/**
 * The terms of the food finder, from the app's real configuration and the guard's quota table.
 */
function termsOf() {
    return frame.terms({
        work: 'server',
        serverNote: 'Runs on our server: your search is looked up there',
        quotaClass: SPEC.quotaClass || 'tools-map',
        cost: SPEC.cost || 2,
        unit: 'lookups',
    });
}

/** The family: the hubs this tool sits next to. The page's own hub is the one marked. */
function familyItems() {
    return HUBS.map((h) => ({ ...h, current: h.href === 'https://openvibe.food' }));
}

/** "People also use": the other hubs, as rows. */
function relatedItems() {
    return HUBS.filter((h) => h.href !== 'https://openvibe.food')
        .map((h) => kit.row({ href: h.href, title: h.label, sub: '' }));
}

/**
 * The whole frame for the finder's page.
 * @param {string} box the page's own place search
 * @param {string} answer the page's own tabs and panels
 * @returns {string} HTML
 */
function frameFor(box, answer) {
    const title = 'Food finder';
    const task = 'Find free food near you: food banks, pantries, budget grocery stores and a meal plan.';
    const faq = [
        ['Is it free?', 'Yes. Thirty lookups a minute without an account.'],
        ['Where does the data come from?', 'Public sources: food banks, the national food bank directory, and grocery stores that accept food assistance.'],
        ['Is my search sent anywhere?', 'Only to our server, which does the lookups. Nothing is kept about you afterwards.'],
        ['Can I use it offline?', 'No. The finder needs a connection: it looks places up as you search.'],
    ];
    return `<div class="ovk-page ovk-page--wide" data-ov-tool-page="food">${kit.tool({
        head: frame.head({
            icon: 'cart', hue: 25, family: 'places',
            crumb: { href: SITE, label: 'Tools' },
            title, task, facts: termsOf(),
        }),
        input: `<div class="ovk-food-box">${box}</div>`,
        answer: `<div class="ovk-food-answer">${answer}</div>`,
        family: kit.family({
            title: 'More OpenVibe tools', more: { href: SITE, label: 'All tools' },
            items: familyItems(), label: 'More tools',
        }),
        folds: frame.folds({
            name: title,
            about: 'The food finder puts food banks, community pantries, budget grocery stores, a meal planner and the food list on one page, so you can find what is free near you and plan with what you have.',
            faq,
            api: null,
        }),
        related: kit.list(relatedItems(), { title: 'People also use' }),
    })}</div>`;
}

/** The page's own part between two markers. */
function pick(html, re) {
    const m = re.exec(html);
    return m ? m[1] : '';
}

let _parts = null;

/** The page's own parts, read once: the box and the answer. */
function parts() {
    if (_parts) return _parts;
    const html = fs.readFileSync(FILE, 'utf8');
    _parts = {
        box: pick(html, /<!--OVK:BOX-->([\s\S]*?)<!--\/OVK:BOX-->/),
        answer: pick(html, /<!--OVK:ANSWER-->([\s\S]*?)<!--\/OVK:ANSWER-->/),
        page: html
            .replace(/<!--OVK:BOX-->[\s\S]*?<!--\/OVK:BOX-->/, '')
            .replace(/<!--OVK:ANSWER-->[\s\S]*?<!--\/OVK:ANSWER-->/, ''),
    };
    return _parts;
}

let _cache = null;

/**
 * The finder's page with the frame around it, stamped for this request's canonical host.
 * @param {string} canonicalHost the host the page is about
 * @returns {string} HTML
 */
function renderIndex(canonicalHost) {
    if (_cache === null) {
        const { box, answer, page: stripped } = parts();
        _cache = stripped
            .replace('<!--OVK:FRAME-->', frameFor(box, answer))
            .replace(/<\/head>/i, `${[
                `<link rel="stylesheet" href="${serve.url('kit.css')}">`,
                `<link rel="stylesheet" href="${serve.url('kit-data.css')}">`,
            ].join('\n')}\n</head>`)
            .replace(/<\/body>/i, `${[
                '<script src="/shared/kit.js" defer></script>',
                '<script src="/shared/kit-web.js" defer></script>',
                '<script src="/shared/kit-data-web.js" defer></script>',
                '<script src="/js/tool-frame.js"></script>',
            ].join('\n')}\n</body>`);
    }
    return _cache;
}

/**
 * The page with the frame, built fresh (no cache): the tests change the configuration and read the
 * page again.
 * @param {string} canonicalHost the host the page is about
 * @returns {string} HTML
 */
function renderFrame(canonicalHost) {
    const { box, answer, page } = parts();
    const out = page
        .replace('<!--OVK:FRAME-->', frameFor(box, answer))
        .replace(/<\/head>/i, `${[
            `<link rel="stylesheet" href="${serve.url('kit.css')}">`,
            `<link rel="stylesheet" href="${serve.url('kit-data.css')}">`,
        ].join('\n')}\n</head>`)
        .replace(/<\/body>/i, `${[
            '<script src="/shared/kit.js" defer></script>',
            '<script src="/shared/kit-web.js" defer></script>',
            '<script src="/shared/kit-data-web.js" defer></script>',
            '<script src="/js/tool-frame.js"></script>',
        ].join('\n')}\n</body>`);
    return canonicalHost ? restampHead(out, HOST, canonicalHost) : out;
}

/** Express handler: the page with the frame, stamped for this request's host. */
function sendIndex(req, res) {
    const canonical = canonicalHostFor(req, HOST);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Vary', 'X-OV-Canonical-Host');
    return res.send(renderIndex(canonical));
}

module.exports = { frameFor, termsOf, familyItems, relatedItems, renderIndex, renderFrame, sendIndex, HUBS, HOST };
