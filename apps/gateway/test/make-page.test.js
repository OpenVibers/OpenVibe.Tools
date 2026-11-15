'use strict';
// /make (plan 2026-11-13 §AD.7 step 3, Make a tool): one h1, the words before the script, the page's own script, a
// breadcrumb, and its model list cut from Exchange's directory (chat models that are available, the ones OpenVibe runs
// first, cheapest first; a directory that does not answer leaves the last list).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pageMake } = require('../server/pages/site');
const { createModelList } = require('../server/made/models');

(async () => {
    const html = pageMake();
    assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, 'one h1');
    assert.match(html, /<h1>Make a tool<\/h1>/);
    assert.match(html, /<div id="mk-app">/);
    assert.match(html, /<script src="\/js\/make\.js" defer><\/script>/);
    assert.match(html, /<link rel="canonical" href="https:\/\/openvibe\.tools\/make"/);
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'make.js'), 'utf8');
    assert.ok(!/\.innerHTML\s*=/.test(js), 'the page sets people\'s words as text, never as markup');

    let calls = 0;
    let up = true;
    let clock = 0;
    const list = createModelList({ exchangeUrl: 'https://ex.example', now: () => clock, fetchImpl: async (url) => {
        calls++;
        assert.strictEqual(url, 'https://ex.example/api/v1/models');
        if (!up) throw new Error('down');
        return new Response(JSON.stringify({ models: [
            { id: 'openai/gpt-5.2', name: 'GPT-5.2', provider_name: 'OpenAI', type: 'chat', status: 'available', routing_enabled: false, price: { input_per_million: 1.75, output_per_million: 14 }, offers: [1, 2, 3] },
            { id: 'shared/claude-sonnet', name: 'claude-sonnet', provider_name: 'Shared', type: 'chat', status: 'available', routing_enabled: true, price: { input_per_million: 3, output_per_million: 15 } },
            { id: 'shared/gpt-5-nano', name: 'gpt-5-nano', provider_name: 'Shared', type: 'chat', status: 'available', routing_enabled: true, price: { input_per_million: 0.05, output_per_million: 0.4 } },
            { id: 'x/embed', name: 'embed', type: 'embedding', status: 'available' },
            { id: 'x/old', name: 'old', type: 'chat', status: 'available', retired_at: '2026-01-01' },
        ] }), { status: 200 });
    } });
    const a = await list.list();
    assert.deepStrictEqual(a.models.map((m) => m.id), ['shared/gpt-5-nano', 'shared/claude-sonnet', 'openai/gpt-5.2'], 'chat models that run here first, cheapest first; no embeddings, nothing retired');
    assert.deepStrictEqual(a.models[0], { id: 'shared/gpt-5-nano', name: 'gpt-5-nano', provider: 'Shared', in: 0.05, out: 0.4, here: true }, 'only what the picker shows');
    await list.list();
    assert.strictEqual(calls, 1, 'kept ten minutes');
    clock += 11 * 60 * 1000; up = false;
    assert.strictEqual((await list.list()).models.length, 3, 'Exchange down: the last list stays');
    console.log('make page: one h1, its script, text never markup; models cut from Exchange, kept, and kept when it is down');
})().catch((err) => { console.error(err); process.exit(1); });
