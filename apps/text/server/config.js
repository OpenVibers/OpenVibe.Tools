'use strict';
require('dotenv').config();

module.exports = {
    port: parseInt(process.env.PORT, 10) || 4015,
    // Loopback only, like the other satellites: nginx reaches it on 127.0.0.1, so it cannot be
    // bypassed through an open host firewall, skipping nginx's rate limits.
    host: process.env.HOST || '127.0.0.1',
    baseUrl: process.env.BASE_URL || 'https://text.openvibe.tools',
    openvibeToolsUrl: process.env.OV_NETWORK_URL || 'https://openvibe.network',
};
