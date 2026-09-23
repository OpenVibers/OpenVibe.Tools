'use strict';

require('dotenv').config();

const isProduction = (process.env.NODE_ENV || 'development') === 'production';

module.exports = {
    port: parseInt(process.env.PORT, 10) || 4001,
    host: process.env.HOST || '0.0.0.0',
    nodeEnv: process.env.NODE_ENV || 'development',
    isProduction,

    // Public URL of this gateway (apex directory + Host-routed tool subdomains)
    baseUrl: process.env.BASE_URL || (isProduction ? 'https://openvibe.tools' : 'http://localhost:4001'),

    // Identity provider — OpenVibe.Network (OAuth2 authorization server)
    networkUrl: process.env.OV_NETWORK_URL || 'https://openvibe.network',
    networkInternalUrl: process.env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000',

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

    // OpenVibe.Live — backs the Paste.OpenVibe front-end. The pastes themselves are
    // stored in OpenVibe.Media, but we go through Live rather than straight to Media:
    // Live owns the accounts these pastes belong to, so it is the only service that can
    // turn a signed-in visitor into the user id Media files the write under.
    liveUrl: process.env.LIVE_URL || 'http://127.0.0.1:3000',
    // OpenVibe.Community owns pastes (roadmap Wave 5); the paste front-end's API goes straight there.
    communityUrl: (process.env.OV_COMMUNITY_INTERNAL_URL || 'http://127.0.0.1:4200').replace(/\/$/, ''),
};
