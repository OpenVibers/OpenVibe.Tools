'use strict';
// What openvibe.tools tells an agent about itself (openvibe-shared/agent-layer): /.well-known/agent.json.
// The directory and tool pages are public; the run API is /api/v1 (an OpenAPI 3.1 document is published at
// /api/v1/openapi.json) and /developers documents it. Auth is none + Network OIDC (bearer for app tokens).
module.exports = {
    id: 'tools',
    name: 'OpenVibe.Tools',
    purpose: 'The OpenVibe network\'s tool suite: converters, file and PDF tools, developer utilities and network checks, open in the browser or callable through one JSON API.',
    home: 'https://openvibe.tools',
    site: 'openvibe.tools',
    api: '/api/v1',
    openapi: '/api/v1/openapi.json',
    docs: '/developers',
    policy: {
        auth: ['none', 'Network OIDC', 'bearer'],
        rateLimit: 'Anonymous tool runs follow the per-address tool quota; signing in or an app token raises the tier, and every answer carries RateLimit-* headers',
    },
};
