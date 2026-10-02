'use strict';
require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT, 10) || 4010,
  host: process.env.HOST || '0.0.0.0',
  baseUrl: process.env.BASE_URL || 'https://maps.openvibe.tools',

  // API Keys (optional — free tiers work without most of these)
  ridbApiKey: process.env.RIDB_API_KEY || '',   // passed to sources/ridb.js; never a key in the code
  npsApiKey: process.env.NPS_API_KEY || '',
  openChargeMapKey: process.env.OPEN_CHARGE_MAP_KEY || '',

  // Cache durations (seconds)
  cache: {
    search: 300,      // 5 min for search results
    weather: 600,     // 10 min for weather
    geocode: 3600,    // 1 hr for geocode
  },
};
