'use strict';
require('dotenv').config();

module.exports = {
    port: parseInt(process.env.PORT, 10) || 4015,
    host: process.env.HOST || '0.0.0.0',
    baseUrl: process.env.BASE_URL || 'https://text.openvibe.tools',
    openvibeToolsUrl: process.env.OV_NETWORK_URL || 'https://openvibe.network',
};
