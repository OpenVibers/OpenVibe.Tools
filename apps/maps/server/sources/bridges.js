/**
 * ╔═══════════════════════════════════════════════════════════════════╗
 * ║               OpenVibeApp – Bridge Shelter Module                  ║
 * ║    Locate bridges for potential shelter — over roads vs rivers    ║
 * ╚═══════════════════════════════════════════════════════════════════╝
 *
 * Data Sources:
 *   1. FHWA National Bridge Inventory (NBI) via BTS ArcGIS API
 *      - Every bridge in WA state with structure type, what goes under,
 *        clearance, length, width, year built, owner, location description
 *      - Field 42B (Service Under Bridge): 1=highway, 2=railroad, 5=waterway,
 *        6=highway-railroad-waterway, 7=railroad-waterway, 8=highway-waterway, 9=other
 *      - Field 43A (Structure Kind): 1=concrete, 2=concrete continuous, 3=steel,
 *        4=steel continuous, 5=prestressed concrete, 7=wood/timber, 8=masonry, 9=aluminum
 *   2. OpenStreetMap Overpass API
 *      - Finer-grained local bridge data with name, surface, layer info
 *      - Can determine what a bridge crosses by checking nearby waterways
 */
const axios = require('axios');
const { haversine, OVERPASS_URL, overpassQuery } = require('./utils');

// ─── Constants ─────────────────────────────────────────────────────
const NBI_API = 'https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services/NTAD_National_Bridge_Inventory/FeatureServer/0/query';

// NBI Field 42B — Type of Service Under Bridge
const SERVICE_UNDER = {
  '1': { label: 'Highway', icon: 'fa-road', category: 'road', color: '#6366f1', description: 'Road passes underneath' },
  '2': { label: 'Railroad', icon: 'fa-train', category: 'railroad', color: '#f59e0b', description: 'Railroad tracks pass underneath' },
  '3': { label: 'Pedestrian/Bicycle', icon: 'fa-person-walking', category: 'path', color: '#22c55e', description: 'Pedestrian or bicycle path underneath' },
  '4': { label: 'Highway-Railroad', icon: 'fa-road', category: 'road', color: '#6366f1', description: 'Highway and railroad pass underneath' },
  '5': { label: 'Waterway', icon: 'fa-water', category: 'water', color: '#3b82f6', description: 'River, creek, or stream flows underneath' },
  '6': { label: 'Hwy-Rail-Waterway', icon: 'fa-water', category: 'water', color: '#3b82f6', description: 'Highway, railroad, and waterway underneath' },
  '7': { label: 'Rail-Waterway', icon: 'fa-water', category: 'water', color: '#3b82f6', description: 'Railroad and waterway underneath' },
  '8': { label: 'Hwy-Waterway', icon: 'fa-water', category: 'water', color: '#3b82f6', description: 'Highway and waterway underneath' },
  '9': { label: 'Other', icon: 'fa-bridge', category: 'other', color: '#94a3b8', description: 'Drainage, valley, or other crossing' },
  '0': { label: 'Other', icon: 'fa-bridge', category: 'other', color: '#94a3b8', description: 'Unspecified crossing type' },
};

// NBI Field 43A — Structure Material/Design Kind
const STRUCTURE_KIND = {
  '1': 'Concrete',
  '2': 'Concrete (continuous)',
  '3': 'Steel',
  '4': 'Steel (continuous)',
  '5': 'Prestressed Concrete',
  '6': 'Prestressed Concrete (cont.)',
  '7': 'Wood / Timber',
  '8': 'Masonry',
  '9': 'Aluminum/Wrought Iron/Cast Iron',
  '0': 'Other',
};

// NBI Field 43B — Structure Type
const STRUCTURE_TYPE = {
  '01': 'Slab', '02': 'Stringer/Multi-beam', '03': 'Girder/Floorbeam',
  '04': 'Tee Beam', '05': 'Box Beam (multiple)', '06': 'Box Beam (single/spread)',
  '07': 'Frame', '08': 'Orthotropic', '09': 'Truss (deck)', '10': 'Truss (thru)',
  '11': 'Arch (deck)', '12': 'Arch (thru)', '13': 'Suspension', '14': 'Stayed Girder',
  '15': 'Movable (lift)', '16': 'Movable (bascule)', '17': 'Movable (swing)',
  '18': 'Tunnel', '19': 'Culvert', '20': 'Mixed Types', '21': 'Segmental Box Girder',
  '22': 'Channel Beam', '00': 'Other',
};

// NBI Owner codes
const OWNER_CODE = {
  '01': 'State Highway', '02': 'County Highway', '03': 'Town/Township',
  '04': 'City/Municipal', '11': 'State Park', '12': 'Federal - Forest Service',
  '21': 'Other Federal', '25': 'Other State', '26': 'Private',
  '27': 'Railroad', '31': 'State Toll', '32': 'Local Toll',
  '60': 'Other Local', '62': 'County Toll', '64': 'City Toll',
  '66': 'Special District', '68': 'Other', '69': 'Bureau of Reclamation',
  '70': 'Tribal', '73': 'Military/Corps of Engineers', '74': 'Federal - Other',
  '80': 'Unknown',
};

// ─── Parse NBI lat/lon (format: DDMMSSXX → decimal degrees) ───────
function parseNbiCoord(raw, isLon) {
  if (!raw) return 0;
  const s = raw.toString().padStart(isLon ? 9 : 8, '0');
  if (isLon) {
    const deg = parseInt(s.slice(0, 3));
    const min = parseInt(s.slice(3, 5));
    const sec = parseInt(s.slice(5, 7));
    const hSec = parseInt(s.slice(7, 9));
    return -(deg + min / 60 + (sec + hSec / 100) / 3600);
  } else {
    const deg = parseInt(s.slice(0, 2));
    const min = parseInt(s.slice(2, 4));
    const sec = parseInt(s.slice(4, 6));
    const hSec = parseInt(s.slice(6, 8));
    return deg + min / 60 + (sec + hSec / 100) / 3600;
  }
}

// ─── Shelter Score (higher = better for camping under) ─────────────
function calculateShelterScore(bridge) {
  let score = 40; // base

  // Bridges over waterways tend to have more room underneath & natural cover
  if (['water'].includes(bridge.underCategory)) score += 15;
  if (['road'].includes(bridge.underCategory)) score += 5;
  if (['railroad'].includes(bridge.underCategory)) score -= 5;

  // Longer bridges = more sheltered space
  if (bridge.lengthMeters > 100) score += 15;
  else if (bridge.lengthMeters > 50) score += 10;
  else if (bridge.lengthMeters > 20) score += 5;

  // Wider bridges = more cover from rain
  if (bridge.widthMeters > 12) score += 15;
  else if (bridge.widthMeters > 8) score += 10;
  else if (bridge.widthMeters > 5) score += 5;

  // Good vertical clearance (can stand/sit underneath)
  if (bridge.clearanceMeters && bridge.clearanceMeters > 5) score += 10;
  else if (bridge.clearanceMeters && bridge.clearanceMeters > 3) score += 5;

  // Concrete/steel better rain shelter than wood
  if (['Concrete', 'Concrete (continuous)', 'Prestressed Concrete', 'Prestressed Concrete (cont.)'].includes(bridge.material)) score += 5;
  if (['Steel', 'Steel (continuous)'].includes(bridge.material)) score += 3;

  // Pedestrian/path bridges = less traffic noise
  if (bridge.underCategory === 'path') score += 10;

  // Points for features description containing creek/river
  const fd = (bridge.featureCrossed || '').toLowerCase();
  if (fd.includes('creek') || fd.includes('river') || fd.includes('stream')) score += 5;

  // Bridges on minor roads are quieter
  const fc = (bridge.facilityCarried || '').toLowerCase();
  if (fc.includes('trail') || fc.includes('path') || fc.includes('pedestrian')) score += 10;

  // Covered bridges are amazing rain shelter!
  if (bridge.isCovered) score += 20;

  // Trestle and viaduct bridges have large underneath areas
  const bt = (bridge.osmBridgeType || bridge.structureType || '').toLowerCase();
  if (bt.includes('trestle') || bt.includes('viaduct')) score += 10;

  // Boardwalks are less useful for shelter
  if (bt.includes('boardwalk')) score -= 10;

  return Math.max(0, Math.min(100, score));
}

// ═══════════════════════════════════════════════════════════════════
// SOURCE 1: FHWA National Bridge Inventory (BTS ArcGIS)
// ═══════════════════════════════════════════════════════════════════
async function fetchNbiBridges(lat, lon, radiusMiles = 5) {
  try {
    // Build bounding box
    const latDelta = radiusMiles / 69.0;
    const lonDelta = radiusMiles / (69.0 * Math.cos((lat * Math.PI) / 180));
    const bbox = {
      xmin: lon - lonDelta,
      ymin: lat - latDelta,
      xmax: lon + lonDelta,
      ymax: lat + latDelta,
    };

    const params = {
      where: '1=1', // All states — spatial filter handles locality
      geometry: `${bbox.xmin},${bbox.ymin},${bbox.xmax},${bbox.ymax}`,
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: [
        'STRUCTURE_NUMBER_008', 'FEATURES_DESC_006A', 'FACILITY_CARRIED_007',
        'LOCATION_009', 'LAT_016', 'LONG_017', 'YEAR_BUILT_027',
        'STRUCTURE_KIND_043A', 'STRUCTURE_TYPE_043B',
        'SERVICE_ON_042A', 'SERVICE_UND_042B',
        'MIN_VERT_CLR_010', 'STRUCTURE_LEN_MT_049', 'DECK_WIDTH_MT_052',
        'OWNER_022', 'TRAFFIC_LANES_ON_028A', 'TRAFFIC_LANES_UND_028B',
      ].join(','),
      outSR: '4326',
      resultRecordCount: 200,
      f: 'json',
    };

    const resp = await axios.get(NBI_API, { params, timeout: 15000 });
    if (!resp.data || !resp.data.features) return [];

    return resp.data.features.map(f => {
      const a = f.attributes;
      const geom = f.geometry;
      const bLat = geom ? geom.y : parseNbiCoord(a.LAT_016, false);
      const bLon = geom ? geom.x : parseNbiCoord(a.LONG_017, true);
      if (!bLat || !bLon) return null;

      const serviceUnder = SERVICE_UNDER[a.SERVICE_UND_042B] || SERVICE_UNDER['9'];
      const clearance = a.MIN_VERT_CLR_010 && a.MIN_VERT_CLR_010 < 99 ? a.MIN_VERT_CLR_010 : null;

      return {
        id: `nbi-${a.STRUCTURE_NUMBER_008}`,
        source: 'nbi',
        structureNumber: a.STRUCTURE_NUMBER_008,
        name: generateBridgeName(a),
        featureCrossed: (a.FEATURES_DESC_006A || '').trim(),
        facilityCarried: (a.FACILITY_CARRIED_007 || '').trim(),
        location: (a.LOCATION_009 || '').trim(),
        lat: bLat,
        lon: bLon,
        yearBuilt: a.YEAR_BUILT_027 || null,
        material: STRUCTURE_KIND[a.STRUCTURE_KIND_043A] || 'Unknown',
        structureType: STRUCTURE_TYPE[a.STRUCTURE_TYPE_043B] || 'Unknown',
        serviceUnder: serviceUnder.label,
        underCategory: serviceUnder.category,
        underIcon: serviceUnder.icon,
        underColor: serviceUnder.color,
        underDescription: serviceUnder.description,
        clearanceMeters: clearance,
        clearanceFeet: clearance ? (clearance * 3.281).toFixed(1) : null,
        lengthMeters: a.STRUCTURE_LEN_MT_049 || 0,
        lengthFeet: a.STRUCTURE_LEN_MT_049 ? (a.STRUCTURE_LEN_MT_049 * 3.281).toFixed(0) : '0',
        widthMeters: a.DECK_WIDTH_MT_052 || 0,
        widthFeet: a.DECK_WIDTH_MT_052 ? (a.DECK_WIDTH_MT_052 * 3.281).toFixed(0) : '0',
        owner: OWNER_CODE[a.OWNER_022] || 'Unknown',
        lanesOn: parseInt(a.TRAFFIC_LANES_ON_028A) || 0,
        lanesUnder: parseInt(a.TRAFFIC_LANES_UND_028B) || 0,
        distanceMiles: haversine(lat, lon, bLat, bLon),
      };
    }).filter(Boolean);
  } catch (err) {
    console.warn('NBI bridge query error:', err.message);
    return [];
  }
}

function generateBridgeName(attrs) {
  const feature = (attrs.FEATURES_DESC_006A || '').trim();
  const facility = (attrs.FACILITY_CARRIED_007 || '').trim();
  if (feature && facility) return `${facility} over ${feature}`;
  if (facility) return `${facility} Bridge`;
  if (feature) return `Bridge over ${feature}`;
  return 'Unnamed Bridge';
}

// ═══════════════════════════════════════════════════════════════════
// SOURCE 2: OpenStreetMap Overpass (comprehensive bridge query)
// ═══════════════════════════════════════════════════════════════════
function buildOverpassQuery(lat, lon, radiusMeters) {
  return `
[out:json][timeout:30];
(
  // ── Bridge outlines (larger structures mapped as areas) ──
  way["man_made"="bridge"](around:${radiusMeters},${lat},${lon});
  relation["man_made"="bridge"](around:${radiusMeters},${lat},${lon});

  // ── Standard highway bridges (7.15M globally) ──
  way["bridge"="yes"]["highway"](around:${radiusMeters},${lat},${lon});

  // ── Covered bridges — excellent rain shelter! ──
  way["bridge"="covered"](around:${radiusMeters},${lat},${lon});

  // ── Viaducts — large multi-span bridges, lots of room underneath ──
  way["bridge"="viaduct"](around:${radiusMeters},${lat},${lon});

  // ── Trestle bridges — old railroad/road trestle structures ──
  way["bridge"="trestle"](around:${radiusMeters},${lat},${lon});

  // ── Boardwalk bridges — plank walkways over water/wetlands ──
  way["bridge"="boardwalk"](around:${radiusMeters},${lat},${lon});

  // ── Cantilever bridges — large structural bridges ──
  way["bridge"="cantilever"](around:${radiusMeters},${lat},${lon});

  // ── Movable bridges (lift, bascule, swing) ──
  way["bridge"="movable"](around:${radiusMeters},${lat},${lon});

  // ── Aqueduct bridges — carry water channels over valleys/roads ──
  way["bridge"="aqueduct"](around:${radiusMeters},${lat},${lon});

  // ── Low-water crossings — ford-like shallow crossings ──
  way["bridge"="low_water_crossing"](around:${radiusMeters},${lat},${lon});

  // ── Pedestrian / footway bridges (great stealth — less traffic) ──
  way["bridge"="yes"]["highway"="footway"](around:${radiusMeters},${lat},${lon});
  way["bridge"="yes"]["highway"="cycleway"](around:${radiusMeters},${lat},${lon});
  way["bridge"="yes"]["highway"="path"](around:${radiusMeters},${lat},${lon});
  way["bridge"="yes"]["highway"="pedestrian"](around:${radiusMeters},${lat},${lon});
  way["bridge"="yes"]["highway"="steps"](around:${radiusMeters},${lat},${lon});

  // ── Railway bridges (bridges carrying railroad tracks) ──
  way["bridge"="yes"]["railway"](around:${radiusMeters},${lat},${lon});
  way["bridge"="viaduct"]["railway"](around:${radiusMeters},${lat},${lon});

  // ── Bridges on service/residential/unclassified roads ──
  way["bridge"="yes"]["highway"="service"](around:${radiusMeters},${lat},${lon});
  way["bridge"="yes"]["highway"="residential"](around:${radiusMeters},${lat},${lon});
  way["bridge"="yes"]["highway"="unclassified"](around:${radiusMeters},${lat},${lon});
  way["bridge"="yes"]["highway"="track"](around:${radiusMeters},${lat},${lon});
);
out center body;`;
}

async function fetchOverpassBridges(lat, lon, radiusMeters = 8000) {
  try {
    const query = buildOverpassQuery(lat, lon, radiusMeters);
    const resp = await overpassQuery(query, 35000);

    if (!resp.data || !resp.data.elements) return [];

    return resp.data.elements.map(el => {
      const tags = el.tags || {};
      const elLat = el.lat || (el.center && el.center.lat) || 0;
      const elLon = el.lon || (el.center && el.center.lon) || 0;
      if (!elLat || !elLon) return null;

      // Determine what goes under
      let underCategory = 'other';
      let featureCrossed = '';
      const name = tags.name || tags['bridge:name'] || tags['bridge:ref'] || '';
      const hwType = tags.highway || '';
      const rwType = tags.railway || '';
      const bridgeType = tags.bridge || '';

      // Check name and description for water clues
      const combinedText = (name + ' ' + (tags.description || '') + ' ' + (tags['bridge:name'] || '')).toLowerCase();
      if (combinedText.includes('creek') || combinedText.includes('river') ||
          combinedText.includes('stream') || combinedText.includes('canal') ||
          combinedText.includes('falls') || combinedText.includes('fork') ||
          combinedText.includes('lake') || combinedText.includes('wash') ||
          combinedText.includes('slough') || combinedText.includes('bayou') ||
          combinedText.includes('branch') || combinedText.includes('run') ||
          combinedText.includes('brook') || combinedText.includes('cove')) {
        underCategory = 'water';
        featureCrossed = name || 'Waterway';
      } else if (bridgeType === 'aqueduct') {
        underCategory = 'water';
        featureCrossed = 'Aqueduct';
      } else if (bridgeType === 'viaduct') {
        underCategory = 'road';
        featureCrossed = 'Valley / Road';
      } else if (bridgeType === 'low_water_crossing') {
        underCategory = 'water';
        featureCrossed = 'Low Water Crossing';
      } else if (rwType) {
        underCategory = 'railroad';
        featureCrossed = rwType === 'rail' ? 'Railroad' : rwType;
      } else if (hwType === 'footway' || hwType === 'cycleway' || hwType === 'path' ||
                 hwType === 'pedestrian' || hwType === 'steps') {
        underCategory = 'path';
        featureCrossed = 'Pedestrian/Bicycle Path';
      }

      // Determine bridge type label for enrichment
      const bridgeTypeLabel = bridgeType === 'covered' ? 'Covered Bridge' :
            bridgeType === 'viaduct' ? 'Viaduct' :
            bridgeType === 'trestle' ? 'Trestle Bridge' :
            bridgeType === 'boardwalk' ? 'Boardwalk' :
            bridgeType === 'cantilever' ? 'Cantilever Bridge' :
            bridgeType === 'movable' ? 'Movable Bridge' :
            bridgeType === 'aqueduct' ? 'Aqueduct Bridge' :
            bridgeType === 'low_water_crossing' ? 'Low Water Crossing' :
            tags['bridge:structure'] || '';

      // Build display name
      let displayName = name;
      if (!displayName) {
        const typePrefix = hwType ? hwType.charAt(0).toUpperCase() + hwType.slice(1) :
                          rwType ? 'Railway' : '';
        const bridgeSuffix = bridgeTypeLabel || 'Bridge';
        displayName = typePrefix ? `${typePrefix} ${bridgeSuffix}` : bridgeSuffix;
      }

      return {
        id: `osm-bridge-${el.id}`,
        source: 'osm',
        name: displayName,
        featureCrossed,
        facilityCarried: hwType ? `${hwType} road` : rwType ? `${rwType} railway` : '',
        location: '',
        lat: elLat,
        lon: elLon,
        yearBuilt: tags.start_date ? parseInt(tags.start_date) : null,
        material: tags['bridge:material'] || tags.material || tags['bridge:support'] || '',
        structureType: bridgeTypeLabel || tags['bridge:structure'] || '',
        serviceUnder: underCategory === 'water' ? 'Waterway' :
                      underCategory === 'road' ? 'Highway' :
                      underCategory === 'railroad' ? 'Railroad' :
                      underCategory === 'path' ? 'Pedestrian' : 'Other',
        underCategory,
        underIcon: underCategory === 'water' ? 'fa-water' :
                   underCategory === 'road' ? 'fa-road' :
                   underCategory === 'railroad' ? 'fa-train' :
                   underCategory === 'path' ? 'fa-person-walking' : 'fa-bridge',
        underColor: underCategory === 'water' ? '#3b82f6' :
                    underCategory === 'road' ? '#6366f1' :
                    underCategory === 'railroad' ? '#f59e0b' :
                    underCategory === 'path' ? '#22c55e' : '#94a3b8',
        underDescription: bridgeTypeLabel ? `${bridgeTypeLabel}${featureCrossed ? ' over ' + featureCrossed : ''}` : '',
        clearanceMeters: tags.maxheight ? parseFloat(tags.maxheight) : null,
        clearanceFeet: tags.maxheight ? (parseFloat(tags.maxheight) * 3.281).toFixed(1) : null,
        lengthMeters: tags.length ? parseFloat(tags.length) : 0,
        lengthFeet: tags.length ? (parseFloat(tags.length) * 3.281).toFixed(0) : '0',
        widthMeters: tags.width ? parseFloat(tags.width) : 0,
        widthFeet: tags.width ? (parseFloat(tags.width) * 3.281).toFixed(0) : '0',
        owner: tags.operator || '',
        lanesOn: tags.lanes ? parseInt(tags.lanes) : 0,
        lanesUnder: 0,
        distanceMiles: haversine(lat, lon, elLat, elLon),
        osmHighway: hwType,
        osmBridgeType: bridgeType,
        isCovered: bridgeType === 'covered' || tags.covered === 'yes',
      };
    }).filter(Boolean);
  } catch (err) {
    console.warn('Overpass bridge query error:', err.message);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════
// COMBINED SEARCH — Merge NBI + OSM, deduplicate, score
// ═══════════════════════════════════════════════════════════════════
async function findBridges(lat, lon, radiusMiles = 5, filters = {}) {
  const radiusMeters = radiusMiles * 1609.344;

  const [nbiResults, osmResults] = await Promise.all([
    fetchNbiBridges(lat, lon, radiusMiles),
    fetchOverpassBridges(lat, lon, radiusMeters),
  ]);

  // NBI is the primary source; merge OSM names/details into NBI entries
  const merged = [...nbiResults];

  for (const osmBridge of osmResults) {
    // Check if this OSM bridge matches an NBI bridge (within ~80m)
    const nbiMatch = merged.find(nbi =>
      haversine(nbi.lat, nbi.lon, osmBridge.lat, osmBridge.lon) < 0.05
    );
    if (nbiMatch) {
      // Enrich NBI with OSM name if NBI name is generic
      if (osmBridge.name && !nbiMatch.name.includes(' over ')) {
        nbiMatch.osmName = osmBridge.name;
      }
      if (osmBridge.material && !nbiMatch.material) {
        nbiMatch.material = osmBridge.material;
      }
    } else {
      // Unique OSM bridge — add it
      merged.push(osmBridge);
    }
  }

  // Calculate shelter scores
  const scored = merged.map(b => {
    b.shelterScore = calculateShelterScore(b);
    b.walkingMinutes = Math.round(b.distanceMiles * 20);
    return b;
  });

  // Apply filters
  let filtered = scored;
  if (filters.category && filters.category !== 'all') {
    filtered = filtered.filter(b => b.underCategory === filters.category);
  }
  if (filters.minClearance) {
    filtered = filtered.filter(b => b.clearanceMeters && b.clearanceMeters >= filters.minClearance);
  }
  if (filters.minLength) {
    filtered = filtered.filter(b => b.lengthMeters >= filters.minLength);
  }
  if (filters.minScore) {
    filtered = filtered.filter(b => b.shelterScore >= filters.minScore);
  }

  // Sort
  const sortBy = filters.sortBy || 'distance';
  if (sortBy === 'score') {
    filtered.sort((a, b) => b.shelterScore - a.shelterScore);
  } else if (sortBy === 'size') {
    filtered.sort((a, b) => (b.lengthMeters * b.widthMeters) - (a.lengthMeters * a.widthMeters));
  } else {
    filtered.sort((a, b) => a.distanceMiles - b.distanceMiles);
  }

  // Summary
  const summary = {
    total: filtered.length,
    overWater: filtered.filter(b => b.underCategory === 'water').length,
    overRoad: filtered.filter(b => b.underCategory === 'road').length,
    overRail: filtered.filter(b => b.underCategory === 'railroad').length,
    overPath: filtered.filter(b => b.underCategory === 'path').length,
    overOther: filtered.filter(b => b.underCategory === 'other').length,
    withClearance: filtered.filter(b => b.clearanceMeters && b.clearanceMeters > 3).length,
    highScore: filtered.filter(b => b.shelterScore >= 70).length,
    sources: { nbi: nbiResults.length, osm: osmResults.length },
  };

  return { bridges: filtered, summary };
}

module.exports = {
  findBridges,
  fetchNbiBridges,
  fetchOverpassBridges,
  SERVICE_UNDER,
  STRUCTURE_KIND,
  STRUCTURE_TYPE,
};
