/**
 * iOverlander Scraper Module
 * Scrapes camping/overlanding spots from iOverlander.com for Washington State.
 * iOverlander has a web interface with location data we can extract.
 */
const axios = require('axios');
const cheerio = require('cheerio');
const { haversine } = require('./utils');

const UA = 'OpenVibeApp/2.0';

// Category mapping
const CATEGORIES = {
  'Wild Camping': { type: 'Dispersed Camping', stealth: 4, icon: 'fa-tree' },
  'Informal Campsite': { type: 'Informal Camp', stealth: 4, icon: 'fa-campground' },
  'Established Campground': { type: 'Campground', stealth: 2, icon: 'fa-campground' },
  'Overnight Parking': { type: 'Overnight Parking', stealth: 3, icon: 'fa-parking' },
  'Rest Area': { type: 'Rest Area', stealth: 2, icon: 'fa-bed' },
  'Gas Station': { type: 'Services', stealth: 1, icon: 'fa-gas-pump' },
  'Water': { type: 'Water Source', stealth: 0, icon: 'fa-faucet-drip' },
  'Dump Station': { type: 'Services', stealth: 0, icon: 'fa-dumpster' },
  'Propane': { type: 'Services', stealth: 0, icon: 'fa-fire-flame-simple' },
  'Mechanic': { type: 'Services', stealth: 0, icon: 'fa-wrench' },
  'Wifi': { type: 'Services', stealth: 0, icon: 'fa-wifi' },
  'Laundry': { type: 'Services', stealth: 0, icon: 'fa-shirt' },
  'Hostel': { type: 'Shelter', stealth: 1, icon: 'fa-bed' },
  'Hotel': { type: 'Shelter', stealth: 1, icon: 'fa-hotel' },
};

/**
 * Search iOverlander for locations near a coordinate within WA.
 */
async function search(lat, lon, radiusMiles = 25) {
  const results = [];

  try {
    // iOverlander uses a bounding box search. Compute bbox from center + radius
    const latDelta = radiusMiles / 69.0;
    const lonDelta = radiusMiles / (69.0 * Math.cos(lat * Math.PI / 180));

    const south = lat - latDelta;
    const north = lat + latDelta;
    const west = lon - lonDelta;
    const east = lon + lonDelta;

    // Try iOverlander's search page
    const url = `https://www.ioverlander.com/places?lat=${lat}&lng=${lon}&zoom=10`;
    const resp = await axios.get(url, {
      headers: { 'User-Agent': UA },
      timeout: 12000,
    });

    const $ = cheerio.load(resp.data);

    // Parse place listings
    $('a[href*="/places/"]').each((_, el) => {
      try {
        const href = $(el).attr('href');
        const name = $(el).text().trim();
        if (!name || name.length < 3) return;

        // Try to extract coordinates from nearby elements or page data  
        const parent = $(el).closest('.place-card, .place-listing, div');
        const text = parent.text();

        // Look for coordinate patterns
        const coordMatch = text.match(/(-?\d{1,3}\.\d{4,})\s*[,/]\s*(-?\d{1,3}\.\d{4,})/);
        if (coordMatch) {
          const placeLat = parseFloat(coordMatch[1]);
          const placeLon = parseFloat(coordMatch[2]);

          {
            const dist = haversine(lat, lon, placeLat, placeLon);
            if (dist <= radiusMiles) {
              results.push({
                id: `ioverlander-${href?.split('/').pop() || name.replace(/\W+/g, '-')}`,
                name,
                lat: placeLat,
                lon: placeLon,
                distanceMiles: Math.round(dist * 10) / 10,
                type: 'iOverlander Spot',
                source: 'iOverlander',
                sourceIcon: 'fa-globe',
                url: href ? `https://www.ioverlander.com${href}` : null,
                stealthRating: 3,
                tags: ['community', 'overlander'],
                fee: 'Unknown',
              });
            }
          }
        }
      } catch (e) { /* skip bad entries */ }
    });

    // Also try to extract JSON data from scripts
    $('script').each((_, el) => {
      const scriptText = $(el).html() || '';
      if (scriptText.includes('places') || scriptText.includes('markers')) {
        try {
          // Look for JSON arrays of place data
          const jsonMatches = scriptText.match(/\[[\s\S]*?"lat"[\s\S]*?\]/g);
          if (jsonMatches) {
            for (const jsonStr of jsonMatches) {
              try {
                const places = JSON.parse(jsonStr);
                if (Array.isArray(places)) {
                  for (const place of places) {
                    if (place.lat && place.lng && place.name) {
                      const pLat = parseFloat(place.lat);
                      const pLon = parseFloat(place.lng);
                      if (pLat >= south && pLat <= north && pLon >= west && pLon <= east) {
                        const dist = haversine(lat, lon, pLat, pLon);
                        results.push({
                          id: `ioverlander-${place.id || place.name.replace(/\W+/g, '-')}`,
                          name: place.name,
                          description: place.description || '',
                          lat: pLat,
                          lon: pLon,
                          distanceMiles: Math.round(dist * 10) / 10,
                          type: classifyType(place.category || place.type),
                          source: 'iOverlander',
                          sourceIcon: 'fa-globe',
                          url: place.url || null,
                          stealthRating: classifyStealth(place.category || place.type),
                          tags: extractTags(place),
                          fee: 'Unknown',
                        });
                      }
                    }
                  }
                }
              } catch (e) { /* ignore parse errors */ }
            }
          }
        } catch (e) { /* ignore */ }
      }
    });

  } catch (err) {
    console.warn('[iOverlander]', err.message);
  }

  return results;
}

function classifyType(category) {
  if (!category) return 'iOverlander Spot';
  const cat = CATEGORIES[category];
  return cat ? cat.type : 'iOverlander Spot';
}

function classifyStealth(category) {
  if (!category) return 3;
  const cat = CATEGORIES[category];
  return cat ? cat.stealth : 3;
}

function extractTags(place) {
  const tags = ['community', 'overlander'];
  if (place.category) tags.push(place.category.toLowerCase());
  if (place.amenities) {
    if (typeof place.amenities === 'string') tags.push(...place.amenities.split(',').map(a => a.trim()));
    if (Array.isArray(place.amenities)) tags.push(...place.amenities);
  }
  return tags.slice(0, 8);
}

module.exports = { search };
