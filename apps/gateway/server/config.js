'use strict';

require('dotenv').config();

const isProduction = (process.env.NODE_ENV || 'development') === 'production';

module.exports = {
    port: parseInt(process.env.PORT, 10) || 4001,
    // Loopback only: nginx (every vhost, custom domains included) reaches it on 127.0.0.1, so it cannot
    // be bypassed through an open host firewall, skipping nginx's rate limits.
    host: process.env.HOST || '127.0.0.1',
    nodeEnv: process.env.NODE_ENV || 'development',
    isProduction,

    // Public URL of this gateway (apex directory + Host-routed tool subdomains)
    baseUrl: process.env.BASE_URL || (isProduction ? 'https://openvibe.tools' : 'http://localhost:4001'),

    // Identity provider — OpenVibe.Network (OAuth2 authorization server)
    networkUrl: process.env.OV_NETWORK_URL || 'https://openvibe.network',
    networkInternalUrl: process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000',
    // OpenVibe.Exchange's public model directory: the Make a tool page's model picker (made/models.js).
    exchange: { url: (process.env.OV_EXCHANGE_URL || 'https://openvibe.exchange').replace(/\/+$/, '') },
    // OpenVibe.AI, where a prompt tool people made runs (made/prompt.js) as the person who runs it.
    ai: {
        url: (process.env.OV_AI_URL || 'https://ai.openvibe.services').replace(/\/+$/, ''),
        audience: process.env.OV_AI_AUDIENCE || 'openvibe.ai',
    },

    // OpenVibe.Run, where a code tool people made runs as a function job (made/run-code.js, §AD.13 (2)): as OpenVibe's
    // operator (TOOLS_RUN_SUBJECT, usr_…) in their project (TOOLS_RUN_PROJECT, prj_…), the way Run's own checks run.
    // Either unset: code tools run on their page only.
    run: {
        url: (process.env.OV_RUN_INTERNAL_URL || 'http://127.0.0.1:4920').replace(/\/+$/, ''),
        audience: process.env.OV_RUN_AUDIENCE || 'openvibe.run',
        subject: process.env.TOOLS_RUN_SUBJECT || '',
        project: process.env.TOOLS_RUN_PROJECT || '',
    },

    // OAuth2 client credentials (client seeded in Network's oauth_clients table)
    oauth: {
        clientId: process.env.OV_OAUTH_CLIENT_ID || 'tools',
        clientSecret: process.env.OV_OAUTH_CLIENT_SECRET || '',
        redirectUri: process.env.OV_OAUTH_REDIRECT_URI
            || (isProduction ? 'https://openvibe.tools/auth/callback' : 'http://localhost:4001/auth/callback'),
        scope: 'profile theme',
    },

    // Cookie settings — ov_token is shared across every *.openvibe.tools subdomain
    cookies: {
        domain: process.env.COOKIE_DOMAIN || (isProduction ? '.openvibe.tools' : ''),
        secure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : isProduction,
    },

    // OpenVibe.Community owns pastes (roadmap Wave 5); the paste front-end's API goes straight there.
    communityUrl: (process.env.OV_COMMUNITY_INTERNAL_URL || 'http://127.0.0.1:4200').replace(/\/$/, ''),

    // IndexNow (openvibe-shared/indexnow): with INDEXNOW_KEY set the key file is served at
    // /<key>.txt so engines can verify this site. Unset: off — nothing is mounted and nothing is sent.
    indexnow: { key: process.env.INDEXNOW_KEY || '' },
};
