/**
 * ╔═══════════════════════════════════════════════════════════════════╗
 * ║            OpenVibeApp – Rain Cover & Awning Finder                ║
 * ║    Finds buildings with awnings, covered walkways, canopies,    ║
 * ║    arcades, porches, carports & other rain-sheltered spots      ║
 * ╚═══════════════════════════════════════════════════════════════════╝
 *
 * OSM tags queried (not duplicated from overpass.js):
 *   - covered=yes/arcade/colonnade/partial (covered walkways & passages)
 *   - man_made=canopy (canopy structures)
 *   - building=carport (open-sided car shelters)
 *   - building:part=porch (building porches / awnings)
 *   - amenity=marketplace + covered (covered markets)
 *   - leisure=outdoor_seating + weather_protection=yes (covered seating)
 *   - highway=pedestrian + covered=yes (covered pedestrian streets)
 *   - amenity=loading_dock (covered loading areas)
 *   - building=grandstand (covered stadium seating)
 *   - railway=platform + shelter=yes (covered rail platforms)
 *
 * Also includes curated WA-specific covered locations.
 */
const { haversine, overpassQuery } = require('./utils');

// ── Cover Type Definitions ──────────────────────────────────────────
const COVER_TYPES = {
  covered_walkway:  { label: 'Covered Walkway',    icon: 'fa-road',             color: '#6366f1', stealth: 2 },
  arcade:           { label: 'Arcade / Colonnade',  icon: 'fa-archway',          color: '#8b5cf6', stealth: 2 },
  canopy:           { label: 'Canopy / Awning',     icon: 'fa-tent-arrow-down-to-line', color: '#f59e0b', stealth: 2 },
  carport:          { label: 'Carport',             icon: 'fa-car-side',         color: '#64748b', stealth: 3 },
  porch:            { label: 'Building Porch',      icon: 'fa-house-chimney',    color: '#f97316', stealth: 2 },
  covered_market:   { label: 'Covered Market',      icon: 'fa-store',            color: '#ec4899', stealth: 1 },
  covered_seating:  { label: 'Covered Seating',     icon: 'fa-chair',            color: '#14b8a6', stealth: 1 },
  covered_platform: { label: 'Covered Platform',    icon: 'fa-train',            color: '#06b6d4', stealth: 1 },
  grandstand:       { label: 'Grandstand / Bleachers', icon: 'fa-flag',          color: '#3b82f6', stealth: 3 },
  loading_dock:     { label: 'Loading Dock / Bay',  icon: 'fa-warehouse',        color: '#94a3b8', stealth: 3 },
  covered_area:     { label: 'Covered Area',        icon: 'fa-cloud-rain',       color: '#22c55e', stealth: 2 },
  curated:          { label: 'Known Cover Spot',    icon: 'fa-umbrella',         color: '#a855f7', stealth: 3 },
};

// ── Curated WA Rain Cover Spots ─────────────────────────────────────
// Hand-picked locations with reliable rain cover in Washington State
const CURATED_COVER_SPOTS = [
  // Seattle
  { name: 'Pike Place Market Covered Arcade', lat: 47.6089, lon: -122.3404, type: 'arcade', city: 'Seattle', desc: 'Long covered arcade walkway with multiple levels. Heavy foot traffic during day, quieter at night. Famous covered market area.', stealth: 1 },
  { name: 'Pioneer Square Pergola', lat: 47.6017, lon: -122.3321, type: 'covered_walkway', city: 'Seattle', desc: 'Historic iron and glass pergola in Pioneer Square. Open-air covered structure, well-lit at night.', stealth: 1 },
  { name: 'University of Washington Covered Walkways', lat: 47.6553, lon: -122.3035, type: 'covered_walkway', city: 'Seattle', desc: 'Extensive covered walkways between campus buildings. Multiple covered corridors around Red Square and Suzzallo Library.', stealth: 2 },
  { name: 'Westlake Center Canopy', lat: 47.6113, lon: -122.3377, type: 'canopy', city: 'Seattle', desc: 'Large covered canopy area at Westlake Center transit hub. Bus and light rail shelter area.', stealth: 1 },
  { name: 'International District Station Covered Area', lat: 47.5982, lon: -122.3268, type: 'covered_platform', city: 'Seattle', desc: 'Large covered light rail and bus station. Extended roof provides significant rain coverage.', stealth: 1 },
  { name: 'Freeway Park Covered Sections', lat: 47.6093, lon: -122.3316, type: 'covered_area', city: 'Seattle', desc: 'Park built over I-5 freeway with covered concrete overhangs and enclosed garden areas. Multiple sheltered nooks.', stealth: 3 },
  { name: 'Seattle Center Armory Building', lat: 47.6217, lon: -122.3509, type: 'covered_area', city: 'Seattle', desc: 'Large indoor/outdoor area near Space Needle. Covered eating areas and walkways. Open to public during hours.', stealth: 1 },
  { name: 'CenturyLink Field Event Center Overhang', lat: 47.5952, lon: -122.3316, type: 'grandstand', city: 'Seattle', desc: 'Large stadium overhang areas on south and east sides. Significant covered concrete areas for rain shelter.', stealth: 2 },
  { name: 'T-Mobile Park Garage Deck Overhang', lat: 47.5912, lon: -122.3325, type: 'covered_area', city: 'Seattle', desc: 'Multiple covered parking areas and walkway overhangs around the stadium. Off-season access varies.', stealth: 2 },
  { name: 'Rainier Beach Station Covered Transfer', lat: 47.5219, lon: -122.2786, type: 'covered_platform', city: 'Seattle', desc: 'Covered bus-rail transfer area with extended canopy roof.', stealth: 1 },

  // Tacoma
  { name: 'Tacoma Union Station Covered Entry', lat: 47.2519, lon: -122.4291, type: 'porch', city: 'Tacoma', desc: 'Large historic building with covered columned entry portico. Federal courthouse, well-maintained area.', stealth: 1 },
  { name: 'Tacoma Dome Station Platform', lat: 47.2392, lon: -122.4276, type: 'covered_platform', city: 'Tacoma', desc: 'Sounder train platform with extended covered roof. Bus transfer area also covered.', stealth: 1 },
  { name: 'Point Defiance Park Pavilions', lat: 47.3099, lon: -122.5253, type: 'covered_area', city: 'Tacoma', desc: 'Multiple covered picnic pavilions and rain shelters in the park. Some near water, good forest cover.', stealth: 3 },
  { name: 'Tacoma Broadway Center Canopy', lat: 47.2533, lon: -122.4380, type: 'canopy', city: 'Tacoma', desc: 'Extended marquee and canopy over Broadway sidewalk near Pantages Theater.', stealth: 1 },

  // Olympia
  { name: 'Olympia Farmers Market Covered Pavilion', lat: 47.0469, lon: -122.9025, type: 'covered_market', city: 'Olympia', desc: 'Large covered market structure at the port. Open-sided roof structure, significant rain coverage.', stealth: 2 },
  { name: 'Capitol Building Colonnade', lat: 47.0352, lon: -122.9049, type: 'arcade', city: 'Olympia', desc: 'WA State Capitol building with covered columned walkways and porticos. Grand entry canopy.', stealth: 1 },
  { name: 'Percival Landing Boardwalk Shelters', lat: 47.0470, lon: -122.9069, type: 'covered_area', city: 'Olympia', desc: 'Waterfront boardwalk with covered observation shelters and benches.', stealth: 2 },

  // Everett
  { name: 'Everett Station Transit Center', lat: 47.9749, lon: -122.1975, type: 'covered_platform', city: 'Everett', desc: 'Covered transit hub with bus bays and Sounder commuter rail. Extended roof areas.', stealth: 1 },
  { name: 'Everett Community College Covered Walkways', lat: 47.9874, lon: -122.1979, type: 'covered_walkway', city: 'Everett', desc: 'Campus interconnected covered walkways between buildings.', stealth: 2 },

  // Bellingham
  { name: 'Bellingham Depot Market Square', lat: 48.7198, lon: -122.4794, type: 'covered_market', city: 'Bellingham', desc: 'Covered farmers market and community area near the waterfront.', stealth: 2 },
  { name: 'WWU Campus Covered Corridors', lat: 48.7337, lon: -122.4868, type: 'covered_walkway', city: 'Bellingham', desc: 'Western Washington University campus with multiple covered walkway corridors between buildings.', stealth: 2 },
  { name: 'Bellingham Cruise Terminal Overhang', lat: 48.7483, lon: -122.4757, type: 'canopy', city: 'Bellingham', desc: 'Ferry terminal building with large covered waiting and boarding areas.', stealth: 1 },

  // Spokane
  { name: 'Spokane STA Plaza Transit Center', lat: 47.6580, lon: -117.4266, type: 'covered_platform', city: 'Spokane', desc: 'Downtown bus transit center with covered loading areas and waiting shelters.', stealth: 1 },
  { name: 'Riverfront Park Pavilion', lat: 47.6604, lon: -117.4195, type: 'covered_area', city: 'Spokane', desc: 'Large covered pavilion structure in Riverfront Park near the falls.', stealth: 2 },
  { name: 'Gonzaga University Covered Walkways', lat: 47.6666, lon: -117.4023, type: 'covered_walkway', city: 'Spokane', desc: 'Campus covered corridors connecting academic buildings.', stealth: 2 },

  // Smaller WA cities
  { name: 'Snohomish Historic District Awnings', lat: 47.9128, lon: -122.0976, type: 'canopy', city: 'Snohomish', desc: 'Downtown 1st Street historic buildings with continuous awnings over sidewalks. Good rain cover for walking.', stealth: 1 },
  { name: 'Arlington Community Center Covered Area', lat: 48.1988, lon: -122.1246, type: 'covered_area', city: 'Arlington', desc: 'Covered outdoor areas near the community center and adjacent park.', stealth: 2 },
  { name: 'Granite Falls Fish Ladder Shelter', lat: 48.0835, lon: -121.9686, type: 'covered_area', city: 'Granite Falls', desc: 'Covered viewing shelter at the salmon fish ladder. Small but dry.', stealth: 2 },
  { name: 'Darrington Community Center Overhang', lat: 48.2563, lon: -121.6014, type: 'porch', city: 'Darrington', desc: 'Building overhang at the community center. Near the Whitehorse Trail trailhead.', stealth: 2 },
  { name: 'Marysville Opera House Canopy', lat: 48.0520, lon: -122.1769, type: 'canopy', city: 'Marysville', desc: 'Historic opera house with covered entry canopy. Downtown area with additional storefront awnings.', stealth: 1 },
  { name: 'Monroe Gateway Transit Center', lat: 47.8542, lon: -121.9706, type: 'covered_platform', city: 'Monroe', desc: 'Community Transit covered bus shelter and park-and-ride covered area.', stealth: 1 },
  { name: 'Lynnwood Transit Center Covered Areas', lat: 47.8149, lon: -122.2942, type: 'covered_platform', city: 'Lynnwood', desc: 'Major transit center with extensive covered bus bays and walkways.', stealth: 1 },
  { name: 'Leavenworth Gazebo Park', lat: 47.5962, lon: -120.6615, type: 'covered_area', city: 'Leavenworth', desc: 'Bavarian-style gazebo and covered park structures in the village. Tourist area.', stealth: 1 },
  { name: 'Port Townsend Downtown Awnings', lat: 48.1170, lon: -122.7603, type: 'canopy', city: 'Port Townsend', desc: 'Victorian-era downtown buildings with continuous covered sidewalk awnings on Water Street.', stealth: 1 },
  { name: 'Anacortes Ferry Terminal Covered Waiting', lat: 48.5073, lon: -122.6783, type: 'covered_platform', city: 'Anacortes', desc: 'WSF ferry terminal with large covered vehicle and pedestrian waiting areas.', stealth: 1 },
  { name: 'Centralia Factory Outlets Covered Walkway', lat: 46.7151, lon: -122.9639, type: 'covered_walkway', city: 'Centralia', desc: 'Outlet mall with covered exterior walkways between stores.', stealth: 1 },
  { name: 'Ellensburg Rodeo Grounds Grandstand', lat: 46.9965, lon: -120.5477, type: 'grandstand', city: 'Ellensburg', desc: 'Rodeo arena grandstand with covered seating. Off-season access possible. Large covered area.', stealth: 3 },
  { name: 'Wenatchee Convention Center Canopy', lat: 47.4246, lon: -120.3103, type: 'canopy', city: 'Wenatchee', desc: 'Large covered entry and walkway areas at the convention center.', stealth: 1 },
  { name: 'Yakima Valley SunDome Overhang', lat: 46.5914, lon: -120.5156, type: 'grandstand', city: 'Yakima', desc: 'Large arena with covered entry areas and parking overhangs.', stealth: 2 },
  { name: 'Bremerton Ferry Terminal Covered Walk', lat: 47.5617, lon: -122.6249, type: 'covered_walkway', city: 'Bremerton', desc: 'WSF terminal with covered pedestrian walkway connecting to bus transit.', stealth: 1 },
  { name: 'Tumwater Falls Park Shelters', lat: 47.0105, lon: -122.9062, type: 'covered_area', city: 'Tumwater', desc: 'Park with covered picnic shelters near the falls. Wooded area provides additional cover.', stealth: 3 },
  { name: 'Whidbey Island NAS Commissary Overhang', lat: 48.3527, lon: -122.6573, type: 'covered_area', city: 'Oak Harbor', desc: 'Large covered shopping area overhangs in Oak Harbor commercial district.', stealth: 1 },
  { name: 'I-5 Marysville Rest Area Covered Shelters', lat: 48.0802, lon: -122.1789, type: 'covered_area', city: 'Marysville', desc: 'I-5 rest area with covered picnic shelters, restrooms, and vending. 24/7 access.', stealth: 2 },
];

// ── Overpass Query ──────────────────────────────────────────────────
function buildCoverQuery(lat, lon, radiusMeters) {
  return `
[out:json][timeout:45];
(
  // ── Covered walkways, arcades, colonnades ──
  way["covered"="yes"]["highway"](around:${radiusMeters},${lat},${lon});
  way["covered"="arcade"](around:${radiusMeters},${lat},${lon});
  way["covered"="colonnade"](around:${radiusMeters},${lat},${lon});
  way["covered"="partial"]["highway"](around:${radiusMeters},${lat},${lon});

  // ── Canopy structures ──
  node["man_made"="canopy"](around:${radiusMeters},${lat},${lon});
  way["man_made"="canopy"](around:${radiusMeters},${lat},${lon});

  // ── Carports (open-sided rain cover) ──
  node["building"="carport"](around:${radiusMeters},${lat},${lon});
  way["building"="carport"](around:${radiusMeters},${lat},${lon});

  // ── Building porches & awnings ──
  way["building:part"="porch"](around:${radiusMeters},${lat},${lon});

  // ── Covered outdoor seating / weather protection ──
  node["leisure"="outdoor_seating"]["weather_protection"="yes"](around:${radiusMeters},${lat},${lon});
  way["leisure"="outdoor_seating"]["weather_protection"="yes"](around:${radiusMeters},${lat},${lon});
  node["leisure"="outdoor_seating"]["covered"="yes"](around:${radiusMeters},${lat},${lon});
  way["leisure"="outdoor_seating"]["covered"="yes"](around:${radiusMeters},${lat},${lon});

  // ── Covered markets ──
  node["amenity"="marketplace"]["building"="roof"](around:${radiusMeters},${lat},${lon});
  way["amenity"="marketplace"]["building"="roof"](around:${radiusMeters},${lat},${lon});
  node["amenity"="marketplace"]["covered"="yes"](around:${radiusMeters},${lat},${lon});
  way["amenity"="marketplace"]["covered"="yes"](around:${radiusMeters},${lat},${lon});

  // ── Grandstands / bleachers (covered stadium seating) ──
  node["building"="grandstand"](around:${radiusMeters},${lat},${lon});
  way["building"="grandstand"](around:${radiusMeters},${lat},${lon});

  // ── Covered rail/transit platforms ──
  way["railway"="platform"]["shelter"="yes"](around:${radiusMeters},${lat},${lon});
  way["railway"="platform"]["covered"="yes"](around:${radiusMeters},${lat},${lon});
  way["public_transport"="platform"]["covered"="yes"](around:${radiusMeters},${lat},${lon});

  // ── Loading docks (industrial covered bays) ──
  node["amenity"="loading_dock"](around:${radiusMeters},${lat},${lon});
  way["amenity"="loading_dock"](around:${radiusMeters},${lat},${lon});
  node["industrial"="warehouse"]["building"="roof"](around:${radiusMeters},${lat},${lon});
  way["industrial"="warehouse"]["building"="roof"](around:${radiusMeters},${lat},${lon});

  // ── Pergolas with cover ──
  node["amenity"="shelter"]["shelter_type"="pergola"](around:${radiusMeters},${lat},${lon});
  way["amenity"="shelter"]["shelter_type"="pergola"](around:${radiusMeters},${lat},${lon});
);
out center body;
>;
out skel qt;
`;
}

// ── Classification ──────────────────────────────────────────────────
function classifyCover(tags) {
  if (!tags) return 'covered_area';

  const covered = tags.covered || '';
  const building = tags.building || '';
  const buildingPart = tags['building:part'] || '';
  const manMade = tags.man_made || '';
  const amenity = tags.amenity || '';
  const leisure = tags.leisure || '';
  const railway = tags.railway || '';
  const publicTransport = tags.public_transport || '';
  const shelterType = tags.shelter_type || '';

  if (covered === 'arcade' || covered === 'colonnade') return 'arcade';
  if (covered === 'yes' || covered === 'partial') {
    if (tags.highway) return 'covered_walkway';
    if (railway === 'platform' || publicTransport === 'platform') return 'covered_platform';
    if (leisure === 'outdoor_seating') return 'covered_seating';
    if (amenity === 'marketplace') return 'covered_market';
    return 'covered_area';
  }
  if (manMade === 'canopy') return 'canopy';
  if (building === 'carport') return 'carport';
  if (building === 'grandstand') return 'grandstand';
  if (buildingPart === 'porch') return 'porch';
  if (amenity === 'marketplace') return 'covered_market';
  if (amenity === 'loading_dock' || (tags.industrial === 'warehouse' && building === 'roof')) return 'loading_dock';
  if (leisure === 'outdoor_seating' && (tags.weather_protection === 'yes' || covered === 'yes')) return 'covered_seating';
  if (railway === 'platform' || publicTransport === 'platform') return 'covered_platform';
  if (shelterType === 'pergola') return 'canopy';

  return 'covered_area';
}

// ── Stealth Rating ──────────────────────────────────────────────────
function computeStealthRating(tags, coverType) {
  const base = (COVER_TYPES[coverType] || COVER_TYPES.covered_area).stealth;
  let rating = base;

  // Bonuses
  if (tags?.access === 'yes' || tags?.access === 'permissive') rating += 0.5;
  if (tags?.lit === 'no') rating += 0.5;
  if (!tags?.name) rating += 0.3; // Unnamed = less notable
  if (tags?.opening_hours === '24/7') rating += 0.3;

  // Penalties  
  if (tags?.lit === 'yes' || tags?.lit === '24/7') rating -= 0.3;
  if (tags?.access === 'private' || tags?.access === 'no') rating -= 1;
  if (tags?.surveillance === 'yes' || tags?.['surveillance:type']) rating -= 0.5;

  return Math.max(1, Math.min(5, Math.round(rating)));
}

// ── Naming ──────────────────────────────────────────────────────────
function buildCoverName(tags, coverType) {
  const meta = COVER_TYPES[coverType] || COVER_TYPES.covered_area;
  if (tags?.name) return tags.name;

  const parts = [];
  if (tags?.highway) {
    const hwType = tags.highway.replace(/_/g, ' ');
    parts.push(`Covered ${hwType.charAt(0).toUpperCase() + hwType.slice(1)}`);
  } else {
    parts.push(meta.label);
  }

  if (tags?.operator) parts.push(`(${tags.operator})`);
  else if (tags?.['addr:street']) parts.push(`on ${tags['addr:street']}`);

  return parts.join(' ') || meta.label;
}

// ── Description ─────────────────────────────────────────────────────
function buildCoverDescription(tags, coverType) {
  const meta = COVER_TYPES[coverType] || COVER_TYPES.covered_area;
  const parts = [`${meta.label} — rain & weather protection.`];

  if (tags?.surface) parts.push(`Surface: ${tags.surface}.`);
  if (tags?.width) parts.push(`Width: ${tags.width}m.`);
  if (tags?.length) parts.push(`Length: ${tags.length}m.`);
  if (tags?.height || tags?.maxheight) parts.push(`Height/clearance: ${tags.height || tags.maxheight}m.`);
  if (tags?.lit === 'yes') parts.push('Lit at night.');
  else if (tags?.lit === 'no') parts.push('Not lit — bring headlamp.');
  if (tags?.access === 'private') parts.push('⚠️ Private access.');
  if (tags?.opening_hours) parts.push(`Hours: ${tags.opening_hours}.`);
  if (tags?.operator) parts.push(`Operated by: ${tags.operator}.`);
  if (tags?.material) parts.push(`Material: ${tags.material}.`);
  if (tags?.roof && tags.roof !== 'yes') parts.push(`Roof type: ${tags.roof}.`);

  return parts.join(' ');
}

// ── Main Search ─────────────────────────────────────────────────────
async function findCover(lat, lon, radiusMiles) {
  const radiusMeters = Math.round(Math.min(radiusMiles * 1609.34, 30000));

  let osmResults = [];
  try {
    const query = buildCoverQuery(lat, lon, radiusMeters);
    const { data } = await overpassQuery(query, 45000);

    const elements = data?.elements || [];
    const seen = new Set();

    for (const el of elements) {
      const elLat = el.lat || el.center?.lat;
      const elLon = el.lon || el.center?.lon;
      if (!elLat || !elLon) continue;

      // Deduplicate by approximate position
      const posKey = `${elLat.toFixed(5)},${elLon.toFixed(5)}`;
      if (seen.has(posKey)) continue;
      seen.add(posKey);

      const tags = el.tags || {};
      const coverType = classifyCover(tags);
      const meta = COVER_TYPES[coverType] || COVER_TYPES.covered_area;
      const dist = haversine(lat, lon, elLat, elLon);

      osmResults.push({
        name: buildCoverName(tags, coverType),
        lat: elLat,
        lon: elLon,
        type: 'Covered Structure',
        subType: coverType,
        coverLabel: meta.label,
        coverIcon: meta.icon,
        coverColor: meta.color,
        description: buildCoverDescription(tags, coverType),
        stealthRating: computeStealthRating(tags, coverType),
        distanceMiles: Math.round(dist * 10) / 10,
        source: 'RainCover',
        sourceIcon: 'fa-umbrella',
        tags: extractCoverTags(tags),
        lit: tags.lit === 'yes',
        access: tags.access || 'unknown',
        surface: tags.surface || null,
        covered: tags.covered || 'yes',
      });
    }
  } catch (e) {
    console.warn('[Cover] Overpass query failed:', e.message);
  }

  // ── Merge curated WA spots ──
  const curatedResults = CURATED_COVER_SPOTS
    .filter(c => {
      const dist = haversine(lat, lon, c.lat, c.lon);
      return dist <= radiusMiles;
    })
    .map(c => {
      const dist = haversine(lat, lon, c.lat, c.lon);
      const meta = COVER_TYPES[c.type] || COVER_TYPES.curated;
      return {
        name: c.name,
        lat: c.lat,
        lon: c.lon,
        type: 'Covered Structure',
        subType: c.type,
        coverLabel: meta.label,
        coverIcon: meta.icon,
        coverColor: meta.color,
        description: c.desc + (c.city ? ` (${c.city}, WA)` : ''),
        stealthRating: c.stealth || 2,
        distanceMiles: Math.round(dist * 10) / 10,
        source: 'RainCover',
        sourceIcon: 'fa-umbrella',
        tags: [],
        lit: null,
        access: 'public',
        surface: null,
        covered: 'yes',
        curated: true,
      };
    });

  // Deduplicate curated vs OSM (if within ~100m of each other, keep curated)
  const allResults = [...curatedResults];
  for (const osm of osmResults) {
    const isDuplicate = curatedResults.some(c =>
      haversine(osm.lat, osm.lon, c.lat, c.lon) < 0.1 // ~0.1 miles = ~160m
    );
    if (!isDuplicate) allResults.push(osm);
  }

  // Sort by distance
  allResults.sort((a, b) => a.distanceMiles - b.distanceMiles);

  // Categorize
  const categorized = {};
  const counts = {};
  for (const r of allResults) {
    const key = r.subType || 'covered_area';
    if (!categorized[key]) categorized[key] = [];
    categorized[key].push(r);
    counts[key] = (counts[key] || 0) + 1;
  }

  return {
    cover: allResults,
    categorized,
    counts,
    total: allResults.length,
  };
}

// ── Tag extraction ──────────────────────────────────────────────────
function extractCoverTags(tags) {
  const result = [];
  if (tags.covered) result.push(`Covered: ${tags.covered}`);
  if (tags.shelter === 'yes') result.push('Has shelter');
  if (tags.bench === 'yes') result.push('Bench');
  if (tags.lit === 'yes') result.push('Lit');
  if (tags.wheelchair === 'yes') result.push('Wheelchair accessible');
  if (tags.drinking_water === 'yes') result.push('Drinking water');
  if (tags.surface) result.push(`Surface: ${tags.surface}`);
  if (tags.material) result.push(`Material: ${tags.material}`);
  if (tags.opening_hours) result.push(`Hours: ${tags.opening_hours}`);
  return result;
}

module.exports = { findCover, COVER_TYPES, CURATED_COVER_SPOTS };
