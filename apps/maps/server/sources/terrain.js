/**
 * Terrain & Land Analysis Module
 * Uses public data to assess terrain suitability for camping.
 * - Open-Meteo elevation API
 * - OpenStreetMap land use data via Overpass
 * - Slope/terrain classification
 */
const axios = require('axios');

/**
 * Get elevation data for a point.
 */
async function getElevation(lat, lon) {
  try {
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`;
    const resp = await axios.get(url, { timeout: 5000 });
    return resp.data?.elevation?.[0] ?? null;
  } catch (e) {
    return null;
  }
}

/**
 * Get bulk elevation for multiple points (max 100).
 */
async function getBulkElevation(coords) {
  if (!coords || coords.length === 0) return [];
  const lats = coords.map(c => c.lat).join(',');
  const lons = coords.map(c => c.lon).join(',');
  try {
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lons}`;
    const resp = await axios.get(url, { timeout: 8000 });
    return resp.data?.elevation || [];
  } catch (e) {
    return coords.map(() => null);
  }
}

/**
 * Classify camping suitability based on elevation.
 */
function classifyElevation(elev) {
  if (elev === null) return { class: 'unknown', label: 'Unknown', icon: 'fa-question' };
  if (elev < 100) return { class: 'lowland', label: 'Lowland/Valley', icon: 'fa-water', note: 'Near sea level. May flood in winter.' };
  if (elev < 500) return { class: 'foothills', label: 'Foothills', icon: 'fa-hill-rockslide', note: 'Moderate elevation. Good year-round camping.' };
  if (elev < 1500) return { class: 'mountain', label: 'Mountain', icon: 'fa-mountain', note: 'Mountain terrain. Snow possible Oct-May.' };
  if (elev < 2500) return { class: 'alpine', label: 'High Mountain', icon: 'fa-mountain-sun', note: 'High altitude. Snow likely Nov-Jun. Be prepared for weather.' };
  return { class: 'alpine-extreme', label: 'Alpine/Extreme', icon: 'fa-mountain-sun', note: 'Very high altitude. Extreme conditions. Summer access only.' };
}

/**
 * Analyze land use around a point using Overpass.
 */
async function analyzeLandUse(lat, lon, radiusMeters = 500) {
  try {
    const query = `
      [out:json][timeout:10];
      (
        way["landuse"](around:${radiusMeters},${lat},${lon});
        way["natural"](around:${radiusMeters},${lat},${lon});
        way["leisure"](around:${radiusMeters},${lat},${lon});
      );
      out tags;
    `;
    const resp = await axios.post('https://overpass-api.de/api/interpreter', `data=${encodeURIComponent(query)}`, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    });

    const elements = resp.data?.elements || [];
    const landTypes = {};

    for (const el of elements) {
      const tags = el.tags || {};
      if (tags.landuse) landTypes[`landuse:${tags.landuse}`] = (landTypes[`landuse:${tags.landuse}`] || 0) + 1;
      if (tags.natural) landTypes[`natural:${tags.natural}`] = (landTypes[`natural:${tags.natural}`] || 0) + 1;
      if (tags.leisure) landTypes[`leisure:${tags.leisure}`] = (landTypes[`leisure:${tags.leisure}`] || 0) + 1;
    }

    return {
      landTypes,
      hasForest: Object.keys(landTypes).some(k => k.includes('forest') || k.includes('wood')),
      hasWater: Object.keys(landTypes).some(k => k.includes('water') || k.includes('river') || k.includes('lake')),
      isUrban: Object.keys(landTypes).some(k => k.includes('residential') || k.includes('commercial') || k.includes('industrial')),
      isPark: Object.keys(landTypes).some(k => k.includes('park') || k.includes('nature_reserve')),
      coverScore: calculateCoverScore(landTypes),
    };
  } catch (e) {
    return { landTypes: {}, hasForest: false, hasWater: false, isUrban: false, isPark: false, coverScore: 0 };
  }
}

/**
 * Calculate a "cover score" – how much natural cover exists for stealth camping.
 */
function calculateCoverScore(landTypes) {
  let score = 0;
  for (const [key, count] of Object.entries(landTypes)) {
    if (key.includes('forest') || key.includes('wood')) score += 3 * count;
    if (key.includes('scrub') || key.includes('heath')) score += 2 * count;
    if (key.includes('nature_reserve') || key.includes('park')) score += 2 * count;
    if (key.includes('meadow') || key.includes('grassland')) score += 1 * count;
    if (key.includes('residential') || key.includes('commercial')) score -= 2 * count;
    if (key.includes('industrial')) score -= 1 * count;
  }
  return Math.max(0, Math.min(10, score));
}

module.exports = { getElevation, getBulkElevation, classifyElevation, analyzeLandUse };
