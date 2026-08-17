/**
 * ╔═══════════════════════════════════════════════════════════════════╗
 * ║           OpenVibeApp – Crime & Sketch Area Intelligence            ║
 * ║  Finds sketchy/high-activity areas via OSM grit indicators +    ║
 * ║  curated WA danger zones. Provides heatmap data + stream spots  ║
 * ╚═══════════════════════════════════════════════════════════════════╝
 *
 * Approach: Queries OSM for "urban grit" indicators — the density of
 * bars, nightclubs, pawn shops, bail bonds, adult shops, liquor stores,
 * homeless shelters, etc. correlates with areas of higher street activity.
 *
 * For an IRL streamer, these are BOTH areas to be cautious of AND areas
 * with the most potential "content" / interesting encounters.
 */
const { haversine, overpassQuery } = require('./utils');

// ── Grit Indicator Weights ──────────────────────────────────────────
// Higher weight = stronger signal of "sketchy" area
const GRIT_INDICATORS = {
  // Nightlife / vice
  bar:             { query: '["amenity"="bar"]',                weight: 2, label: 'Bar', icon: 'fa-martini-glass' },
  nightclub:       { query: '["amenity"="nightclub"]',          weight: 3, label: 'Nightclub', icon: 'fa-music' },
  pub:             { query: '["amenity"="pub"]',                weight: 1, label: 'Pub', icon: 'fa-beer-mug-empty' },
  strip_club:      { query: '["amenity"="stripclub"]',          weight: 4, label: 'Strip Club', icon: 'fa-mask' },
  casino:          { query: '["amenity"="casino"]',             weight: 3, label: 'Casino', icon: 'fa-dice' },
  adult_shop:      { query: '["shop"="erotic"]',                weight: 3, label: 'Adult Shop', icon: 'fa-store' },
  // Commerce grit
  pawn_shop:       { query: '["shop"="pawnbroker"]',            weight: 3, label: 'Pawn Shop', icon: 'fa-ring' },
  payday_loan:     { query: '["shop"="money_lender"]',          weight: 3, label: 'Payday Lender', icon: 'fa-money-bill' },
  liquor_store:    { query: '["shop"="alcohol"]',               weight: 2, label: 'Liquor Store', icon: 'fa-wine-bottle' },
  tattoo_shop:     { query: '["shop"="tattoo"]',                weight: 1, label: 'Tattoo Parlor', icon: 'fa-pen-nib' },
  vape_shop:       { query: '["shop"="e-cigarette"]',           weight: 1, label: 'Vape/Smoke Shop', icon: 'fa-smoking' },
  tobacco_shop:    { query: '["shop"="tobacco"]',               weight: 1, label: 'Tobacco Shop', icon: 'fa-smoking' },
  // Social services (indicates street population density)
  homeless_shelter:{ query: '["social_facility"="shelter"]["social_facility:for"~"homeless|underprivileged"]', weight: 2, label: 'Homeless Shelter', icon: 'fa-house-chimney' },
  food_bank:       { query: '["social_facility"="food_bank"]',  weight: 1, label: 'Food Bank', icon: 'fa-utensils' },
  // Law enforcement (indicates high-incident areas)
  police:          { query: '["amenity"="police"]',             weight: 1, label: 'Police Station', icon: 'fa-building-shield' },
  // Transportation (transient hubs)
  bus_station:     { query: '["amenity"="bus_station"]',        weight: 1, label: 'Bus Station', icon: 'fa-bus' },
  // Abandoned / sketchy structures
  abandoned:       { query: '["abandoned"="yes"]',              weight: 3, label: 'Abandoned Building', icon: 'fa-building-circle-xmark' },
  disused:         { query: '["disused"="yes"]["building"]',    weight: 2, label: 'Disused Building', icon: 'fa-building' },
};

// ── Curated WA Sketchy / High-Activity Zones ────────────────────────
// These are known high-activity areas — BOTH danger zones and content goldmines
const CURATED_ZONES = [
  // Seattle
  { name: '3rd Ave Corridor (The Blade)', lat: 47.6095, lon: -122.3384, sketchLevel: 5, city: 'Seattle',
    desc: '3rd Avenue between Pike & Pine. Known for open drug use, property crime, and sketchy encounters. High police presence. Prime IRL content zone but stay alert.',
    tags: ['drugs', 'theft', 'open-air', 'high-activity'] },
  { name: '12th & Jackson (Chinatown-ID)', lat: 47.5988, lon: -122.3166, sketchLevel: 4, city: 'Seattle',
    desc: 'Intersection near King St Station. Encampments, property crime, occasional assaults. Busy transit hub.',
    tags: ['encampments', 'theft', 'transit-hub'] },
  { name: 'Pioneer Square (After Dark)', lat: 47.6017, lon: -122.3321, sketchLevel: 4, city: 'Seattle',
    desc: 'Historic district. Day = tourists. Night = different vibe. Bars, shelters, missions all concentrated. Content-rich area.',
    tags: ['nightlife', 'shelters', 'historic', 'content'] },
  { name: 'Rainier Beach / Rainier Ave S', lat: 47.5219, lon: -122.2586, sketchLevel: 3, city: 'Seattle',
    desc: 'South Seattle corridor. Higher property crime rates. Diverse neighborhood with character.',
    tags: ['property-crime', 'diverse'] },
  { name: 'Aurora Ave N (Highway 99)', lat: 47.6930, lon: -122.3462, sketchLevel: 4, city: 'Seattle',
    desc: 'Historic highway strip. Motels, adult businesses, street activity. Classic drifter territory.',
    tags: ['motels', 'street-activity', 'highway'] },
  { name: 'SODO Industrial District', lat: 47.5650, lon: -122.3340, sketchLevel: 3, city: 'Seattle',
    desc: 'Industrial warehouses, rail yards, encampments under overpasses. Quiet at night but isolated.',
    tags: ['industrial', 'encampments', 'isolated'] },
  { name: 'University District (The Ave)', lat: 47.6607, lon: -122.3130, sketchLevel: 3, city: 'Seattle',
    desc: 'University Way NE. Street youth, panhandling, some drug activity. Lots of character and cheap food.',
    tags: ['street-youth', 'food', 'character'] },
  { name: 'Belltown Late Night', lat: 47.6148, lon: -122.3481, sketchLevel: 3, city: 'Seattle',
    desc: 'Downtown nightlife district. Bar fights, intoxicated crowds after 2AM. High content potential.',
    tags: ['nightlife', 'bars', 'late-night', 'content'] },

  // Tacoma
  { name: 'Hilltop (Tacoma)', lat: 47.2530, lon: -122.4583, sketchLevel: 4, city: 'Tacoma',
    desc: 'Historically rough neighborhood, gentrifying. Higher crime rates but strong community. Real talk, real people.',
    tags: ['gentrifying', 'community', 'content'] },
  { name: 'Pacific Ave Corridor (Tacoma)', lat: 47.2438, lon: -122.4356, sketchLevel: 4, city: 'Tacoma',
    desc: 'S Pacific Ave south of downtown. Motels, encampments, street activity. Similar vibe to Aurora Ave.',
    tags: ['motels', 'encampments', 'street-activity'] },
  { name: 'Tacoma Dome District', lat: 47.2392, lon: -122.4276, sketchLevel: 3, city: 'Tacoma',
    desc: 'Around the Tacoma Dome. Encampments near freeway. Transit hub. Active at night.',
    tags: ['transit-hub', 'encampments'] },

  // Everett
  { name: 'Everett Broadway Corridor', lat: 47.9783, lon: -122.2020, sketchLevel: 3, city: 'Everett',
    desc: 'Downtown Broadway area. Casino, bars, some street activity. Gritty but not dangerous if aware.',
    tags: ['casino', 'bars', 'downtown'] },
  { name: 'Everett Riverfront Encampments', lat: 47.9700, lon: -122.1880, sketchLevel: 3, city: 'Everett',
    desc: 'Along the Snohomish River delta. Large encampment areas, periodic sweeps.',
    tags: ['encampments', 'river', 'sweeps'] },

  // Spokane
  { name: 'East Sprague (Spokane)', lat: 47.6525, lon: -117.3900, sketchLevel: 4, city: 'Spokane',
    desc: 'E Sprague Ave corridor. Adult businesses, motels, street activity. Spokane\'s grittiest strip.',
    tags: ['motels', 'street-activity', 'adult'] },
  { name: 'Spokane Downtown STA Plaza', lat: 47.6580, lon: -117.4266, sketchLevel: 3, city: 'Spokane',
    desc: 'Transit center area. Concentration of services and shelters. Busy hub.',
    tags: ['transit-hub', 'shelters'] },

  // Olympia
  { name: 'Downtown Olympia (4th Ave)', lat: 47.0447, lon: -122.9011, sketchLevel: 3, city: 'Olympia',
    desc: 'State capital downtown. Visible street population, especially near Artesian Well and Capitol Lake.',
    tags: ['street-population', 'government'] },

  // Yakima
  { name: 'North 1st Street (Yakima)', lat: 46.6064, lon: -120.5095, sketchLevel: 4, city: 'Yakima',
    desc: 'N 1st St corridor. Higher crime rates. Gang activity reported. Be very cautious at night.',
    tags: ['gang-activity', 'property-crime', 'caution'] },

  // Smaller cities
  { name: 'Tukwila International Blvd', lat: 47.4734, lon: -122.2638, sketchLevel: 4, city: 'Tukwila',
    desc: 'International Blvd (old Pac Highway). Motels, street activity, diverse. Near Sea-Tac.',
    tags: ['motels', 'diverse', 'street-activity'] },
  { name: 'Federal Way Pacific Highway', lat: 47.3185, lon: -122.3120, sketchLevel: 3, city: 'Federal Way',
    desc: 'Pacific Highway S corridor. Similar vibe to Tukwila stretch. Properties and motels.',
    tags: ['motels', 'highway'] },
  { name: 'Aberdeen Downtown', lat: 46.9754, lon: -123.8157, sketchLevel: 3, city: 'Aberdeen',
    desc: 'Small logging town, high poverty rates. Meth and heroin issues. Kurt Cobain\'s hometown. Real grit, real stories.',
    tags: ['poverty', 'small-town', 'history', 'content'] },
  { name: 'Centralia/Chehalis I-5 Corridor', lat: 46.7168, lon: -122.9539, sketchLevel: 2, city: 'Centralia',
    desc: 'I-5 rest stops and truck stops. Transient traffic. Some encampments near railroad.',
    tags: ['highway', 'transient', 'truck-stops'] },
  { name: 'Moses Lake Broadway', lat: 47.1301, lon: -119.2779, sketchLevel: 2, city: 'Moses Lake',
    desc: 'Small town, limited services. Some drug activity. Very isolated if you need help.',
    tags: ['isolated', 'small-town'] },
];

// ── Overpass Query ──────────────────────────────────────────────────
function buildCrimeQuery(lat, lon, radiusMeters) {
  const indicators = Object.values(GRIT_INDICATORS);
  const parts = indicators.map(ind => {
    return `node${ind.query}(around:${radiusMeters},${lat},${lon});
  way${ind.query}(around:${radiusMeters},${lat},${lon});`;
  }).join('\n  ');

  return `
[out:json][timeout:45];
(
  ${parts}
);
out center body;
>;
out skel qt;
`;
}

// ── Classify indicators ─────────────────────────────────────────────
function classifyIndicator(tags) {
  if (!tags) return null;

  if (tags.amenity === 'bar') return 'bar';
  if (tags.amenity === 'nightclub') return 'nightclub';
  if (tags.amenity === 'pub') return 'pub';
  if (tags.amenity === 'stripclub') return 'strip_club';
  if (tags.amenity === 'casino') return 'casino';
  if (tags.shop === 'erotic') return 'adult_shop';
  if (tags.shop === 'pawnbroker') return 'pawn_shop';
  if (tags.shop === 'money_lender') return 'payday_loan';
  if (tags.shop === 'alcohol') return 'liquor_store';
  if (tags.shop === 'tattoo') return 'tattoo_shop';
  if (tags.shop === 'e-cigarette') return 'vape_shop';
  if (tags.shop === 'tobacco') return 'tobacco_shop';
  if (tags.social_facility === 'shelter') return 'homeless_shelter';
  if (tags.social_facility === 'food_bank') return 'food_bank';
  if (tags.amenity === 'police') return 'police';
  if (tags.amenity === 'bus_station') return 'bus_station';
  if (tags.abandoned === 'yes') return 'abandoned';
  if (tags.disused === 'yes' && tags.building) return 'disused';

  return null;
}

// ── Grid-based sketch scoring ───────────────────────────────────────
// Divides the search area into grid cells and scores each cell based
// on indicator density — this becomes the heatmap data
function computeSketchGrid(indicators, lat, lon, radiusMiles) {
  const gridSize = 0.005; // ~0.3 miles per cell
  const cells = {};

  for (const ind of indicators) {
    const cellKey = `${(Math.round(ind.lat / gridSize) * gridSize).toFixed(4)},${(Math.round(ind.lon / gridSize) * gridSize).toFixed(4)}`;
    if (!cells[cellKey]) {
      cells[cellKey] = {
        lat: Math.round(ind.lat / gridSize) * gridSize,
        lon: Math.round(ind.lon / gridSize) * gridSize,
        score: 0,
        indicators: [],
        count: 0,
      };
    }
    cells[cellKey].score += ind.weight;
    cells[cellKey].count++;
    cells[cellKey].indicators.push(ind);
  }

  // Normalize scores 0–1
  const maxScore = Math.max(...Object.values(cells).map(c => c.score), 1);
  for (const cell of Object.values(cells)) {
    cell.normalizedScore = cell.score / maxScore;
  }

  return Object.values(cells);
}

// ── Main Search ─────────────────────────────────────────────────────
async function findSketchAreas(lat, lon, radiusMiles) {
  const radiusMeters = Math.round(Math.min(radiusMiles * 1609.34, 25000));
  const allIndicators = [];

  // 1. OSM Overpass query for grit indicators
  try {
    const query = buildCrimeQuery(lat, lon, radiusMeters);
    const { data } = await overpassQuery(query, 45000);

    const elements = data?.elements || [];
    const seen = new Set();

    for (const el of elements) {
      const elLat = el.lat || el.center?.lat;
      const elLon = el.lon || el.center?.lon;
      if (!elLat || !elLon) continue;

      const posKey = `${elLat.toFixed(5)},${elLon.toFixed(5)}`;
      if (seen.has(posKey)) continue;
      seen.add(posKey);

      const tags = el.tags || {};
      const indType = classifyIndicator(tags);
      if (!indType) continue;

      const meta = GRIT_INDICATORS[indType];
      if (!meta) continue;

      allIndicators.push({
        id: `crime-${el.type}-${el.id}`,
        name: tags.name || meta.label,
        lat: elLat,
        lon: elLon,
        type: indType,
        label: meta.label,
        icon: meta.icon,
        weight: meta.weight,
        distanceMiles: Math.round(haversine(lat, lon, elLat, elLon) * 10) / 10,
        source: 'osm',
        osmTags: tags,
      });
    }
  } catch (e) {
    console.warn('[CrimeData] Overpass query failed:', e.message);
  }

  // 2. Curated WA zones within radius
  const curatedInRange = CURATED_ZONES
    .filter(z => haversine(lat, lon, z.lat, z.lon) <= radiusMiles)
    .map(z => ({
      id: `sketch-${z.lat.toFixed(4)}-${z.lon.toFixed(4)}`,
      name: z.name,
      lat: z.lat,
      lon: z.lon,
      type: 'curated_zone',
      label: `Sketch Zone (${z.city})`,
      icon: 'fa-skull-crossbones',
      weight: z.sketchLevel,
      sketchLevel: z.sketchLevel,
      distanceMiles: Math.round(haversine(lat, lon, z.lat, z.lon) * 10) / 10,
      description: z.desc,
      tags: z.tags || [],
      city: z.city,
      source: 'curated',
    }));

  // 3. Compute heatmap grid
  const allForGrid = [
    ...allIndicators,
    // Curated zones get extra weight to show up prominently
    ...curatedInRange.map(z => ({ ...z, weight: z.sketchLevel * 2 })),
  ];
  const sketchGrid = computeSketchGrid(allForGrid, lat, lon, radiusMiles);

  // 4. Build heatmap points array [lat, lon, intensity]
  const heatmapPoints = sketchGrid.map(cell => [
    cell.lat, cell.lon, cell.normalizedScore,
  ]);

  // 5. Count by type
  const counts = {};
  for (const ind of allIndicators) {
    counts[ind.type] = (counts[ind.type] || 0) + 1;
  }

  // 6. Build location results for map markers (curated zones only — indicators are heatmap-only)
  const locations = curatedInRange.map(z => ({
    id: z.id,
    name: z.name,
    lat: z.lat,
    lon: z.lon,
    type: `Sketch Zone (Level ${z.sketchLevel}/5)`,
    description: z.description + (z.tags?.length ? ` | Tags: ${z.tags.join(', ')}` : ''),
    distanceMiles: z.distanceMiles,
    source: 'Crime Intel',
    sourceIcon: 'fa-skull-crossbones',
    reservable: false,
    url: null,
    fee: 'Free',
    stealthRating: Math.max(1, 5 - z.sketchLevel), // Inverse — sketchy = low stealth
    tags: ['sketch-zone', 'crime', 'caution', ...(z.tags || [])],
    amenities: [],
    sketchLevel: z.sketchLevel,
    indicatorCounts: counts,
    curated: true,
  }));

  return {
    locations,
    heatmapPoints,
    indicators: allIndicators,
    curatedZones: curatedInRange,
    sketchGrid,
    counts,
    totalIndicators: allIndicators.length,
    totalZones: curatedInRange.length,
  };
}

module.exports = { findSketchAreas, GRIT_INDICATORS, CURATED_ZONES };
