'use strict';
// ═══════════════════════════════════════════════════════════════
// Maps & Food — the descriptors of the two places tools (tools.tool@1 specs, ADR-027): the survival
// map (this app, maps.openvibe.tools) and the budget food finder (apps/food, which serves its page and
// proxies every data call to this app's /api routes).
//
// Both are map applications rather than single transforms: their pages call several server routes
// (geocoding, place search, weather, food banks, meal plans) answered inline, so execution is sync, and
// there is no run API for them (api false). Their lookups go to OpenStreetMap and weather services,
// never to a host the caller chose (egress false).
// ═══════════════════════════════════════════════════════════════

const PLACES = {
    type: 'object',
    description: 'The pages\' own routes answer JSON: /api/geocode, /api/search, /api/weather, /api/terrain, /api/food-banks, /api/stores, /api/foods, /api/meal-plan',
};

const place = (id, legacy) => ({
    id, execution: 'sync', api: false,
    input: null, files: null,
    output: { kind: 'json', schema: PLACES },
    limits: { timeoutMs: 30000 },
    auth: { anonymous: true, capability: 'tools.tool.run' },
    quotaClass: 'tools-map', cost: 2, egress: false,
    route: { method: 'GET', paths: legacy },
});

const SPECS = [
    place('maps', ['/api/geocode', '/api/search', '/api/search/stream', '/api/weather', '/api/terrain', '/api/food-banks', '/api/stores']),
    place('food', ['/api/food-banks', '/api/stores', '/api/foods', '/api/meal-plan', '/api/geocode']),
];

module.exports = { SPECS };
