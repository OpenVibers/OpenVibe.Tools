/**
 * OpenVibeApp – Woods & Wilderness Module
 * Dedicated search for forested areas, national parks, protected wilderness,
 * state forests, nature reserves, and other wild land suitable for stealth camping.
 *
 * OSM Tags queried:
 *   - natural=wood (tree-covered areas, 12M+ globally)
 *   - landuse=forest (managed woodland, 5.8M globally)
 *   - boundary=national_park (government-declared parks, ~6K globally)
 *   - boundary=protected_area (IUCN protected areas, ~128K globally)
 *   - leisure=nature_reserve (wildlife/flora reserves, ~148K globally)
 *   - natural=scrub (shrubland/brushland, 5.4M globally)
 *   - boundary=forest (named delimited forests)
 *   - leisure=park + large area (state parks, regional parks)
 *
 * Enrichment tags: leaf_type, leaf_cycle, access, operator, protect_class,
 *                  protection_title, name, managed, species, foot access
 */
const { haversine, overpassQuery } = require('./utils');

// ═══════════════════════════════════════════════════════════════════
// WILDERNESS AREA TYPES
// ═══════════════════════════════════════════════════════════════════
const WOODS_TYPES = {
  dense_forest:     { label: 'Dense Forest',          icon: 'fa-tree',           color: '#166534', stealth: 5 },
  mixed_forest:     { label: 'Mixed Forest',          icon: 'fa-tree',           color: '#15803d', stealth: 5 },
  deciduous_forest: { label: 'Deciduous Forest',      icon: 'fa-tree',           color: '#22c55e', stealth: 4 },
  managed_forest:   { label: 'Managed Forest',        icon: 'fa-tree',           color: '#4ade80', stealth: 4 },
  scrubland:        { label: 'Scrubland / Brush',     icon: 'fa-seedling',       color: '#a3e635', stealth: 3 },
  national_park:    { label: 'National Park',         icon: 'fa-flag',           color: '#059669', stealth: 3 },
  state_park:       { label: 'State / Regional Park', icon: 'fa-map',            color: '#0d9488', stealth: 3 },
  nature_reserve:   { label: 'Nature Reserve',        icon: 'fa-leaf',           color: '#14b8a6', stealth: 3 },
  wilderness_area:  { label: 'Wilderness Area',       icon: 'fa-mountain',       color: '#065f46', stealth: 5 },
  protected_area:   { label: 'Protected Area',        icon: 'fa-shield-halved',  color: '#047857', stealth: 3 },
  blm_usfs_land:    { label: 'Public Land (BLM/USFS)',icon: 'fa-campground',     color: '#ca8a04', stealth: 5 },
  heath:            { label: 'Heath / Moorland',     icon: 'fa-seedling',       color: '#84cc16', stealth: 3 },
  grassland:        { label: 'Grassland / Prairie',   icon: 'fa-wind',           color: '#a3e635', stealth: 2 },
  meadow:           { label: 'Meadow / Clearing',     icon: 'fa-sun',            color: '#fbbf24', stealth: 2 },
};

// ═══════════════════════════════════════════════════════════════════
// OVERPASS QUERY — Wilderness areas around a point
// ═══════════════════════════════════════════════════════════════════

function buildWoodsQuery(lat, lon, radiusMeters) {
  return `
[out:json][timeout:40];
(
  // ── Dense forests & woodland ──
  way["natural"="wood"](around:${radiusMeters},${lat},${lon});
  relation["natural"="wood"](around:${radiusMeters},${lat},${lon});

  // ── Managed forest / timber land ──
  way["landuse"="forest"](around:${radiusMeters},${lat},${lon});
  relation["landuse"="forest"](around:${radiusMeters},${lat},${lon});

  // ── National parks ──
  way["boundary"="national_park"](around:${radiusMeters},${lat},${lon});
  relation["boundary"="national_park"](around:${radiusMeters},${lat},${lon});

  // ── Protected areas (IUCN categories — wilderness, state forests, etc.) ──
  way["boundary"="protected_area"](around:${radiusMeters},${lat},${lon});
  relation["boundary"="protected_area"](around:${radiusMeters},${lat},${lon});

  // ── Nature reserves ──
  way["leisure"="nature_reserve"](around:${radiusMeters},${lat},${lon});
  relation["leisure"="nature_reserve"](around:${radiusMeters},${lat},${lon});

  // ── Scrubland / brushland (transitional areas, often near forests) ──
  way["natural"="scrub"](around:${radiusMeters},${lat},${lon});

  // ── Named delimited forests (boundary=forest) ──
  way["boundary"="forest"](around:${radiusMeters},${lat},${lon});
  relation["boundary"="forest"](around:${radiusMeters},${lat},${lon});

  // ── Large parks (state parks, regional parks) ──
  way["leisure"="park"]["name"~"State Park|National Forest|Regional Park|County Park|Wildlife Area|Natural Area"](around:${radiusMeters},${lat},${lon});
  relation["leisure"="park"]["name"~"State Park|National Forest|Regional Park|County Park|Wildlife Area|Natural Area"](around:${radiusMeters},${lat},${lon});

  // ── BLM / USFS / DNR managed land (operator tags) ──
  way["boundary"="protected_area"]["operator"~"BLM|Bureau of Land Management|USFS|Forest Service|DNR|Fish and Wildlife"](around:${radiusMeters},${lat},${lon});
  relation["boundary"="protected_area"]["operator"~"BLM|Bureau of Land Management|USFS|Forest Service|DNR|Fish and Wildlife"](around:${radiusMeters},${lat},${lon});

  // ── Heath / moorland (open heath, often in highlands/coastal areas) ──
  way["natural"="heath"](around:${radiusMeters},${lat},${lon});

  // ── Grassland / prairie (open wild grassland areas) ──
  way["natural"="grassland"](around:${radiusMeters},${lat},${lon});

  // ── Meadows / clearings (open areas in or near woodland) ──
  way["landuse"="meadow"]["name"](around:${radiusMeters},${lat},${lon});
);
out center body;
>;
out skel qt;
`;
}

// ═══════════════════════════════════════════════════════════════════
// CLASSIFICATION
// ═══════════════════════════════════════════════════════════════════

function classifyWoods(tags) {
  const natural = tags.natural || '';
  const landuse = tags.landuse || '';
  const boundary = tags.boundary || '';
  const leisure = tags.leisure || '';
  const protectClass = tags.protect_class || '';
  const operator = (tags.operator || '').toLowerCase();
  const name = (tags.name || '').toLowerCase();
  const leafType = tags.leaf_type || '';
  const leafCycle = tags.leaf_cycle || '';

  // BLM / USFS / DNR public land
  if (operator.includes('blm') || operator.includes('bureau of land management') ||
      operator.includes('forest service') || operator.includes('usfs') ||
      operator.includes('dnr') || operator.includes('fish and wildlife') ||
      name.includes('national forest') || name.includes('blm')) {
    return 'blm_usfs_land';
  }

  // National park
  if (boundary === 'national_park') return 'national_park';

  // Wilderness areas (IUCN Category Ib or name contains "wilderness")
  if (protectClass === '1b' || protectClass === '1' || name.includes('wilderness')) {
    return 'wilderness_area';
  }

  // State / regional parks
  if ((leisure === 'park' || boundary === 'protected_area') &&
      (name.includes('state park') || name.includes('regional park') ||
       name.includes('county park') || protectClass === '21')) {
    return 'state_park';
  }

  // Nature reserve
  if (leisure === 'nature_reserve') return 'nature_reserve';

  // Protected area (general)
  if (boundary === 'protected_area' || boundary === 'forest') return 'protected_area';

  // Scrubland
  if (natural === 'scrub') return 'scrubland';

  // Heath / moorland
  if (natural === 'heath') return 'heath';

  // Grassland / prairie
  if (natural === 'grassland') return 'grassland';

  // Meadow / clearing
  if (landuse === 'meadow') return 'meadow';

  // Forest classification by leaf type
  if (natural === 'wood' || landuse === 'forest') {
    if (leafType === 'needleleaved' || leafCycle === 'evergreen') return 'dense_forest';
    if (leafType === 'mixed') return 'mixed_forest';
    if (leafType === 'broadleaved' || leafCycle === 'deciduous') return 'deciduous_forest';
    if (tags.managed === 'yes' || landuse === 'forest') return 'managed_forest';
    return 'dense_forest'; // Default — most WA forests are dense
  }

  return 'mixed_forest';
}

function computeStealthRating(tags, woodsType) {
  const typeDef = WOODS_TYPES[woodsType];
  let rating = typeDef ? typeDef.stealth : 3;

  // Dense evergreen canopy = best cover
  if (tags.leaf_type === 'needleleaved' || tags.leaf_cycle === 'evergreen') rating = Math.max(rating, 5);

  // Access restrictions reduce stealth viability
  if (tags.access === 'no' || tags.access === 'private') rating = Math.max(1, rating - 2);
  if (tags.access === 'permit') rating = Math.max(1, rating - 1);

  // Foot access explicitly allowed = good
  if (tags.foot === 'yes' || tags.foot === 'designated' || tags.foot === 'permissive') rating = Math.min(5, rating + 1);

  // Fee required = less ideal
  if (tags.fee === 'yes') rating = Math.max(1, rating - 1);

  // Remote / large areas are better
  if (tags.type === 'multipolygon' || tags.type === 'boundary') rating = Math.min(5, rating + 1);

  return Math.max(1, Math.min(5, rating));
}

function buildWoodsName(tags, woodsType) {
  if (tags.name) return tags.name;
  if (tags.operator) return `${tags.operator} Land`;
  if (tags.protection_title) return tags.protection_title;
  const typeDef = WOODS_TYPES[woodsType];
  if (typeDef) return typeDef.label;
  return 'Wooded Area';
}

function buildWoodsDescription(tags, woodsType) {
  const parts = [];

  if (tags.description) parts.push(tags.description);
  if (tags.operator) parts.push(`Managed by: ${tags.operator}`);

  // Tree info
  if (tags.leaf_type) {
    const leafMap = { broadleaved: 'Broadleaf trees', needleleaved: 'Evergreen/Conifer', mixed: 'Mixed tree types' };
    parts.push(leafMap[tags.leaf_type] || tags.leaf_type);
  }
  if (tags.leaf_cycle) {
    const cycleMap = { deciduous: 'Deciduous (loses leaves)', evergreen: 'Evergreen (year-round cover)', mixed: 'Mixed canopy' };
    parts.push(cycleMap[tags.leaf_cycle] || tags.leaf_cycle);
  }
  if (tags.species || tags.genus || tags.taxon) {
    parts.push(`Species: ${tags.species || tags.genus || tags.taxon}`);
  }

  // Access info
  if (tags.access) parts.push(`Access: ${tags.access}`);
  if (tags.foot) parts.push(`Foot access: ${tags.foot}`);

  // Protection info
  if (tags.protection_title) parts.push(`Type: ${tags.protection_title}`);
  if (tags.protect_class) {
    const pcMap = {
      '1a': 'Strict Nature Reserve (IUCN Ia)', '1b': 'Wilderness Area (IUCN Ib)',
      '2': 'National Park (IUCN II)', '3': 'Natural Monument (IUCN III)',
      '4': 'Habitat Management (IUCN IV)', '5': 'Protected Landscape (IUCN V)',
      '6': 'Sustainable Use (IUCN VI)',
    };
    parts.push(pcMap[tags.protect_class] || `IUCN Class ${tags.protect_class}`);
  }

  // Camping-relevant info
  if (tags.opening_hours) parts.push(`Hours: ${tags.opening_hours}`);
  if (tags.fee === 'yes') parts.push('💰 Fee required');
  if (tags.fee === 'no') parts.push('✅ Free');
  if (tags.toilets === 'yes') parts.push('🚻 Toilets');
  if (tags.drinking_water === 'yes') parts.push('💧 Water available');
  if (tags.camping === 'yes') parts.push('⛺ Camping allowed');
  if (tags.fireplace === 'yes') parts.push('🔥 Fire pits');
  if (tags.website) parts.push(`Web: ${tags.website}`);

  // Stealth camping tips by type
  const tips = {
    dense_forest: '🌲 Dense canopy — excellent natural cover for tarp/hammock camping',
    mixed_forest: '🌳 Good tree cover — scout for evergreen groves for best concealment',
    deciduous_forest: '🍂 Seasonal cover — best mid-spring to late autumn when leafed out',
    managed_forest: '🪓 May have logging roads — watch for active operations',
    scrubland: '🌿 Low brush — limited overhead cover, better for ground camps',
    national_park: '🏞️ Designated backcountry camping may require permit. Check regulations.',
    state_park: '🏕️ State parks often allow camping in designated areas. Check for fees.',
    nature_reserve: '🦌 Often limited to foot paths — respect wildlife, leave no trace',
    wilderness_area: '🏔️ Federally designated wilderness — dispersed camping usually allowed',
    protected_area: '🛡️ Check local rules for camping/overnight access permissions',
    blm_usfs_land: '🏕️ Dispersed camping usually FREE for 14 days. Best for stealth camping.',
    heath: '🌿 Open heath — limited tree cover but often remote and rarely patrolled',
    grassland: '🌾 Open prairie — very exposed, minimal concealment. Best as transit, not camp.',
    meadow: '🌼 Open meadow/clearing — exposed but can be secluded if surrounded by trees',
  };
  if (tips[woodsType]) parts.push(tips[woodsType]);

  return parts.join(' | ') || 'Wilderness area — potential stealth camping location.';
}

function extractWoodsTags(tags, woodsType) {
  const result = [woodsType];
  if (tags.leaf_type) result.push(tags.leaf_type);
  if (tags.leaf_cycle) result.push(tags.leaf_cycle);
  if (tags.access === 'yes' || tags.access === 'permissive') result.push('public-access');
  if (tags.foot === 'yes' || tags.foot === 'designated') result.push('foot-access');
  if (tags.camping === 'yes') result.push('camping-allowed');
  if (tags.fee === 'no') result.push('free');
  if (tags.drinking_water === 'yes') result.push('water');
  if (tags.toilets === 'yes') result.push('restroom');
  return result;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN SEARCH FUNCTION
// ═══════════════════════════════════════════════════════════════════

async function findWoods(lat, lon, radiusMiles = 15) {
  const radiusMeters = Math.min(Math.round(radiusMiles * 1609.34), 30000);
  const query = buildWoodsQuery(lat, lon, radiusMeters);

  try {
    const { data } = await overpassQuery(query, 45000);

    const elements = data?.elements || [];
    const results = [];
    const seen = new Set();

    for (const el of elements) {
      const elLat = el.lat || el.center?.lat;
      const elLon = el.lon || el.center?.lon;
      if (!elLat || !elLon) continue;

      const tags = el.tags || {};

      // Must have a relevant tag
      if (!tags.natural && !tags.landuse && !tags.boundary && !tags.leisure) continue;

      // Dedup by position + name
      const name = tags.name || '';
      const key = `${elLat.toFixed(3)}-${elLon.toFixed(3)}-${name}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const woodsType = classifyWoods(tags);
      const typeDef = WOODS_TYPES[woodsType];
      const dist = haversine(lat, lon, elLat, elLon);

      results.push({
        id: `woods-${el.type}-${el.id}`,
        name: buildWoodsName(tags, woodsType),
        description: buildWoodsDescription(tags, woodsType),
        lat: elLat,
        lon: elLon,
        distanceMiles: Math.round(dist * 10) / 10,
        woodsType,
        type: typeDef.label,
        source: 'Woods',
        sourceIcon: typeDef.icon,
        icon: typeDef.icon,
        color: typeDef.color,
        reservable: false,
        url: `https://www.openstreetmap.org/${el.type}/${el.id}`,
        fee: tags.fee === 'yes' ? 'Fee required' : tags.fee === 'no' ? 'Free' : 'Unknown',
        stealthRating: computeStealthRating(tags, woodsType),
        tags: extractWoodsTags(tags, woodsType),
        amenities: [
          tags.drinking_water === 'yes' ? 'Drinking Water' : '',
          tags.toilets === 'yes' ? 'Toilets' : '',
          tags.camping === 'yes' ? 'Camping Allowed' : '',
          tags.fireplace === 'yes' ? 'Fire Pits' : '',
          tags.fee === 'no' ? 'Free Access' : '',
        ].filter(Boolean),
      });
    }

    // Sort by stealth rating (best first), then distance
    results.sort((a, b) => b.stealthRating - a.stealthRating || a.distanceMiles - b.distanceMiles);

    // Categorize
    const categorized = {};
    for (const type of Object.keys(WOODS_TYPES)) {
      categorized[type] = results.filter(r => r.woodsType === type);
    }

    return {
      woods: results,
      categorized,
      counts: Object.fromEntries(Object.entries(categorized).map(([k, v]) => [k, v.length])),
      total: results.length,
    };
  } catch (err) {
    console.error('Woods search error:', err.message);
    return { woods: [], categorized: {}, counts: {}, total: 0, error: err.message };
  }
}

module.exports = { findWoods, WOODS_TYPES };
