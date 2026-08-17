/**
 * RIDB Module – Recreation Information Database (Recreation.gov) API
 * Free federal recreation data: campgrounds, facilities, rec areas.
 * API Docs: https://ridb.recreation.gov/docs
 *
 * NOTE: RIDB API requires an API key.  We use a demo/public-tier key.
 * Users should register at https://ridb.recreation.gov/ for their own key.
 */
const axios = require('axios');
const { haversine } = require('./utils');

// Use env var RIDB_API_KEY if set, otherwise fall back to default key
const API_KEY = process.env.RIDB_API_KEY || '10157187-d1f3-4c78-a3c2-5a4d8c23d715';
const BASE_URL = 'https://ridb.recreation.gov/api/v1';
let _ridbDisabled = false; // Disable after first 401 to avoid duplicate errors

const CAMPING_ACTIVITY_IDS = [
  9,   // Camping
  6,   // Biking (useful for BLM roads)
  14,  // Hiking
  26,  // Picnicking (day-use areas)
];



/**
 * Search RIDB for facilities near lat/lon within radiusMiles
 */
async function search(lat, lon, radiusMiles) {
  if (_ridbDisabled) return []; // Skip after auth failure
  const results = [];

  try {
    // Search facilities by lat/lon with radius
    const { data } = await axios.get(`${BASE_URL}/facilities`, {
      params: {
        latitude: lat,
        longitude: lon,
        radius: radiusMiles,
        activity: CAMPING_ACTIVITY_IDS.join(','),
        limit: 50,
        offset: 0,
      },
      headers: {
        apikey: API_KEY,
        Accept: 'application/json',
      },
      timeout: 15000,
    });

    const facilities = data?.RECDATA || data?.recdata || [];

    for (const f of facilities) {
      const fLat = parseFloat(f.FacilityLatitude);
      const fLon = parseFloat(f.FacilityLongitude);
      if (!fLat || !fLon) continue;

      const dist = haversine(lat, lon, fLat, fLon);

      results.push({
        id: `ridb-${f.FacilityID}`,
        facilityId: f.FacilityID,
        name: f.FacilityName || 'Unnamed Facility',
        description: stripHtml(f.FacilityDescription || ''),
        lat: fLat,
        lon: fLon,
        distanceMiles: Math.round(dist * 10) / 10,
        type: classifyFacility(f),
        source: 'RIDB',
        sourceIcon: 'fa-tree',
        reservable: f.Reservable === true || f.Reservable === 'true',
        url: `https://www.recreation.gov/camping/campgrounds/${f.FacilityID}`,
        phone: f.FacilityPhone || null,
        fee: f.FacilityUseFeeDescription || 'Unknown',
        stealthRating: computeStealthRating(f),
        tags: extractTags(f),
      });
    }
  } catch (err) {
    if (err?.response?.status === 401) {
      console.warn('[RIDB] API key invalid or expired (401). Set RIDB_API_KEY env var with a valid key from https://ridb.recreation.gov/');
      _ridbDisabled = true;
    } else {
      console.error('[RIDB] API error:', err.message);
    }
  }

  // Also try RecAreas (larger tracts like national forests)
  if (_ridbDisabled) return results;
  try {
    const { data } = await axios.get(`${BASE_URL}/recareas`, {
      params: {
        latitude: lat,
        longitude: lon,
        radius: radiusMiles,
        limit: 25,
      },
      headers: {
        apikey: API_KEY,
        Accept: 'application/json',
      },
      timeout: 15000,
    });

    const areas = data?.RECDATA || data?.recdata || [];

    for (const a of areas) {
      const aLat = parseFloat(a.RecAreaLatitude);
      const aLon = parseFloat(a.RecAreaLongitude);
      if (!aLat || !aLon) continue;

      const dist = haversine(lat, lon, aLat, aLon);

      results.push({
        id: `ridb-area-${a.RecAreaID}`,
        name: a.RecAreaName || 'Unnamed Recreation Area',
        description: stripHtml(a.RecAreaDescription || ''),
        lat: aLat,
        lon: aLon,
        distanceMiles: Math.round(dist * 10) / 10,
        type: 'Recreation Area',
        source: 'RIDB',
        sourceIcon: 'fa-mountain',
        reservable: false,
        url: a.RecAreaURL || `https://ridb.recreation.gov/`,
        stealthRating: 4, // Large rec areas great for dispersed camping
        tags: ['federal-land', 'recreation-area'],
      });
    }
  } catch (err) {
    if (err?.response?.status === 401) {
      console.warn('[RIDB] API key invalid or expired (401). Skipping RecAreas.');
      _ridbDisabled = true;
    } else {
      console.error('[RIDB] RecAreas error:', err.message);
    }
  }

  return results;
}

/**
 * Get detailed facility info from RIDB
 */
async function getDetail(facilityId) {
  const { data } = await axios.get(`${BASE_URL}/facilities/${facilityId}`, {
    headers: { apikey: API_KEY, Accept: 'application/json' },
    timeout: 10000,
  });
  return data;
}

function classifyFacility(f) {
  const name = (f.FacilityName || '').toLowerCase();
  const desc = (f.FacilityDescription || '').toLowerCase();
  const combined = name + ' ' + desc;
  if (combined.includes('dispersed') || combined.includes('primitive')) return 'Dispersed Camping';
  if (combined.includes('campground')) return 'Campground';
  if (combined.includes('trail')) return 'Trailhead';
  if (combined.includes('shelter')) return 'Shelter';
  if (combined.includes('day use') || combined.includes('picnic')) return 'Day Use Area';
  if (combined.includes('cabin')) return 'Cabin';
  return 'Recreation Facility';
}

function computeStealthRating(f) {
  // 1-5 rating of how suitable for stealth/dispersed camping
  let rating = 3;
  const name = (f.FacilityName || '').toLowerCase();
  const desc = (f.FacilityDescription || '').toLowerCase();
  if (name.includes('dispersed') || desc.includes('dispersed')) rating = 5;
  if (name.includes('primitive') || desc.includes('primitive')) rating += 1;
  if (name.includes('backcountry') || desc.includes('backcountry')) rating += 1;
  if (desc.includes('free') || desc.includes('no fee')) rating += 1;
  if (f.Reservable === true) rating -= 1; // Reservable = more regulated
  return Math.max(1, Math.min(5, rating));
}

function extractTags(f) {
  const tags = [];
  const combined = ((f.FacilityName || '') + ' ' + (f.FacilityDescription || '')).toLowerCase();
  if (combined.includes('forest')) tags.push('forest');
  if (combined.includes('blm') || combined.includes('bureau of land')) tags.push('blm');
  if (combined.includes('national')) tags.push('national');
  if (combined.includes('state')) tags.push('state');
  if (combined.includes('wilderness')) tags.push('wilderness');
  if (combined.includes('dispersed')) tags.push('dispersed');
  if (combined.includes('free') || combined.includes('no fee')) tags.push('free');
  if (combined.includes('water')) tags.push('water-nearby');
  if (combined.includes('toilet') || combined.includes('restroom')) tags.push('restroom');
  return tags;
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim().substring(0, 500);
}

module.exports = { search, getDetail };
