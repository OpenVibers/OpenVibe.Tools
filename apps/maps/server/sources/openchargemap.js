/**
 * ╔═══════════════════════════════════════════════════════════════════╗
 * ║            OpenChargeMap — EV Charging Station Finder            ║
 * ║         For van/vehicle dwellers needing power & parking         ║
 * ╚═══════════════════════════════════════════════════════════════════╝
 *
 * API Docs: https://openchargemap.org/site/develop/api
 * Free & open — works without key but key gives higher rate limits
 */

const axios = require('axios');
const { haversine } = require('./utils');

const BASE_URL = 'https://api.openchargemap.io/v3/poi';

/**
 * Search for EV charging stations near a location
 * Useful for van/vehicle dwellers: parking spots with power, restrooms nearby
 */
async function search(lat, lon, radiusMiles, apiKey) {
  try {
    const params = {
      output: 'json',
      latitude: lat,
      longitude: lon,
      distance: radiusMiles,
      distanceunit: 'Miles',
      maxresults: 50,
      compact: true,
      verbose: false,
    };

    if (apiKey) params.key = apiKey;

    const resp = await axios.get(BASE_URL, {
      params,
      timeout: 12000,
      headers: { 'User-Agent': 'OpenVibeApp/2.0' },
    });

    if (!Array.isArray(resp.data)) return [];

    return resp.data
      .filter(s => s.AddressInfo?.Latitude && s.AddressInfo?.Longitude)
      .map(s => {
        const addr = s.AddressInfo;
        const sLat = addr.Latitude;
        const sLon = addr.Longitude;
        const dist = haversine(lat, lon, sLat, sLon);

        // Connection info
        const connections = (s.Connections || []).map(c => {
          const parts = [];
          if (c.ConnectionType?.Title) parts.push(c.ConnectionType.Title);
          if (c.PowerKW) parts.push(`${c.PowerKW}kW`);
          if (c.LevelID) parts.push(`L${c.LevelID}`);
          return parts.join(' ');
        }).filter(Boolean);

        // Determine if free
        const isFree = s.UsageCost?.toLowerCase().includes('free') ||
                       s.UsageType?.Title?.toLowerCase().includes('free') ||
                       !s.UsageCost;

        // Status
        const isOperational = !s.StatusType || s.StatusType.IsOperational !== false;

        // Access type hints
        const access = s.UsageType?.Title || '';
        const isPublic = access.toLowerCase().includes('public');
        const is24h = access.toLowerCase().includes('24') || s.AddressInfo?.AccessComments?.toLowerCase().includes('24');

        const descParts = [
          connections.length ? `Connectors: ${connections.join(', ')}` : '',
          s.UsageCost || '',
          access ? `Access: ${access}` : '',
          addr.AccessComments?.slice(0, 120) || '',
          s.NumberOfPoints ? `${s.NumberOfPoints} charging point(s)` : '',
          isOperational ? '' : '⚠️ May be non-operational',
          is24h ? '24/7 access' : '',
        ].filter(Boolean);

        return {
          id: `ocm-${s.ID}`,
          name: addr.Title || s.OperatorInfo?.Title || 'EV Charging Station',
          description: descParts.join(' | ') || 'EV charging station.',
          lat: sLat,
          lon: sLon,
          distanceMiles: Math.round(dist * 10) / 10,
          type: 'EV Charging',
          source: 'OpenChargeMap',
          sourceIcon: 'fa-charging-station',
          reservable: false,
          url: `https://openchargemap.org/site/poi/details/${s.ID}`,
          fee: isFree ? 'Free' : (s.UsageCost || 'Check station'),
          stealthRating: 2,
          tags: [
            'ev-charging', 'parking', 'power',
            isFree ? 'free' : '',
            isPublic ? 'public' : '',
            is24h ? '24-7' : '',
          ].filter(Boolean),
          amenities: [
            'EV Charging',
            'Parking',
            ...(connections.length > 0 ? [connections[0]] : []),
          ],
          operator: s.OperatorInfo?.Title || '',
        };
      })
      .filter(s => s.distanceMiles <= radiusMiles);
  } catch (err) {
    console.warn('[OpenChargeMap] Search error:', err.message);
    return [];
  }
}

module.exports = { search };
