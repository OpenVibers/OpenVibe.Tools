/**
 * ╔═══════════════════════════════════════════════════════════════════╗
 * ║           OpenVibeApp – Waterways & Water Features Module          ║
 * ║   Rivers, streams, lakes, springs, fords, boat launches, etc.    ║
 * ╚═══════════════════════════════════════════════════════════════════╝
 *
 * Data Sources (all via OpenStreetMap Overpass API):
 *   - waterway=river (2M globally — named rivers)
 *   - waterway=stream (28.7M globally — creeks and streams)
 *   - waterway=canal (artificial navigation/irrigation channels)
 *   - waterway=rapids (fast-flowing turbulent sections)
 *   - waterway=waterfall (waterfalls)
 *   - waterway=dam (dams — camping areas near water)
 *   - natural=water + water=river (river area polygons)
 *   - natural=water + water=lake (lakes — 881K globally)
 *   - natural=water + water=pond (ponds)
 *   - natural=water + water=reservoir (reservoirs)
 *   - natural=spring (springs — natural water sources)
 *   - ford=* (shallow river crossings — camping potential)
 *   - leisure=fishing (fishing spots near water)
 *   - leisure=swimming_area (natural swimming areas)
 *   - man_made=pier (piers — water access points)
 *   - leisure=slipway (boat launch ramps)
 *   - waterway=boatyard (boatyards near water)
 *   - amenity=boat_rental (boat rental near water)
 *
 * Enrichment tags: name, width, intermittent, seasonal, tidal,
 *                  fishing, swimming, boat, access, operator
 */
const { haversine, overpassQuery } = require('./utils');

// ═══════════════════════════════════════════════════════════════════
// WATERWAY / WATER FEATURE TYPES
// ═══════════════════════════════════════════════════════════════════
const WATERWAY_TYPES = {
  river:          { label: 'River',                icon: 'fa-water',           color: '#2563eb', stealth: 4 },
  stream:         { label: 'Stream / Creek',       icon: 'fa-water',           color: '#3b82f6', stealth: 4 },
  canal:          { label: 'Canal',                icon: 'fa-water',           color: '#60a5fa', stealth: 3 },
  rapids:         { label: 'Rapids',               icon: 'fa-water',           color: '#1d4ed8', stealth: 4 },
  waterfall:      { label: 'Waterfall',            icon: 'fa-water',           color: '#1e40af', stealth: 4 },
  dam:            { label: 'Dam',                  icon: 'fa-water',           color: '#475569', stealth: 2 },
  lake:           { label: 'Lake',                 icon: 'fa-water',           color: '#0ea5e9', stealth: 4 },
  pond:           { label: 'Pond',                 icon: 'fa-water',           color: '#38bdf8', stealth: 4 },
  reservoir:      { label: 'Reservoir',            icon: 'fa-water',           color: '#0284c7', stealth: 3 },
  spring:         { label: 'Natural Spring',       icon: 'fa-droplet',         color: '#06b6d4', stealth: 5 },
  ford:           { label: 'Ford / River Crossing',icon: 'fa-road',            color: '#0891b2', stealth: 4 },
  fishing:        { label: 'Fishing Area',         icon: 'fa-fish',            color: '#059669', stealth: 3 },
  swimming:       { label: 'Swimming Area',        icon: 'fa-person-swimming', color: '#14b8a6', stealth: 3 },
  boat_launch:    { label: 'Boat Launch / Slipway',icon: 'fa-ship',            color: '#0d9488', stealth: 2 },
  pier:           { label: 'Pier / Dock',          icon: 'fa-anchor',          color: '#64748b', stealth: 2 },
  wetland:        { label: 'Wetland',              icon: 'fa-water',           color: '#84cc16', stealth: 3 },
  river_area:     { label: 'River Area',           icon: 'fa-water',           color: '#2563eb', stealth: 4 },
  beach:          { label: 'Beach',                icon: 'fa-umbrella-beach',  color: '#fbbf24', stealth: 3 },
  riverbank:      { label: 'Riverbank Access',     icon: 'fa-water',           color: '#2563eb', stealth: 4 },
};

// ═══════════════════════════════════════════════════════════════════
// OVERPASS QUERY — Water features around a point
// ═══════════════════════════════════════════════════════════════════

function buildWaterwayQuery(lat, lon, radiusMeters) {
  // Cap individual element counts via shorter radius for very common tags
  // Streams (28.7M globally) get a tighter radius to avoid overwhelming results
  const streamRadius = Math.min(radiusMeters, 8000);
  return `
[out:json][timeout:40];
(
  // ── Rivers (named waterway ways — flow direction) ──
  way["waterway"="river"]["name"](around:${radiusMeters},${lat},${lon});

  // ── Streams / creeks (narrower waterways — tighter radius) ──
  way["waterway"="stream"]["name"](around:${streamRadius},${lat},${lon});

  // ── Canals (artificial navigable waterways) ──
  way["waterway"="canal"](around:${radiusMeters},${lat},${lon});

  // ── Rapids (fast-flowing turbulent sections) ──
  node["waterway"="rapids"](around:${radiusMeters},${lat},${lon});
  way["waterway"="rapids"](around:${radiusMeters},${lat},${lon});

  // ── Waterfalls ──
  node["waterway"="waterfall"](around:${radiusMeters},${lat},${lon});

  // ── Dams (barriers / camping areas near water) ──
  way["waterway"="dam"](around:${radiusMeters},${lat},${lon});
  node["waterway"="dam"](around:${radiusMeters},${lat},${lon});

  // ── River areas (polygon representation of wide rivers) ──
  way["natural"="water"]["water"="river"](around:${radiusMeters},${lat},${lon});

  // ── Lakes ──
  way["natural"="water"]["water"="lake"](around:${radiusMeters},${lat},${lon});
  relation["natural"="water"]["water"="lake"](around:${radiusMeters},${lat},${lon});

  // ── Ponds ──
  way["natural"="water"]["water"="pond"](around:${radiusMeters},${lat},${lon});

  // ── Reservoirs ──
  way["natural"="water"]["water"="reservoir"](around:${radiusMeters},${lat},${lon});
  relation["natural"="water"]["water"="reservoir"](around:${radiusMeters},${lat},${lon});

  // ── Natural springs (water sources — critical for camping!) ──
  node["natural"="spring"](around:${radiusMeters},${lat},${lon});

  // ── Fords (shallow river crossings — camping spots) ──
  node["ford"](around:${radiusMeters},${lat},${lon});
  way["ford"](around:${radiusMeters},${lat},${lon});

  // ── Fishing areas (spots near water for recreation) ──
  node["leisure"="fishing"](around:${radiusMeters},${lat},${lon});
  way["leisure"="fishing"](around:${radiusMeters},${lat},${lon});

  // ── Swimming areas (natural swimming holes/beaches) ──
  node["leisure"="swimming_area"](around:${radiusMeters},${lat},${lon});
  way["leisure"="swimming_area"](around:${radiusMeters},${lat},${lon});

  // ── Boat launches / slipways (water access points) ──
  node["leisure"="slipway"](around:${radiusMeters},${lat},${lon});
  way["leisure"="slipway"](around:${radiusMeters},${lat},${lon});

  // ── Piers & docks ──
  way["man_made"="pier"](around:${radiusMeters},${lat},${lon});
  node["man_made"="pier"](around:${radiusMeters},${lat},${lon});

  // ── Boat rentals (indicates water access) ──
  node["amenity"="boat_rental"](around:${radiusMeters},${lat},${lon});

  // ── Wetlands (marshy areas near water) ──
  way["natural"="wetland"](around:${radiusMeters},${lat},${lon});

  // ── Beaches (sand/gravel along water — great for camping!) ──
  node["natural"="beach"](around:${radiusMeters},${lat},${lon});
  way["natural"="beach"](around:${radiusMeters},${lat},${lon});
  node["leisure"="beach_resort"](around:${radiusMeters},${lat},${lon});
  way["leisure"="beach_resort"](around:${radiusMeters},${lat},${lon});

  // ── Riverbanks with public access ──
  way["waterway"="riverbank"](around:${radiusMeters},${lat},${lon});
);
out center body;
>;
out skel qt;
`;
}

// ═══════════════════════════════════════════════════════════════════
// CLASSIFICATION — Determine water feature type
// ═══════════════════════════════════════════════════════════════════

function classifyWaterway(tags) {
  const waterway = tags.waterway || '';
  const natural = tags.natural || '';
  const water = tags.water || '';
  const leisure = tags.leisure || '';
  const manMade = tags.man_made || '';
  const amenity = tags.amenity || '';
  const ford = tags.ford || '';

  // Waterway types
  if (waterway === 'river') return 'river';
  if (waterway === 'stream') return 'stream';
  if (waterway === 'canal') return 'canal';
  if (waterway === 'rapids') return 'rapids';
  if (waterway === 'waterfall') return 'waterfall';
  if (waterway === 'dam') return 'dam';

  // Water body types
  if (natural === 'water' && water === 'river') return 'river_area';
  if (natural === 'water' && water === 'lake') return 'lake';
  if (natural === 'water' && water === 'pond') return 'pond';
  if (natural === 'water' && water === 'reservoir') return 'reservoir';

  // Spring
  if (natural === 'spring') return 'spring';

  // Wetland
  if (natural === 'wetland') return 'wetland';

  // Beach
  if (natural === 'beach') return 'beach';
  if (leisure === 'beach_resort') return 'beach';

  // Riverbank
  if (waterway === 'riverbank') return 'riverbank';

  // Ford
  if (ford) return 'ford';

  // Leisure/recreation
  if (leisure === 'fishing') return 'fishing';
  if (leisure === 'swimming_area') return 'swimming';
  if (leisure === 'slipway') return 'boat_launch';

  // Man-made
  if (manMade === 'pier') return 'pier';
  if (amenity === 'boat_rental') return 'boat_launch';

  return 'river'; // fallback
}

// ═══════════════════════════════════════════════════════════════════
// NAME INFERENCE — Build meaningful names for unnamed features
// ═══════════════════════════════════════════════════════════════════

function inferWaterwayName(tags, type) {
  if (tags.name) return tags.name;
  if (tags.alt_name) return tags.alt_name;
  if (tags.loc_name) return tags.loc_name;
  if (tags.old_name) return `${tags.old_name} (historic)`;
  if (tags.operator) return `${tags.operator}`;

  const wt = WATERWAY_TYPES[type];
  if (!wt) return 'Water Feature';

  // Build contextual name from tags
  const width = tags.width ? ` (${tags.width}m wide)` : '';
  const intermittent = tags.intermittent === 'yes' ? ' (Seasonal)' : '';

  return `${wt.label}${width}${intermittent}`;
}

// ═══════════════════════════════════════════════════════════════════
// DESCRIPTION BUILDER
// ═══════════════════════════════════════════════════════════════════

function buildDescription(tags, type) {
  const parts = [];

  if (tags.description) parts.push(tags.description);

  const wt = WATERWAY_TYPES[type];
  if (wt) parts.push(`Type: ${wt.label}`);

  if (tags.width) parts.push(`Width: ${tags.width}m`);
  if (tags.intermittent === 'yes') parts.push('⚠️ Seasonal/intermittent flow');
  if (tags.seasonal) parts.push(`Seasonal: ${tags.seasonal}`);
  if (tags.tidal === 'yes') parts.push('🌊 Tidal');
  if (tags.boat === 'yes') parts.push('🚣 Boat access');
  if (tags.boat === 'no') parts.push('No boat access');
  if (tags.fishing === 'yes' || tags.leisure === 'fishing') parts.push('🎣 Fishing allowed');
  if (tags.fishing === 'no') parts.push('No fishing');
  if (tags.swimming === 'yes' || tags.leisure === 'swimming_area') parts.push('🏊 Swimming');
  if (tags.drinking_water === 'yes') parts.push('💧 Drinkable water');
  if (tags.drinking_water === 'no') parts.push('⚠️ Not drinkable');
  if (tags.access === 'private') parts.push('🔒 Private access');
  if (tags.access === 'yes' || tags.access === 'permissive') parts.push('✅ Public access');
  if (tags.operator) parts.push(`Operator: ${tags.operator}`);
  if (tags.opening_hours) parts.push(`Hours: ${tags.opening_hours}`);
  if (tags.fee === 'yes') parts.push('💰 Fee required');
  if (tags.fee === 'no') parts.push('✅ Free');
  if (tags.ford) parts.push('🚗 Ford crossing');
  if (tags.depth) parts.push(`Depth: ${tags.depth}`);
  if (tags.surface) parts.push(`Surface: ${tags.surface}`);

  return parts.join(' | ') || 'Water feature location from OpenStreetMap.';
}

// ═══════════════════════════════════════════════════════════════════
// STEALTH / CAMPING RATING
// ═══════════════════════════════════════════════════════════════════

function computeStealthRating(tags, type) {
  const wt = WATERWAY_TYPES[type];
  let rating = wt ? wt.stealth : 3;

  // Springs in remote areas are excellent for camping
  if (type === 'spring' && tags.drinking_water === 'yes') rating = 5;

  // Fords often have secluded river access
  if (type === 'ford') rating = 4;

  // Named rivers with public access = good camping nearby
  if (tags.access === 'yes' || tags.access === 'permissive') rating = Math.min(5, rating + 1);

  // Private access = lower rating
  if (tags.access === 'private' || tags.access === 'no') rating = Math.max(1, rating - 2);

  // Intermittent streams may be dry — less useful
  if (tags.intermittent === 'yes') rating = Math.max(1, rating - 1);

  // Tidal areas are tricky for camping
  if (tags.tidal === 'yes') rating = Math.max(1, rating - 1);

  // Piers and boat launches are more urban/visible
  if (type === 'pier' || type === 'boat_launch') rating = 2;

  // Large lakes and reservoirs are great if accessible
  if ((type === 'lake' || type === 'reservoir') && tags.name) rating = 4;

  // Wetlands are not great for sleeping
  if (type === 'wetland') rating = 2;

  // Beaches can be great stealth spots, especially remote ones
  if (type === 'beach') rating = tags.access === 'private' ? 1 : 3;

  // Riverbank access — good secluded spots
  if (type === 'riverbank') rating = 4;

  // Swimming and fishing areas indicate pleasant accessible water
  if (type === 'swimming' || type === 'fishing') rating = 3;

  return Math.max(1, Math.min(5, rating));
}

// ═══════════════════════════════════════════════════════════════════
// EXTRACT AMENITIES
// ═══════════════════════════════════════════════════════════════════

function extractAmenities(tags) {
  const amenities = [];
  if (tags.drinking_water === 'yes') amenities.push('Drinking Water');
  if (tags.fishing === 'yes' || tags.leisure === 'fishing') amenities.push('Fishing');
  if (tags.swimming === 'yes' || tags.leisure === 'swimming_area') amenities.push('Swimming');
  if (tags.boat === 'yes') amenities.push('Boat Access');
  if (tags.toilets === 'yes') amenities.push('Toilets');
  if (tags.picnic_table === 'yes') amenities.push('Picnic Tables');
  if (tags.access === 'yes' || tags.access === 'permissive') amenities.push('Public Access');
  if (tags.fee === 'no') amenities.push('Free');
  return amenities;
}

// ═══════════════════════════════════════════════════════════════════
// EXTRACT TAGS
// ═══════════════════════════════════════════════════════════════════

function extractTags(tags, type) {
  const result = [type, 'water'];
  if (tags.name) result.push('named');
  if (tags.drinking_water === 'yes') result.push('drinkable');
  if (tags.fishing === 'yes') result.push('fishing');
  if (tags.swimming === 'yes') result.push('swimming');
  if (tags.boat === 'yes') result.push('boat-access');
  if (tags.access === 'yes' || tags.access === 'permissive') result.push('public-access');
  if (tags.fee === 'no') result.push('free');
  if (tags.intermittent === 'yes') result.push('seasonal');
  if (tags.ford) result.push('ford');
  return result;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN SEARCH FUNCTION
// ═══════════════════════════════════════════════════════════════════

async function findWaterways(lat, lon, radiusMiles = 15) {
  const radiusMeters = Math.round(Math.min(radiusMiles, 20) * 1609.34);

  try {
    const query = buildWaterwayQuery(lat, lon, radiusMeters);
    const { data } = await overpassQuery(query, 50000);

    const elements = data?.elements || [];
    const results = [];
    const seen = new Set();

    for (const el of elements) {
      const elLat = el.lat || (el.center && el.center.lat);
      const elLon = el.lon || (el.center && el.center.lon);
      if (!elLat || !elLon) continue;

      const tags = el.tags || {};

      // Skip skeleton nodes from way expansion
      const waterway = tags.waterway || '';
      const natural = tags.natural || '';
      const leisure = tags.leisure || '';
      const manMade = tags.man_made || '';
      const amenity = tags.amenity || '';
      const ford = tags.ford || '';
      if (!waterway && !natural && !leisure && !manMade && !amenity && !ford) continue;

      // Classify
      const type = classifyWaterway(tags);
      const wt = WATERWAY_TYPES[type];
      if (!wt) continue;

      // Dedup by location + name
      const dedupKey = `${elLat.toFixed(4)}-${elLon.toFixed(4)}-${tags.name || type}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      const dist = haversine(lat, lon, elLat, elLon);

      results.push({
        id: `osm-water-${el.type}-${el.id}`,
        name: inferWaterwayName(tags, type),
        description: buildDescription(tags, type),
        lat: elLat,
        lon: elLon,
        distanceMiles: Math.round(dist * 10) / 10,
        type: wt.label,
        waterwayType: type,
        source: 'Waterways',
        sourceIcon: wt.icon,
        url: `https://www.openstreetmap.org/${el.type}/${el.id}`,
        fee: tags.fee === 'yes' ? 'Fee required' : tags.fee === 'no' ? 'Free' : 'Unknown',
        stealthRating: computeStealthRating(tags, type),
        tags: extractTags(tags, type),
        amenities: extractAmenities(tags),
        icon: wt.icon,
        color: wt.color,
        isDrinkable: tags.drinking_water === 'yes',
        isIntermittent: tags.intermittent === 'yes',
        isTidal: tags.tidal === 'yes',
        width: tags.width || null,
      });
    }

    // Sort by distance
    results.sort((a, b) => a.distanceMiles - b.distanceMiles);

    // Summary
    const summary = {
      total: results.length,
      rivers: results.filter(r => r.waterwayType === 'river' || r.waterwayType === 'river_area').length,
      streams: results.filter(r => r.waterwayType === 'stream').length,
      lakes: results.filter(r => r.waterwayType === 'lake').length,
      springs: results.filter(r => r.waterwayType === 'spring').length,
      fords: results.filter(r => r.waterwayType === 'ford').length,
      fishing: results.filter(r => r.waterwayType === 'fishing').length,
      other: results.filter(r => !['river', 'river_area', 'stream', 'lake', 'spring', 'ford', 'fishing'].includes(r.waterwayType)).length,
    };

    return { waterways: results, summary };
  } catch (err) {
    console.warn('Waterways search error:', err.message);
    return { waterways: [], summary: { total: 0 } };
  }
}

module.exports = {
  findWaterways,
  WATERWAY_TYPES,
};
