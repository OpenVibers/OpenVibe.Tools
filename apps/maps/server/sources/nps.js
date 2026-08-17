/**
 * ╔═══════════════════════════════════════════════════════════════════╗
 * ║                 NPS — National Park Service API                  ║
 * ║           Campgrounds, Visitor Centers, Parking Lots             ║
 * ╚═══════════════════════════════════════════════════════════════════╝
 *
 * API Docs: https://www.nps.gov/subjects/developer/api-documentation.htm
 * Base URL: https://developer.nps.gov/api/v1
 * Free API key required: https://www.nps.gov/subjects/developer/get-started.htm
 */

const axios = require('axios');
const { haversine } = require('./utils');

const BASE_URL = 'https://developer.nps.gov/api/v1';

// State code lookup from lat/lon (rough bounding boxes for US states + DC + territories)
// NPS API requires stateCode — we compute the 1-3 closest states from coordinates
const STATE_BOUNDS = [
  ['AL',30.2,-88.5,35.0,-84.9],['AK',51.2,-179.1,71.4,179.8],['AZ',31.3,-114.8,37.0,-109.0],
  ['AR',33.0,-94.6,36.5,-89.6],['CA',32.5,-124.4,42.0,-114.1],['CO',37.0,-109.1,41.0,-102.0],
  ['CT',41.0,-73.7,42.1,-71.8],['DE',38.5,-75.8,39.8,-75.0],['FL',24.5,-87.6,31.0,-80.0],
  ['GA',30.4,-85.6,35.0,-80.8],['HI',18.9,-160.2,22.2,-154.8],['ID',42.0,-117.2,49.0,-111.0],
  ['IL',37.0,-91.5,42.5,-87.0],['IN',37.8,-88.1,41.8,-84.8],['IA',40.4,-96.6,43.5,-90.1],
  ['KS',37.0,-102.1,40.0,-94.6],['KY',36.5,-89.6,39.1,-82.0],['LA',29.0,-94.0,33.0,-89.0],
  ['ME',43.1,-71.1,47.5,-67.0],['MD',37.9,-79.5,39.7,-75.0],['MA',41.2,-73.5,42.9,-69.9],
  ['MI',41.7,-90.4,48.3,-82.4],['MN',43.5,-97.2,49.4,-89.5],['MS',30.2,-91.7,35.0,-88.1],
  ['MO',36.0,-95.8,40.6,-89.1],['MT',44.4,-116.1,49.0,-104.0],['NE',40.0,-104.1,43.0,-95.3],
  ['NV',35.0,-120.0,42.0,-114.0],['NH',42.7,-72.6,45.3,-71.0],['NJ',39.0,-75.6,41.4,-74.0],
  ['NM',31.3,-109.1,37.0,-103.0],['NY',40.5,-79.8,45.0,-71.9],['NC',33.8,-84.3,36.6,-75.5],
  ['ND',45.9,-104.1,49.0,-96.6],['OH',38.4,-84.8,42.0,-80.5],['OK',33.6,-103.0,37.0,-94.4],
  ['OR',42.0,-124.6,46.3,-116.5],['PA',39.7,-80.5,42.3,-75.0],['RI',41.1,-71.9,42.0,-71.1],
  ['SC',32.0,-83.4,35.2,-78.5],['SD',42.5,-104.1,46.0,-96.4],['TN',35.0,-90.3,36.7,-81.6],
  ['TX',25.8,-106.6,36.5,-93.5],['UT',37.0,-114.1,42.0,-109.0],['VT',42.7,-73.4,45.0,-71.5],
  ['VA',36.5,-83.7,39.5,-75.2],['WA',45.5,-124.8,49.0,-116.9],['WV',37.2,-82.6,40.6,-77.7],
  ['WI',42.5,-92.9,47.1,-86.8],['WY',41.0,-111.1,45.0,-104.1],['DC',38.8,-77.1,39.0,-77.0],
];

function getNearbyCodes(lat, lon, radiusMiles) {
  // Find states whose bounding box is within reasonable range
  const results = [];
  for (const [code, sLat, wLon, nLat, eLon] of STATE_BOUNDS) {
    // Quick check: is the search center near this state's bbox?
    const cLat = (sLat + nLat) / 2;
    const cLon = (wLon + eLon) / 2;
    const dist = haversine(lat, lon, cLat, cLon);
    // Include if within radius + half the state's diagonal (generous)
    const stateDiag = haversine(sLat, wLon, nLat, eLon) / 2;
    if (dist < radiusMiles + stateDiag) {
      results.push(code);
    }
  }
  return results.length ? results.join(',') : null;
}

/**
 * Search NPS campgrounds near a location
 * @param {number} lat
 * @param {number} lon
 * @param {number} radiusMiles
 * @param {string} apiKey
 * @returns {Promise<Array>}
 */
async function searchCampgrounds(lat, lon, radiusMiles, apiKey) {
  if (!apiKey) return [];

  try {
    const stateCode = getNearbyCodes(lat, lon, radiusMiles);
    if (!stateCode) return [];
    const params = {
      api_key: apiKey,
      limit: 200,
      stateCode,
    };

    const resp = await axios.get(`${BASE_URL}/campgrounds`, {
      params,
      timeout: 15000,
      headers: { 'User-Agent': 'OpenVibeApp/2.0' },
    });

    if (!resp.data?.data) return [];

    return resp.data.data
      .filter(c => c.latitude && c.longitude)
      .map(c => {
        const cLat = parseFloat(c.latitude);
        const cLon = parseFloat(c.longitude);
        const dist = haversine(lat, lon, cLat, cLon);
        if (dist > radiusMiles) return null;

        const amenityList = [];
        if (c.amenities) {
          if (c.amenities.trashRecyclingCollection !== 'No') amenityList.push('Trash Collection');
          if (c.amenities.toilets && !c.amenities.toilets.includes('None')) amenityList.push('Toilets');
          if (c.amenities.showers && !c.amenities.showers.includes('None')) amenityList.push('Showers');
          if (c.amenities.cellPhoneReception !== 'No') amenityList.push('Cell Service');
          if (c.amenities.campStore !== 'No') amenityList.push('Camp Store');
          if (c.amenities.potableWater && !c.amenities.potableWater.includes('No')) amenityList.push('Potable Water');
          if (c.amenities.firewoodForSale !== 'No') amenityList.push('Firewood');
          if (c.amenities.foodStorageLockers !== 'No') amenityList.push('Food Lockers');
        }

        const feeParts = [];
        if (c.fees?.length) {
          c.fees.forEach(f => feeParts.push(`${f.title}: $${f.cost}`));
        }

        return {
          id: `nps-camp-${c.id}`,
          name: c.name,
          description: [
            c.description?.slice(0, 250) || '',
            c.numberOfSitesReservable ? `Reservable sites: ${c.numberOfSitesReservable}` : '',
            c.numberOfSitesFirstComeFirstServe ? `FCFS sites: ${c.numberOfSitesFirstComeFirstServe}` : '',
            feeParts.length ? feeParts.join(', ') : '',
            c.weatherOverview ? `Weather: ${c.weatherOverview.slice(0, 120)}` : '',
          ].filter(Boolean).join(' | '),
          lat: cLat,
          lon: cLon,
          distanceMiles: Math.round(dist * 10) / 10,
          type: 'Campground',
          source: 'NPS',
          sourceIcon: 'fa-mountain-sun',
          reservable: parseInt(c.numberOfSitesReservable) > 0,
          url: c.url || `https://www.nps.gov/${c.parkCode}/planyourvisit/campgrounds.htm`,
          fee: feeParts.length ? feeParts[0] : 'Check NPS',
          stealthRating: 2,
          tags: ['nps', 'campground', 'national-park', ...(c.accessibility?.rvAllowed === '1' ? ['rv'] : [])],
          amenities: amenityList,
          parkCode: c.parkCode,
        };
      })
      .filter(Boolean);
  } catch (err) {
    console.warn('[NPS] Campground search error:', err.message);
    return [];
  }
}

/**
 * Search NPS visitor centers near a location
 */
async function searchVisitorCenters(lat, lon, radiusMiles, apiKey) {
  if (!apiKey) return [];

  try {
    const resp = await axios.get(`${BASE_URL}/visitorcenters`, {
      params: { api_key: apiKey, limit: 100, stateCode: getNearbyCodes(lat, lon, radiusMiles) || 'WA' },
      timeout: 10000,
      headers: { 'User-Agent': 'OpenVibeApp/2.0' },
    });

    if (!resp.data?.data) return [];

    return resp.data.data
      .filter(v => v.latitude && v.longitude)
      .map(v => {
        const vLat = parseFloat(v.latitude);
        const vLon = parseFloat(v.longitude);
        const dist = haversine(lat, lon, vLat, vLon);
        if (dist > radiusMiles) return null;

        return {
          id: `nps-vc-${v.id}`,
          name: v.name,
          description: [
            v.description?.slice(0, 200) || '',
            v.operatingHours?.[0]?.description ? `Hours: ${v.operatingHours[0].description.slice(0, 100)}` : '',
          ].filter(Boolean).join(' | '),
          lat: vLat,
          lon: vLon,
          distanceMiles: Math.round(dist * 10) / 10,
          type: 'Visitor Center',
          source: 'NPS',
          sourceIcon: 'fa-mountain-sun',
          reservable: false,
          url: v.url,
          fee: 'Free',
          stealthRating: 1,
          tags: ['nps', 'visitor-center', 'restroom', 'water', 'info'],
          amenities: ['Restrooms', 'Information', 'Water'],
          parkCode: v.parkCode,
        };
      })
      .filter(Boolean);
  } catch (err) {
    console.warn('[NPS] Visitor center search error:', err.message);
    return [];
  }
}

/**
 * Search NPS parking lots near a location
 */
async function searchParkingLots(lat, lon, radiusMiles, apiKey) {
  if (!apiKey) return [];

  try {
    const resp = await axios.get(`${BASE_URL}/parkinglots`, {
      params: { api_key: apiKey, limit: 100, stateCode: getNearbyCodes(lat, lon, radiusMiles) || 'WA' },
      timeout: 10000,
      headers: { 'User-Agent': 'OpenVibeApp/2.0' },
    });

    if (!resp.data?.data) return [];

    return resp.data.data
      .filter(p => p.latitude && p.longitude)
      .map(p => {
        const pLat = parseFloat(p.latitude);
        const pLon = parseFloat(p.longitude);
        const dist = haversine(lat, lon, pLat, pLon);
        if (dist > radiusMiles) return null;

        return {
          id: `nps-lot-${p.id}`,
          name: p.name || 'NPS Parking Lot',
          description: [
            p.description?.slice(0, 200) || '',
            p.isOvernightParkingAllowed === 'Yes' ? '🅿️ Overnight parking allowed!' : '',
            p.managedByOrganization || '',
          ].filter(Boolean).join(' | '),
          lat: pLat,
          lon: pLon,
          distanceMiles: Math.round(dist * 10) / 10,
          type: p.isOvernightParkingAllowed === 'Yes' ? 'Overnight Parking' : 'Parking Lot',
          source: 'NPS',
          sourceIcon: 'fa-mountain-sun',
          reservable: false,
          url: null,
          fee: 'Check NPS',
          stealthRating: p.isOvernightParkingAllowed === 'Yes' ? 3 : 1,
          tags: ['nps', 'parking', p.isOvernightParkingAllowed === 'Yes' ? 'overnight' : ''].filter(Boolean),
          amenities: [],
          parkCode: p.parkCode,
        };
      })
      .filter(Boolean);
  } catch (err) {
    console.warn('[NPS] Parking lot search error:', err.message);
    return [];
  }
}

/**
 * Combined NPS search — campgrounds + visitor centers + parking lots
 */
async function search(lat, lon, radiusMiles, apiKey) {
  if (!apiKey) {
    console.log('[NPS] No API key configured — skipping');
    return [];
  }

  const [campgrounds, visitorCenters, parkingLots] = await Promise.allSettled([
    searchCampgrounds(lat, lon, radiusMiles, apiKey),
    searchVisitorCenters(lat, lon, radiusMiles, apiKey),
    searchParkingLots(lat, lon, radiusMiles, apiKey),
  ]);

  const results = [];
  if (campgrounds.status === 'fulfilled') results.push(...campgrounds.value);
  if (visitorCenters.status === 'fulfilled') results.push(...visitorCenters.value);
  if (parkingLots.status === 'fulfilled') results.push(...parkingLots.value);

  console.log(`[NPS] Found ${results.length} results (${campgrounds.value?.length || 0} campgrounds, ${visitorCenters.value?.length || 0} VCs, ${parkingLots.value?.length || 0} parking lots)`);
  return results;
}

module.exports = { search, searchCampgrounds, searchVisitorCenters, searchParkingLots };
