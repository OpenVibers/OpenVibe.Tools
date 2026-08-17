/**
 * ╔═══════════════════════════════════════════════════════════════════╗
 * ║              OpenVibeApp – Public Bathrooms Module                 ║
 * ║     Find public restrooms, showers & water near camp spots       ║
 * ╚═══════════════════════════════════════════════════════════════════╝
 *
 * Data Sources:
 *   1. Refuge Restrooms API  — Community-sourced inclusive restrooms
 *      https://www.refugerestrooms.org/api/v1/restrooms/by_location
 *   2. OpenStreetMap Overpass — amenity=toilets + amenity=shower + amenity=drinking_water
 *
 * Combined → deduplicated, enriched with distance/walking time, scored for stealth-camper utility.
 */
const axios = require('axios');
const { haversine, OVERPASS_URL, overpassQuery } = require('./utils');

// ─── Constants ─────────────────────────────────────────────────────
const REFUGE_API = 'https://www.refugerestrooms.org/api/v1/restrooms/by_location';

const BATHROOM_TYPES = {
  public: { icon: 'fa-restroom', label: 'Public Restroom', color: '#3b82f6' },
  park: { icon: 'fa-tree', label: 'Park Restroom', color: '#22c55e' },
  library: { icon: 'fa-book', label: 'Library', color: '#8b5cf6' },
  gas_station: { icon: 'fa-gas-pump', label: 'Gas Station', color: '#f59e0b' },
  restaurant: { icon: 'fa-utensils', label: 'Restaurant/Café', color: '#ef4444' },
  mall: { icon: 'fa-store', label: 'Store/Mall', color: '#ec4899' },
  transit: { icon: 'fa-bus', label: 'Transit Station', color: '#06b6d4' },
  community: { icon: 'fa-building', label: 'Community Building', color: '#6366f1' },
  shower: { icon: 'fa-shower', label: 'Shower Facility', color: '#14b8a6' },
  gym_shower: { icon: 'fa-dumbbell', label: 'Gym Shower', color: '#8b5cf6' },
  pool_shower: { icon: 'fa-person-swimming', label: 'Pool/Sports Shower', color: '#0ea5e9' },
  hot_spring: { icon: 'fa-hot-tub-person', label: 'Hot Spring', color: '#f97316' },
  water: { icon: 'fa-faucet-drip', label: 'Drinking Water', color: '#0ea5e9' },
  unknown: { icon: 'fa-toilet', label: 'Restroom', color: '#94a3b8' },
};

// ─── Classify bathroom type from tags/name ─────────────────────────
function classifyBathroom(name, tags = {}) {
  const n = (name || '').toLowerCase();
  const access = (tags.access || '').toLowerCase();

  if (tags.amenity === 'shower') return 'shower';
  if (tags.amenity === 'drinking_water') return 'water';
  if (n.includes('park') || n.includes('trail') || n.includes('campground') || tags.leisure) return 'park';
  if (n.includes('library')) return 'library';
  if (n.includes('gas') || n.includes('shell') || n.includes('chevron') || n.includes('arco') || n.includes('76')) return 'gas_station';
  if (n.includes('starbucks') || n.includes('mcdonald') || n.includes('coffee') || n.includes('café') || n.includes('cafe') || n.includes('restaurant')) return 'restaurant';
  if (n.includes('mall') || n.includes('target') || n.includes('walmart') || n.includes('safeway') || n.includes('fred meyer')) return 'mall';
  if (n.includes('station') || n.includes('transit') || n.includes('bus') || n.includes('light rail') || tags.public_transport) return 'transit';
  if (n.includes('community') || n.includes('city hall') || n.includes('courthouse') || n.includes('center')) return 'community';
  if (access === 'yes' || access === 'public' || tags.fee === 'no') return 'public';
  return 'unknown';
}

// ─── Score for stealth campers (higher = more useful) ──────────────
function calculateUtilityScore(bathroom) {
  let score = 50; // base

  // 24/7 access is gold
  if (bathroom.hours === '24/7') score += 30;
  else if (bathroom.hours && bathroom.hours.toLowerCase().includes('24')) score += 25;

  // Free is essential
  if (bathroom.fee === false || bathroom.fee === 'no') score += 15;
  else if (bathroom.fee === true || bathroom.fee === 'yes') score -= 15;

  // Accessible
  if (bathroom.accessible) score += 10;

  // Has shower (jackpot for campers)
  if (bathroom.hasShower) score += 25;

  // Hot water available
  if (bathroom.hotWater === 'yes') score += 10;
  else if (bathroom.hotWater === 'no') score -= 5;

  // Gym/pool — reliable but need membership/day pass
  if (bathroom.type === 'gym_shower') score += 15;
  if (bathroom.type === 'pool_shower') score += 15;

  // Hot springs — free outdoor bathing gold
  if (bathroom.type === 'hot_spring') score += 30;

  // Has drinking water
  if (bathroom.hasDrinkingWater) score += 15;

  // Community upvotes (Refuge)
  if (bathroom.upvote && bathroom.upvote > 0) score += Math.min(bathroom.upvote * 3, 15);
  if (bathroom.downvote && bathroom.downvote > 0) score -= Math.min(bathroom.downvote * 3, 15);

  // Public locations score higher
  if (['public', 'park', 'library', 'transit'].includes(bathroom.type)) score += 10;

  // Changing table is nice but not critical
  if (bathroom.changingTable) score += 5;

  return Math.max(0, Math.min(100, score));
}

// ═══════════════════════════════════════════════════════════════════
// SOURCE 1: Refuge Restrooms API
// ═══════════════════════════════════════════════════════════════════
async function fetchRefugeRestrooms(lat, lon, perPage = 30) {
  const maxAttempts = 2;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const timeout = attempt === 0 ? 15000 : 25000;
      const resp = await axios.get(REFUGE_API, {
        params: { lat, lng: lon, per_page: perPage },
        timeout,
        headers: { 'Accept': 'application/json' },
      });

      if (!Array.isArray(resp.data)) return [];

      return resp.data.map(r => ({
        id: `refuge-${r.id}`,
        source: 'refuge',
        name: (r.name || 'Restroom').trim(),
        lat: parseFloat(r.latitude),
        lon: parseFloat(r.longitude),
        street: r.street || '',
        city: r.city || '',
        state: r.state || '',
        address: [r.street, r.city, r.state].filter(Boolean).join(', '),
        accessible: !!r.accessible,
        unisex: !!r.unisex,
        changingTable: !!r.changing_table,
        directions: r.directions || '',
        comment: r.comment || '',
        upvote: r.upvote || 0,
        downvote: r.downvote || 0,
        fee: null, // Refuge doesn't track fees
        hours: null,
        hasShower: false,
        hasDrinkingWater: false,
        type: classifyBathroom(r.name, {}),
        distanceMiles: r.distance || haversine(lat, lon, parseFloat(r.latitude), parseFloat(r.longitude)),
      }));
    } catch (err) {
      if (attempt < maxAttempts - 1 && (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT')) {
        console.warn(`Refuge Restrooms timeout (attempt ${attempt + 1}), retrying...`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      console.warn('Refuge Restrooms API error:', err.message);
      return [];
    }
  }
  return [];
}

// ═══════════════════════════════════════════════════════════════════
// SOURCE 2: OpenStreetMap Overpass API
// ═══════════════════════════════════════════════════════════════════
function buildOverpassQuery(lat, lon, radiusMeters) {
  return `
[out:json][timeout:30];
(
  // ── Public toilets ──
  node["amenity"="toilets"](around:${radiusMeters},${lat},${lon});
  way["amenity"="toilets"](around:${radiusMeters},${lat},${lon});

  // ── Dedicated shower facilities ──
  node["amenity"="shower"](around:${radiusMeters},${lat},${lon});
  way["amenity"="shower"](around:${radiusMeters},${lat},${lon});

  // ── Public baths (often have showers: hammams, thermal baths, sento, pools) ──
  node["amenity"="public_bath"](around:${radiusMeters},${lat},${lon});
  way["amenity"="public_bath"](around:${radiusMeters},${lat},${lon});

  // ── Fitness centres / gyms (most have showers for members/day pass) ──
  node["leisure"="fitness_centre"](around:${radiusMeters},${lat},${lon});
  way["leisure"="fitness_centre"](around:${radiusMeters},${lat},${lon});

  // ── Swimming pools / sports centres with swimming (have showers) ──
  node["leisure"="sports_centre"]["sport"="swimming"](around:${radiusMeters},${lat},${lon});
  way["leisure"="sports_centre"]["sport"="swimming"](around:${radiusMeters},${lat},${lon});

  // ── Camp sites WITH showers confirmed ──
  node["tourism"="camp_site"]["shower"~"yes|hot|cold"](around:${radiusMeters},${lat},${lon});
  way["tourism"="camp_site"]["shower"~"yes|hot|cold"](around:${radiusMeters},${lat},${lon});

  // ── Bathing places with showers (beach/lake showers) ──
  node["leisure"="bathing_place"]["shower"="yes"](around:${radiusMeters},${lat},${lon});
  way["leisure"="bathing_place"]["shower"="yes"](around:${radiusMeters},${lat},${lon});

  // ── Natural hot springs (free outdoor bathing) ──
  node["natural"="hot_spring"](around:${radiusMeters},${lat},${lon});

  // ── Drinking water taps/fountains ──
  node["amenity"="drinking_water"](around:${radiusMeters},${lat},${lon});
  node["man_made"="drinking_fountain"](around:${radiusMeters},${lat},${lon});

  // ── Water points (large fill-up for RV/van tanks) ──
  node["amenity"="water_point"](around:${radiusMeters},${lat},${lon});
  way["amenity"="water_point"](around:${radiusMeters},${lat},${lon});

  // ── Sanitary dump stations (often co-located with water) ──
  node["amenity"="sanitary_dump_station"](around:${radiusMeters},${lat},${lon});
  way["amenity"="sanitary_dump_station"](around:${radiusMeters},${lat},${lon});
);
out center body;`;
}

async function fetchOverpassBathrooms(lat, lon, radiusMeters = 8000) {
  try {
    const query = buildOverpassQuery(lat, lon, radiusMeters);
    const resp = await overpassQuery(query, 35000);

    if (!resp.data || !resp.data.elements) return [];

    return resp.data.elements.map(el => {
      const tags = el.tags || {};
      const elLat = el.lat || (el.center && el.center.lat) || 0;
      const elLon = el.lon || (el.center && el.center.lon) || 0;
      if (!elLat || !elLon) return null;

      const isShower = tags.amenity === 'shower';
      const isWater = tags.amenity === 'drinking_water' || tags.man_made === 'drinking_fountain';
      const isToilet = tags.amenity === 'toilets';
      const isWaterPoint = tags.amenity === 'water_point';
      const isDumpStation = tags.amenity === 'sanitary_dump_station';
      const isPublicBath = tags.amenity === 'public_bath';
      const isFitness = tags.leisure === 'fitness_centre';
      const isSportsSwim = tags.leisure === 'sports_centre' && tags.sport === 'swimming';
      const isCampShower = tags.tourism === 'camp_site' && /yes|hot|cold/i.test(tags.shower || '');
      const isBathingPlace = tags.leisure === 'bathing_place';
      const isHotSpring = tags.natural === 'hot_spring';

      // All of these provide shower/bathing access
      const hasShowerAccess = isShower || isPublicBath || isFitness || isSportsSwim ||
                               isCampShower || isBathingPlace || isHotSpring ||
                               tags.shower === 'yes' || tags.shower === 'hot' || tags.shower === 'cold';

      let name = tags.name || '';
      if (!name) {
        if (isShower) name = 'Public Shower';
        else if (isPublicBath) name = tags['bath:type'] ? `Public Bath (${tags['bath:type']})` : 'Public Bath';
        else if (isFitness) name = 'Gym / Fitness Centre';
        else if (isSportsSwim) name = 'Swimming / Sports Centre';
        else if (isCampShower) name = 'Campground Shower';
        else if (isBathingPlace) name = 'Bathing Place (Shower)';
        else if (isHotSpring) name = 'Hot Spring';
        else if (isWaterPoint) name = 'Water Point (Tank Fill)';
        else if (isWater) name = 'Drinking Water';
        else if (isDumpStation) name = 'Dump Station';
        else name = tags.description || 'Public Restroom';
      }

      // Parse hours
      let hours = tags.opening_hours || null;
      if (hours === '24/7') hours = '24/7';

      // Parse fee
      let fee = null;
      if (tags.fee === 'yes') fee = true;
      else if (tags.fee === 'no') fee = false;

      // Wheelchair
      let accessible = false;
      if (tags.wheelchair === 'yes' || tags.wheelchair === 'designated') accessible = true;

      // Rich shower detail tags
      const hotWater = tags.hot_water || null; // yes/fee/no
      const showerCapacity = tags.capacity || null;
      const bathType = tags['bath:type'] || null; // hot_spring, onsen, sento, hammam, thermal
      const temperature = tags.temperature || null;

      // Rich toilet detail tags
      const paperSupplied = tags['toilets:paper_supplied'] || null;
      const handwashing = tags['toilets:handwashing'] || null;
      const position = tags['toilets:position'] || null;
      const disposal = tags['toilets:disposal'] || null;
      const hasSoap = tags.soap === 'yes';
      const hasDryer = tags.hand_drying === 'yes' || tags.hand_dryer === 'yes';
      const hasMirror = tags.mirror === 'yes';
      const supervised = tags.supervised === 'yes';
      const indoor = tags.indoor === 'yes' || tags.location === 'indoor';
      const hasToiletNearby = tags.toilets === 'yes';

      return {
        id: `osm-${el.id}`,
        source: 'osm',
        name: name.trim(),
        lat: elLat,
        lon: elLon,
        street: tags['addr:street'] || '',
        city: tags['addr:city'] || '',
        state: tags['addr:state'] || 'WA',
        address: [tags['addr:street'], tags['addr:city'], tags['addr:state']].filter(Boolean).join(', '),
        accessible,
        unisex: tags.unisex === 'yes' || tags.gender_segregated === 'no',
        changingTable: tags.changing_table === 'yes',
        directions: tags.description || '',
        comment: [
          tags.note || '',
          // Shower details
          hasShowerAccess ? '🚿 Shower available' : '',
          hotWater === 'yes' ? '♨️ Hot water' : hotWater === 'fee' ? '♨️ Hot water (fee)' : hotWater === 'no' ? '❄️ Cold water only' : '',
          showerCapacity ? `Capacity: ${showerCapacity}` : '',
          bathType ? `Bath type: ${bathType}` : '',
          temperature ? `Water temp: ${temperature}°C` : '',
          isPublicBath && tags.shower === 'yes' ? 'Showers on-site' : '',
          isFitness ? '💪 Gym — day pass usually required' : '',
          isSportsSwim ? '🏊 Swimming centre — day pass usually required' : '',
          isCampShower ? '⛺ Campground shower' : '',
          isHotSpring ? '♨️ Natural hot spring — free outdoor bathing' : '',
          isBathingPlace ? '🏖️ Outdoor bathing/beach shower' : '',
          // Toilet details
          paperSupplied === 'yes' ? '🧻 TP provided' : paperSupplied === 'no' ? '⚠️ No TP' : '',
          handwashing === 'yes' ? '🧼 Handwashing' : handwashing === 'no' ? '⚠️ No handwashing' : '',
          hasSoap ? 'Soap available' : '',
          hasDryer ? 'Hand dryer' : '',
          supervised ? 'Supervised/attended' : '',
          indoor ? 'Indoor' : '',
          disposal ? `Type: ${disposal}` : '',
          isDumpStation ? '🚐 RV/Van dump station' : '',
          isWaterPoint ? '💧 Large tank water fill-up' : '',
          hasToiletNearby && !isToilet ? '🚻 Toilets available' : '',
          tags.male === 'yes' && tags.female !== 'yes' ? '♂️ Male only' : '',
          tags.female === 'yes' && tags.male !== 'yes' ? '♀️ Female only' : '',
        ].filter(Boolean).join(' | '),
        upvote: 0,
        downvote: 0,
        fee,
        hours,
        hasShower: hasShowerAccess,
        hasDrinkingWater: isWater || isWaterPoint || tags.drinking_water === 'yes',
        type: isShower ? 'shower' :
              isPublicBath ? 'shower' :
              isFitness ? 'gym_shower' :
              isSportsSwim ? 'pool_shower' :
              isCampShower ? 'shower' :
              isBathingPlace ? 'shower' :
              isHotSpring ? 'hot_spring' :
              (isWater || isWaterPoint) ? 'water' :
              isDumpStation ? 'public' :
              classifyBathroom(name, tags),
        operator: tags.operator || '',
        access: tags.access || (isFitness || isSportsSwim ? 'customers' : 'yes'),
        paperSupplied,
        handwashing,
        hotWater,
        bathType,
        distanceMiles: haversine(lat, lon, elLat, elLon),
      };
    }).filter(Boolean);
  } catch (err) {
    console.warn('Overpass bathroom query error:', err.message);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════
// COMBINED SEARCH — Deduplicated & Scored
// ═══════════════════════════════════════════════════════════════════
async function findBathrooms(lat, lon, radiusMeters = 8000) {
  // Fetch both sources in parallel
  const [refugeResults, osmResults] = await Promise.all([
    fetchRefugeRestrooms(lat, lon, 30),
    fetchOverpassBathrooms(lat, lon, radiusMeters),
  ]);

  // Combine
  const all = [...osmResults, ...refugeResults];

  // Deduplicate — match if within ~50m and names similar
  const deduped = [];
  for (const b of all) {
    const dup = deduped.find(existing => {
      const dist = haversine(existing.lat, existing.lon, b.lat, b.lon);
      if (dist > 0.03) return false; // > ~50 meters apart
      // Same location roughly — check name overlap
      const n1 = existing.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      const n2 = b.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (n1 === n2) return true;
      if (n1.includes(n2) || n2.includes(n1)) return true;
      // If both are unnamed "Public Restroom" at same location
      if (dist < 0.01) return true;
      return false;
    });

    if (dup) {
      // Merge data — prefer OSM structured data + Refuge community data
      if (b.source === 'refuge' && dup.source === 'osm') {
        dup.comment = dup.comment || b.comment;
        dup.directions = dup.directions || b.directions;
        dup.upvote = Math.max(dup.upvote, b.upvote);
        dup.downvote = Math.max(dup.downvote, b.downvote);
        if (!dup.unisex && b.unisex) dup.unisex = true;
        if (!dup.accessible && b.accessible) dup.accessible = true;
        if (!dup.changingTable && b.changingTable) dup.changingTable = true;
      } else if (b.source === 'osm' && dup.source === 'refuge') {
        dup.hours = dup.hours || b.hours;
        dup.fee = dup.fee ?? b.fee;
        dup.hasShower = dup.hasShower || b.hasShower;
        dup.hasDrinkingWater = dup.hasDrinkingWater || b.hasDrinkingWater;
        dup.operator = dup.operator || b.operator;
        dup.access = b.access || dup.access;
      }
    } else {
      deduped.push(b);
    }
  }

  // Calculate utility score & walking time
  const results = deduped.map(b => {
    b.utilityScore = calculateUtilityScore(b);
    b.walkingMinutes = Math.round(b.distanceMiles * 20); // ~3 mph walking speed
    return b;
  });

  // Sort by distance
  results.sort((a, b) => a.distanceMiles - b.distanceMiles);

  // Summary counts
  const showerTypes = ['shower', 'gym_shower', 'pool_shower', 'hot_spring'];
  const summary = {
    total: results.length,
    toilets: results.filter(b => !showerTypes.includes(b.type) && b.type !== 'water').length,
    showers: results.filter(b => showerTypes.includes(b.type) || b.hasShower).length,
    gyms: results.filter(b => b.type === 'gym_shower').length,
    pools: results.filter(b => b.type === 'pool_shower').length,
    hotSprings: results.filter(b => b.type === 'hot_spring').length,
    water: results.filter(b => b.type === 'water' || b.hasDrinkingWater).length,
    accessible: results.filter(b => b.accessible).length,
    free: results.filter(b => b.fee === false || b.fee === null).length,
    open24h: results.filter(b => b.hours === '24/7').length,
    sources: {
      refuge: refugeResults.length,
      osm: osmResults.length,
    },
  };

  return { bathrooms: results, summary };
}

// ═══════════════════════════════════════════════════════════════════
// CURATED WA BATHROOM LOCATIONS (known reliable spots)
// ═══════════════════════════════════════════════════════════════════
const CURATED_BATHROOMS = [
  // Seattle area
  { name: 'Seattle Public Library – Central', lat: 47.6066, lon: -122.3330, type: 'library', hours: 'Mon-Sat 10am-8pm, Sun 12-6pm', accessible: true, hasDrinkingWater: true, notes: 'Free public restrooms on 1st floor under escalators. Warm place to sit.' },
  { name: 'Pike Place Market Public Restroom', lat: 47.6094, lon: -122.3422, type: 'public', hours: '6am-6pm daily', accessible: true, fee: false, notes: 'Public restroom near market entrance. Can be busy.' },
  { name: 'Victor Steinbrueck Park', lat: 47.6105, lon: -122.3427, type: 'park', hours: '24/7', accessible: true, fee: false, notes: 'Portland Loo style public restroom. Open 24/7.' },
  { name: 'Seattle Center – Armory', lat: 47.6215, lon: -122.3510, type: 'public', hours: '11am-9pm daily', accessible: true, fee: false, hasDrinkingWater: true, notes: 'Free restrooms in Armory food court. Water fountains.' },
  { name: 'REI Flagship – Seattle', lat: 47.6167, lon: -122.3322, type: 'mall', hours: '10am-9pm daily', accessible: true, fee: false, notes: 'Clean restrooms. No purchase required typically.' },
  { name: 'King Street Station', lat: 47.5987, lon: -122.3302, type: 'transit', hours: '6am-11pm daily', accessible: true, fee: false, hasDrinkingWater: true, notes: 'Amtrak/transit station. Public restrooms in waiting area.' },

  // Everett area
  { name: 'Everett Public Library', lat: 47.9790, lon: -122.2023, type: 'library', hours: 'Mon-Thu 10am-8pm, Fri-Sat 10am-6pm', accessible: true, hasDrinkingWater: true, notes: 'Clean public restrooms. Charging outlets.' },
  { name: 'Forest Park – Everett', lat: 47.9370, lon: -122.2245, type: 'park', hours: 'Dawn to dusk', accessible: false, fee: false, notes: 'Pit toilets near trailhead parking.' },
  { name: 'Evergreen Arboretum', lat: 47.9382, lon: -122.2211, type: 'park', hours: 'Dawn to dusk', accessible: false, notes: 'Portable restroom near parking.' },

  // Arlington / Marysville
  { name: 'Arlington Library', lat: 48.1987, lon: -122.1250, type: 'library', hours: 'Mon-Sat 10am-8pm', accessible: true, hasDrinkingWater: true, notes: 'Public restrooms inside. Free WiFi, charging, warm place to sit.' },
  { name: 'Haller Park – Arlington', lat: 48.1946, lon: -122.1230, type: 'park', hours: 'Dawn to dusk', accessible: true, fee: false, notes: 'Restrooms near the playground.' },
  { name: 'River Meadows County Park', lat: 48.1799, lon: -122.0819, type: 'park', hours: 'Dawn to dusk', accessible: true, fee: false, hasDrinkingWater: true, notes: 'Restrooms near picnic shelters. Water available seasonally. 20416 Jordan Rd.' },
  { name: 'Twin Rivers Park', lat: 48.2033, lon: -122.1214, type: 'park', hours: 'Dawn to dusk', accessible: true, fee: false, notes: 'Restrooms at park entrance near boat launch. 8003 WA-530.' },
  { name: 'Centennial Park – Arlington', lat: 48.2003, lon: -122.1185, type: 'park', hours: 'Dawn to dusk', accessible: true, fee: false, notes: 'Restrooms at covered picnic shelter area.' },
  { name: 'Walmart Supercenter – Smokey Point', lat: 48.1507, lon: -122.1746, type: 'mall', hours: '6am-11pm daily', accessible: true, fee: false, hasDrinkingWater: true, notes: 'Customer restrooms inside. Water fountain near restrooms. 4010 172nd St NE. No purchase required technically.' },
  { name: 'Smokey Point Rest Area – I-5', lat: 48.1592, lon: -122.1936, type: 'public', hours: '24/7', accessible: true, fee: false, hasDrinkingWater: true, notes: 'I-5 rest area with 24/7 restrooms, vending machines, water. Short stay parking only.' },
  { name: 'Cascade Valley Hospital', lat: 48.1965, lon: -122.1190, type: 'public', hours: '24/7', accessible: true, fee: false, hasDrinkingWater: true, notes: 'Hospital lobby has public restrooms and water. 24/7 emergency entrance access. 330 S Stillaguamish Ave.' },
  { name: 'Pilot Travel Center – Arlington', lat: 48.1872, lon: -122.1966, type: 'gas_station', hours: '24/7', accessible: true, fee: false, hasDrinkingWater: true, notes: 'Truck stop restrooms open 24/7. Showers available ~$15. Hot water, soap, towels provided. 2430 WA-530 near I-5.' },
  { name: 'Safeway – Smokey Point', lat: 48.1514, lon: -122.1812, type: 'mall', hours: '5am - midnight', accessible: true, fee: false, hasDrinkingWater: false, notes: 'Customer restrooms inside store. 3532 172nd St NE. Clean facilities.' },
  { name: 'Grocery Outlet – Arlington', lat: 48.2008, lon: -122.1259, type: 'mall', hours: '8am - 9pm', accessible: true, fee: false, hasDrinkingWater: false, notes: 'Customer restrooms inside store. 131 E Division St. Downtown Arlington.' },
  { name: 'Stillaguamish Athletic Club', lat: 48.1527, lon: -122.1673, type: 'gym', hours: 'Mon-Fri 5am-9pm, Sat-Sun 7am-5pm', accessible: true, fee: true, hasDrinkingWater: true, notes: 'Day pass $10-15 gives access to restrooms, showers, locker rooms, and pool. 4417 172nd St NE.' },
  { name: 'Smokey Point Library', lat: 48.1548, lon: -122.1840, type: 'library', hours: 'Mon-Sat 10am-6pm', accessible: true, fee: false, hasDrinkingWater: true, notes: 'Sno-Isle Library branch. Public restrooms and water fountain. Free WiFi. Near transit.' },
  { name: 'Legion Park – Arlington', lat: 48.1975, lon: -122.1260, type: 'park', hours: 'Dawn to dusk', accessible: false, fee: false, hasDrinkingWater: false, notes: 'Downtown park. Portable restrooms available seasonally. Farmers market Saturdays Jun-Sep.' },
  { name: 'Bill Quake Memorial Park', lat: 48.1625, lon: -122.1500, type: 'park', hours: 'Dawn to dusk', accessible: true, fee: false, hasDrinkingWater: true, notes: 'Restrooms at the sports field complex. Drinking fountain near playground. E Highland Dr.' },
  { name: 'Jennings Park – Marysville', lat: 48.0560, lon: -122.1750, type: 'park', hours: 'Dawn to dusk', accessible: true, fee: false, notes: 'Public restrooms at park entrance.' },
  // Granite Falls / Darrington backcountry
  { name: 'Verlot Public Service Center', lat: 48.0882, lon: -121.7766, type: 'public', hours: 'Seasonal: 8am-4:30pm summer', accessible: true, hasDrinkingWater: true, notes: 'USFS ranger station. Flush toilets and water when open, vault toilets year-round.' },
  { name: 'Big Four Ice Caves Trailhead', lat: 48.0651, lon: -121.5131, type: 'park', hours: '24/7', accessible: true, fee: false, notes: 'Vault toilets at trailhead parking (NW Forest Pass for parking).' },
  { name: 'Gold Basin Campground (Day Use)', lat: 48.0815, lon: -121.7887, type: 'park', hours: 'Seasonal', accessible: true, hasDrinkingWater: true, notes: 'Flush toilets when campground is open. Vault toilets off-season.' },
  { name: 'Darrington Ranger Station', lat: 48.2538, lon: -121.6019, type: 'public', hours: 'Mon-Fri 8am-4:30pm', accessible: true, hasDrinkingWater: true, notes: 'USFS office with public restrooms during business hours.' },

  // Snohomish
  { name: 'Snohomish Carnegie Library', lat: 47.9127, lon: -122.0982, type: 'library', hours: 'Mon-Sat 10am-6pm', accessible: true, hasDrinkingWater: true },
  { name: 'Ferguson Park – Snohomish', lat: 47.9133, lon: -122.0939, type: 'park', hours: 'Dawn to dusk', accessible: true, fee: false },

  // Tacoma / Olympia
  { name: 'Tacoma Public Library – Main', lat: 47.2529, lon: -122.4443, type: 'library', hours: 'Mon-Thu 10am-8pm, Fri-Sat 10am-6pm', accessible: true, hasDrinkingWater: true },
  { name: 'Point Defiance Park', lat: 47.3100, lon: -122.5250, type: 'park', hours: 'Dawn to dusk', accessible: true, fee: false, notes: 'Multiple restroom buildings throughout the park.' },
  { name: 'Olympia Capitol Campus', lat: 47.0379, lon: -122.9007, type: 'community', hours: 'Mon-Fri 7am-6pm', accessible: true, hasDrinkingWater: true, notes: 'Restrooms in Legislative Building. Free.' },

  // Bellingham
  { name: 'Bellingham Public Library', lat: 48.7505, lon: -122.4789, type: 'library', hours: 'Mon-Thu 10am-8pm, Fri-Sat 10am-6pm', accessible: true, hasDrinkingWater: true },
  { name: 'Boulevard Park – Bellingham', lat: 48.7356, lon: -122.4943, type: 'park', hours: 'Dawn to dusk', accessible: true, fee: false },

  // Known shower access points
  { name: 'YMCA of Greater Seattle (guest pass)', lat: 47.6157, lon: -122.3350, type: 'gym_shower', hours: '5am-10pm daily', fee: true, hasShower: true, notes: 'Day pass ~$15–$20 for shower access. Ask about community rates. Hot water.' },
  { name: 'Planet Fitness – Everett', lat: 47.9789, lon: -122.2020, type: 'gym_shower', hours: '24/7', fee: true, hasShower: true, notes: '$10/month membership includes shower access. Black Card gives access to all locations. Hot water.' },
  { name: 'Planet Fitness – Lynnwood', lat: 47.8323, lon: -122.3151, type: 'gym_shower', hours: '24/7', fee: true, hasShower: true, notes: '$10/month membership. 24/7 shower access. Cheapest gym shower option.' },
  { name: 'Planet Fitness – Federal Way', lat: 47.3222, lon: -122.3117, type: 'gym_shower', hours: '24/7', fee: true, hasShower: true, notes: '$10/month. 24/7 access with hot showers.' },
  { name: 'Planet Fitness – Tacoma', lat: 47.2506, lon: -122.4382, type: 'gym_shower', hours: '24/7', fee: true, hasShower: true, notes: '$10/month. 24/7 access. Shower + bathroom.' },
  { name: 'Millersylvania State Park', lat: 46.9065, lon: -122.9058, type: 'shower', hours: 'Seasonal', fee: false, hasShower: true, hasDrinkingWater: true, accessible: true, notes: 'Shower facility in campground area. May be available to day-use visitors.' },
  { name: 'Olympic Hot Springs (walk-in)', lat: 47.9667, lon: -123.6811, type: 'hot_spring', hours: '24/7', fee: false, hasShower: true, notes: '♨️ Free natural hot springs at end of Boulder Creek Trail (~2.5mi hike). Multiple pools. No facilities.' },
  { name: 'Goldmyer Hot Springs', lat: 47.5244, lon: -121.3436, type: 'hot_spring', hours: 'Reservation required', fee: true, hasShower: true, notes: '♨️ Natural hot springs. $20/visit. Reservation required via goldmyer.org. 4.7mi hike in.' },
  { name: 'Scenic Hot Springs', lat: 47.7133, lon: -121.1453, type: 'hot_spring', hours: 'Reservation req.', fee: true, hasShower: true, notes: '♨️ Private hot spring pools. ~$40/visit, reservation only via scenichotsprings.com. Short hike.' },
  { name: 'Sol Duc Hot Springs Resort', lat: 47.9669, lon: -123.8611, type: 'hot_spring', hours: '9am–8pm seasonal', fee: true, hasShower: true, notes: '♨️ Olympic NP resort. ~$15 day use. Hot mineral pools + showers. Hot water.' },
  { name: 'Carson Hot Springs Resort', lat: 45.7289, lon: -121.8153, type: 'hot_spring', hours: '9am–9pm daily', fee: true, hasShower: true, notes: '♨️ Hot mineral baths. ~$15. In Columbia River Gorge (WA/OR border).' },
  { name: 'Seattle Goodwill (free shower program)', lat: 47.6130, lon: -122.3210, type: 'shower', hours: 'Call ahead', fee: false, hasShower: true, notes: 'Free shower program for those in need. Limited hours — call first.' },
  { name: 'DESC – Emergency Service Center', lat: 47.6014, lon: -122.3267, type: 'shower', hours: 'Mon-Fri am', fee: false, hasShower: true, notes: 'Downtown Emergency Service Center. Free showers for homeless. ID may be required.' },
  { name: 'Colman Pool – Lincoln Park', lat: 47.5272, lon: -122.3972, type: 'pool_shower', hours: 'Seasonal Jun-Sep', fee: true, hasShower: true, notes: '$5-8 admission. Heated outdoor saltwater pool. Hot showers in locker rooms.' },
  { name: 'Tacoma Rescue Mission', lat: 47.2541, lon: -122.4387, type: 'shower', hours: 'Call ahead', fee: false, hasShower: true, notes: 'Free showers for those in need. May require participation in programs.' },
];

/**
 * Get curated bathrooms near a location
 */
function getCuratedBathrooms(lat, lon, radiusMiles = 15) {
  return CURATED_BATHROOMS
    .map(b => ({
      id: `curated-${b.name.replace(/\s+/g, '-').toLowerCase().slice(0, 30)}`,
      source: 'curated',
      name: b.name,
      lat: b.lat,
      lon: b.lon,
      street: '',
      city: '',
      state: 'WA',
      address: '',
      accessible: b.accessible || false,
      unisex: b.unisex || false,
      changingTable: b.changingTable || false,
      directions: '',
      comment: b.notes || '',
      upvote: 0,
      downvote: 0,
      fee: b.fee ?? false,
      hours: b.hours || null,
      hasShower: b.hasShower || false,
      hasDrinkingWater: b.hasDrinkingWater || false,
      type: b.type || 'unknown',
      operator: b.operator || '',
      access: b.access || 'yes',
      hotWater: b.hotWater || null,
      bathType: b.bathType || null,
      distanceMiles: haversine(lat, lon, b.lat, b.lon),
    }))
    .filter(b => b.distanceMiles <= radiusMiles);
}

// ═══════════════════════════════════════════════════════════════════
// MAIN EXPORT — All-in-one bathroom finder
// ═══════════════════════════════════════════════════════════════════

/**
 * Find all bathrooms near a location from all 3 sources.
 * @param {number} lat
 * @param {number} lon
 * @param {number} radiusMeters - Search radius for Overpass (default 8000 = ~5 miles)
 * @param {object} filters - { accessible, free, open24h, showers, water, types[] }
 */
async function findAllBathrooms(lat, lon, radiusMeters = 8000, filters = {}) {
  const radiusMiles = radiusMeters / 1609.344;

  // Fetch live + curated
  const [liveResult, curated] = await Promise.all([
    findBathrooms(lat, lon, radiusMeters),
    Promise.resolve(getCuratedBathrooms(lat, lon, radiusMiles)),
  ]);

  // Merge curated into live results (dedup by proximity)
  let allBathrooms = [...liveResult.bathrooms];
  for (const cb of curated) {
    const dupIdx = allBathrooms.findIndex(b =>
      haversine(b.lat, b.lon, cb.lat, cb.lon) < 0.05 &&
      b.name.toLowerCase().includes(cb.name.split('–')[0].trim().toLowerCase().split(' ')[0])
    );
    if (dupIdx >= 0) {
      // Merge curated info into live entry
      const existing = allBathrooms[dupIdx];
      if (!existing.hours && cb.hours) existing.hours = cb.hours;
      if (!existing.comment && cb.comment) existing.comment = cb.comment;
      if (cb.hasShower && !existing.hasShower) existing.hasShower = true;
      if (cb.hasDrinkingWater && !existing.hasDrinkingWater) existing.hasDrinkingWater = true;
    } else {
      // Score it
      cb.utilityScore = calculateUtilityScore(cb);
      cb.walkingMinutes = Math.round(cb.distanceMiles * 20);
      allBathrooms.push(cb);
    }
  }

  // Apply filters
  let filtered = allBathrooms;
  if (filters.accessible) filtered = filtered.filter(b => b.accessible);
  if (filters.free) filtered = filtered.filter(b => b.fee === false || b.fee === null);
  if (filters.open24h) filtered = filtered.filter(b => b.hours === '24/7');
  if (filters.showers) filtered = filtered.filter(b => b.hasShower || b.type === 'shower');
  if (filters.water) filtered = filtered.filter(b => b.hasDrinkingWater || b.type === 'water');
  if (filters.types && filters.types.length > 0) {
    filtered = filtered.filter(b => filters.types.includes(b.type));
  }

  // Re-sort by distance
  filtered.sort((a, b) => a.distanceMiles - b.distanceMiles);

  // Update summary
  const summary = {
    total: filtered.length,
    toilets: filtered.filter(b => b.type !== 'shower' && b.type !== 'water').length,
    showers: filtered.filter(b => b.type === 'shower' || b.hasShower).length,
    water: filtered.filter(b => b.type === 'water' || b.hasDrinkingWater).length,
    accessible: filtered.filter(b => b.accessible).length,
    free: filtered.filter(b => b.fee === false || b.fee === null).length,
    open24h: filtered.filter(b => b.hours === '24/7').length,
    sources: liveResult.summary.sources,
  };

  return { bathrooms: filtered, summary };
}

module.exports = {
  findAllBathrooms,
  findBathrooms,
  fetchRefugeRestrooms,
  fetchOverpassBathrooms,
  getCuratedBathrooms,
  BATHROOM_TYPES,
  CURATED_BATHROOMS,
};
