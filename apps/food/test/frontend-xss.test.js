'use strict';
// Food's page renders OpenStreetMap names, addresses and websites. They must become text, never markup
// (the finding: an OSM name with an onerror handler, or website=javascript:, ran on the page). Loads
// public/js/app.js in a vm with a small DOM stub and drives a location search whose upstream answers
// carry HTML, a quote-breaking attribute value and a javascript: website.
//   node apps/food/test/frontend-xss.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeEl() {
    const listeners = {};
    const el = {
        innerHTML: '', textContent: '', value: '', checked: false,
        dataset: {}, style: {},
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
        querySelector: () => makeEl(), querySelectorAll: () => [],
        fire(type, e) { for (const fn of (listeners[type] || [])) fn(e || {}); },
    };
    return el;
}
const els = new Map();
const el = (sel) => { if (!els.has(sel)) els.set(sel, makeEl()); return els.get(sel); };

const ctx = {
    console, JSON, Promise, Date, Math, Object, Array, Error, Number, String, Boolean, URL, URLSearchParams,
    parseFloat, parseInt, isNaN,
    setTimeout: (f) => { if (typeof f === 'function') f(); return 0; }, clearTimeout() {},
    setInterval: () => 0, clearInterval() {},
    location: { hostname: 'food.openvibe.tools', origin: 'https://food.openvibe.tools', href: 'https://food.openvibe.tools/' },
    localStorage: { getItem: () => null, setItem() {} },
    navigator: {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    Toastify: () => ({ showToast() {} }),
    document: {
        readyState: 'complete',
        querySelector: el,
        querySelectorAll: () => [],
        getElementById: () => null,
        addEventListener() {},
        createElement: () => makeEl(),
    },
    fetch: (u) => {
        const url = String(u);
        if (url.includes('/api/geocode')) return Promise.resolve({ ok: true, json: async () => [{ lat: 44, lon: -103, name: '<b>Place</b>' }] });
        if (url.includes('/api/food-banks')) return Promise.resolve({
            ok: true,
            json: async () => ({ locations: [
                { name: '<img src=x onerror=alert(1)>', address: '" onmouseover="alert(2)', phone: '<b>555</b>', hours: '<u>9-5</u>', description: '<script>alert(3)</script>', website: 'javascript:alert(4)', lat: 44, lon: -103, distanceMiles: 1.5 },
                { name: 'Plain Bank', website: 'https://example.org/page', lat: 44.1, lon: -103.1, distanceMiles: 2 },
            ] }),
        });
        return Promise.resolve({ ok: true, json: async () => ({}) });
    },
};
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8'), ctx, { filename: 'app.js' });

(async () => {
    el('#loc-input').value = 'Nowhere';
    el('#btn-loc-search').fire('click');
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    const html = el('#food-banks-list').innerHTML;
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'an OSM name is rendered as text');
    assert.ok(!/<img\b|<script\b|<b>|<u>/i.test(html), 'no markup from OSM fields reaches the page');
    assert.ok(html.includes('&lt;script&gt;alert(3)&lt;/script&gt;'), 'the description is escaped');
    assert.ok(!html.includes('onmouseover="alert') && !html.includes('" onmouseover='), 'a trailing quote cannot break out of an attribute');
    assert.ok(!html.includes('javascript:'), 'a javascript: website is not turned into a link');
    assert.ok(!/>Website</.test(html) || html.includes('href="https://example.org/page"'), 'the rejected site is dropped, the http(s) one kept');
    assert.ok(html.includes('href="https://example.org/page"'), 'an https website is still linked');

    console.log('food front end escapes OSM data (XSS): all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
