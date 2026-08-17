/**
 * ╔═══════════════════════════════════════════════════════════════════╗
 * ║               Web Scraper — Camping & Outdoor Sites              ║
 * ║    Scrapes public web pages for dispersed camping & stealth      ║
 * ║    spots, rest areas, Walmart lots, and BLM/DNR land data.       ║
 * ╚═══════════════════════════════════════════════════════════════════╝
 *
 * Sources scraped:
 *   - Campendium (campground/boondocking data)
 *   - US Rest Areas (highway rest stops)
 *   - Wikipedia geolocation data
 *   - USGS Waterfall database
 */

const axios = require('axios');
const cheerio = require('cheerio');
const { haversine, overpassQuery } = require('./utils');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

/**
 * Scrape Campendium for dispersed/boondocking spots near a location
 * Returns structured camping data from search results
 */
async function scrapeCampendium(lat, lon, radiusMiles) {
  try {
    const resp = await axios.get('https://www.campendium.com/api/v2/campgrounds', {
      params: {
        lat,
        lng: lon,
        radius: Math.min(radiusMiles, 50),
        limit: 30,
        sort: 'distance',
      },
      timeout: 10000,
      headers: { ...HEADERS, Accept: 'application/json' },
    });

    if (!resp.data?.campgrounds) return [];

    return resp.data.campgrounds
      .filter(c => c.latitude && c.longitude)
      .map(c => {
        const dist = haversine(lat, lon, c.latitude, c.longitude);
        const isFree = c.price === 0 || c.price_label?.toLowerCase().includes('free');
        const isDispersed = c.campground_type?.toLowerCase().includes('dispersed') ||
                            c.campground_type?.toLowerCase().includes('boondock');

        return {
          id: `campendium-${c.id}`,
          name: c.name,
          description: [
            c.tagline || '',
            c.campground_type || '',
            c.cell_signal ? `Cell: ${c.cell_signal}` : '',
            c.price_label || '',
          ].filter(Boolean).join(' | '),
          lat: c.latitude,
          lon: c.longitude,
          distanceMiles: Math.round(dist * 10) / 10,
          type: isDispersed ? 'Dispersed Camping' : 'Campground',
          source: 'Campendium',
          sourceIcon: 'fa-campground',
          reservable: false,
          url: c.url || `https://www.campendium.com/campgrounds/${c.slug || c.id}`,
          fee: isFree ? 'Free' : (c.price_label || 'Check site'),
          stealthRating: isDispersed ? 4 : 2,
          tags: [
            'campground',
            isFree ? 'free' : '',
            isDispersed ? 'dispersed' : '',
            c.cell_signal ? 'cell-service' : '',
          ].filter(Boolean),
          amenities: [],
        };
      });
  } catch (err) {
    // Campendium API might not be publicly accessible; fail silently
    console.warn('[Scraper] Campendium error:', err.message);
    return [];
  }
}

/**
 * Scrape USGS geographic names (GNIS) for waterfalls, springs, and parks
 * Uses the USGS Geographic Names Information System
 */
async function scrapeUSGSFeatures(lat, lon, radiusMiles) {
  try {
    // GNIS Feature Search API
    const resp = await axios.get('https://edits.nationalmap.gov/apps/gaz-domestic/api/search', {
      params: {
        lat,
        lon,
        radius: Math.min(radiusMiles * 1.609, 80), // Convert to km, max 80km
        featureClass: 'Falls,Spring,Park,Reservoir,Lake',
        limit: 30,
      },
      timeout: 10000,
      headers: HEADERS,
    });

    if (!resp.data?.features) return [];

    return resp.data.features
      .filter(f => f.attributes?.prim_lat_dec && f.attributes?.prim_long_dec)
      .map(f => {
        const a = f.attributes;
        const fLat = a.prim_lat_dec;
        const fLon = a.prim_long_dec;
        const dist = haversine(lat, lon, fLat, fLon);

        const featureClass = a.feature_class || '';
        let type = 'Water Access';
        if (featureClass === 'Falls') type = 'Waterfall';
        else if (featureClass === 'Spring') type = 'Spring';
        else if (featureClass === 'Park') type = 'Park';
        else if (featureClass === 'Reservoir' || featureClass === 'Lake') type = 'Lake';

        return {
          id: `gnis-${a.feature_id}`,
          name: a.feature_name,
          description: [
            `${featureClass} in ${a.county_name || ''} County, ${a.state_alpha || 'WA'}`,
            a.elev_in_ft ? `Elevation: ${a.elev_in_ft} ft` : '',
          ].filter(Boolean).join(' | '),
          lat: fLat,
          lon: fLon,
          distanceMiles: Math.round(dist * 10) / 10,
          type,
          source: 'USGS',
          sourceIcon: 'fa-mountain',
          reservable: false,
          url: `https://edits.nationalmap.gov/apps/gaz-domestic/api/search?featureId=${a.feature_id}`,
          fee: 'Free',
          stealthRating: type === 'Waterfall' || type === 'Spring' ? 3 : 2,
          tags: ['usgs', featureClass.toLowerCase(), 'water'].filter(Boolean),
          amenities: [],
        };
      });
  } catch (err) {
    console.warn('[Scraper] USGS GNIS error:', err.message);
    return [];
  }
}

/**
 * Scrape overnight parking / Walmart / Cracker Barrel data
 * Uses the AllStays pattern via HTML scraping
 */
async function scrapeOvernightParking(lat, lon, radiusMiles) {
  try {
    // Use OSM Overpass to find Walmart, Cracker Barrel, casino, and rest areas
    const radiusMeters = Math.min(radiusMiles, 30) * 1609.344;
    const query = `[out:json][timeout:15];
(
  node["shop"="department_store"]["brand"~"Walmart|Meijer"](around:${radiusMeters},${lat},${lon});
  node["amenity"="casino"](around:${radiusMeters},${lat},${lon});
  node["amenity"="rest_area"](around:${radiusMeters},${lat},${lon});
  node["highway"="rest_area"](around:${radiusMeters},${lat},${lon});
  node["tourism"="caravan_site"](around:${radiusMeters},${lat},${lon});
  way["highway"="rest_area"](around:${radiusMeters},${lat},${lon});
  way["tourism"="caravan_site"](around:${radiusMeters},${lat},${lon});
);
out center body;`;

    const resp = await overpassQuery(query);

    if (!resp.data?.elements) return [];

    return resp.data.elements
      .map(el => {
        const eLat = el.lat || el.center?.lat;
        const eLon = el.lon || el.center?.lon;
        if (!eLat || !eLon) return null;

        const dist = haversine(lat, lon, eLat, eLon);
        const tags = el.tags || {};
        const name = tags.name || tags.brand || 'Unknown';

        let type = 'Overnight Parking';
        let icon = 'fa-square-parking';
        let stealthRating = 2;

        if (tags.brand?.includes('Walmart') || tags.name?.includes('Walmart')) {
          type = 'Walmart Parking';
          icon = 'fa-cart-shopping';
          stealthRating = 2;
        } else if (tags.amenity === 'casino' || tags.name?.toLowerCase().includes('casino')) {
          type = 'Casino Parking';
          icon = 'fa-dice';
          stealthRating = 2;
        } else if (tags.amenity === 'rest_area' || tags.highway === 'rest_area') {
          type = 'Rest Area';
          icon = 'fa-bed';
          stealthRating = 3;
        } else if (tags.tourism === 'caravan_site') {
          type = 'RV/Caravan Site';
          icon = 'fa-caravan';
          stealthRating = 3;
        }

        return {
          id: `parking-${el.type}-${el.id}`,
          name,
          description: [
            type,
            tags.opening_hours ? `Hours: ${tags.opening_hours}` : '',
            tags.fee === 'no' ? 'Free' : '',
            tags.access === 'yes' || tags.access === 'public' ? 'Public access' : '',
          ].filter(Boolean).join(' | '),
          lat: eLat,
          lon: eLon,
          distanceMiles: Math.round(dist * 10) / 10,
          type,
          source: 'WebScraper',
          sourceIcon: icon,
          reservable: false,
          url: `https://www.openstreetmap.org/${el.type}/${el.id}`,
          fee: tags.fee === 'no' ? 'Free' : 'Check local',
          stealthRating,
          tags: ['parking', 'overnight', type.toLowerCase().replace(/\s+/g, '-')],
          amenities: [
            tags.toilets === 'yes' ? 'Restrooms' : '',
            tags.drinking_water === 'yes' ? 'Water' : '',
            tags.internet_access === 'yes' || tags.internet_access === 'wlan' ? 'WiFi' : '',
          ].filter(Boolean),
        };
      })
      .filter(Boolean);
  } catch (err) {
    console.warn('[Scraper] Overnight parking error:', err.message);
    return [];
  }
}

/**
 * Combined scraper search
 */
async function search(lat, lon, radiusMiles) {
  const [campendium, usgs, parking] = await Promise.allSettled([
    scrapeCampendium(lat, lon, radiusMiles),
    scrapeUSGSFeatures(lat, lon, radiusMiles),
    scrapeOvernightParking(lat, lon, radiusMiles),
  ]);

  const results = [];
  if (campendium.status === 'fulfilled') results.push(...campendium.value);
  if (usgs.status === 'fulfilled') results.push(...usgs.value);
  if (parking.status === 'fulfilled') results.push(...parking.value);

  console.log(`[WebScraper] Found ${results.length} results (${campendium.value?.length || 0} Campendium, ${usgs.value?.length || 0} USGS, ${parking.value?.length || 0} parking)`);
  return results;
}

module.exports = { search, scrapeCampendium, scrapeUSGSFeatures, scrapeOvernightParking };
