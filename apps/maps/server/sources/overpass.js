/**
 * Overpass (OpenStreetMap) Module
 * Queries the Overpass API for camping-relevant features in Washington State:
 *   - tourism=camp_site (campgrounds)
 *   - tourism=camp_pitch (individual camping spots)
 *   - tourism=wilderness_hut (backcountry shelters)
 *   - amenity=shelter (shelters, gazebos)
 *   - leisure=nature_reserve (nature reserves)
 *   - boundary=national_park / protected_area
 *   - tourism=picnic_site
 *
 * Overpass API: https://overpass-api.de/api/interpreter
 */
const axios = require('axios');
const { haversine, OVERPASS_URL, overpassQuery } = require('./utils');

/**
 * Build Overpass QL query for camping-relevant features around a point.
 * Comprehensive coverage of all rain-sheltered sleeping locations.
 */
function buildQuery(lat, lon, radiusMeters) {
  return `
[out:json][timeout:45];
(
  // ── Campgrounds & camp sites ──
  node["tourism"="camp_site"](around:${radiusMeters},${lat},${lon});
  way["tourism"="camp_site"](around:${radiusMeters},${lat},${lon});
  node["tourism"="camp_pitch"](around:${radiusMeters},${lat},${lon});

  // ── Wilderness huts / backcountry shelters ──
  node["tourism"="wilderness_hut"](around:${radiusMeters},${lat},${lon});
  way["tourism"="wilderness_hut"](around:${radiusMeters},${lat},${lon});
  node["tourism"="alpine_hut"](around:${radiusMeters},${lat},${lon});
  way["tourism"="alpine_hut"](around:${radiusMeters},${lat},${lon});

  // ── General shelters (gazebos, bus shelters, picnic shelters) ──
  node["amenity"="shelter"](around:${radiusMeters},${lat},${lon});
  way["amenity"="shelter"](around:${radiusMeters},${lat},${lon});

  // ── Picnic sites (potential stealth spots, often have covered shelters) ──
  node["tourism"="picnic_site"](around:${radiusMeters},${lat},${lon});
  way["tourism"="picnic_site"](around:${radiusMeters},${lat},${lon});

  // ── Caves & rock overhangs (natural rain cover) ──
  node["natural"="cave_entrance"](around:${radiusMeters},${lat},${lon});
  way["natural"="cave_entrance"](around:${radiusMeters},${lat},${lon});

  // ── Covered structures — pavilions, roof-only buildings, carports ──
  node["building"="pavilion"](around:${radiusMeters},${lat},${lon});
  way["building"="pavilion"](around:${radiusMeters},${lat},${lon});
  node["building"="roof"](around:${radiusMeters},${lat},${lon});
  way["building"="roof"](around:${radiusMeters},${lat},${lon});

  // ── Bandstands / gazebos ──
  node["leisure"="bandstand"](around:${radiusMeters},${lat},${lon});
  way["leisure"="bandstand"](around:${radiusMeters},${lat},${lon});
  node["building"="gazebo"](around:${radiusMeters},${lat},${lon});
  way["building"="gazebo"](around:${radiusMeters},${lat},${lon});

  // ── Parking garages (multi-storey — dry, often open 24/7) ──
  node["amenity"="parking"]["parking"="multi-storey"](around:${radiusMeters},${lat},${lon});
  way["amenity"="parking"]["parking"="multi-storey"](around:${radiusMeters},${lat},${lon});

  // ── Tunnels & covered passages ──
  way["tunnel"="building_passage"](around:${radiusMeters},${lat},${lon});
  node["man_made"="tunnel"](around:${radiusMeters},${lat},${lon});
  way["man_made"="tunnel"](around:${radiusMeters},${lat},${lon});

  // ── Nature reserves and protected areas ──
  way["leisure"="nature_reserve"](around:${radiusMeters},${lat},${lon});
  relation["leisure"="nature_reserve"](around:${radiusMeters},${lat},${lon});

  // ── Forests / woods (rain cover under dense canopy) ──
  way["natural"="wood"](around:${radiusMeters},${lat},${lon});
  way["landuse"="forest"](around:${radiusMeters},${lat},${lon});

  // ── Beaches (natural sand/gravel near water — great for camping) ──
  node["natural"="beach"](around:${radiusMeters},${lat},${lon});
  way["natural"="beach"](around:${radiusMeters},${lat},${lon});

  // ── Scrubland / bushes (concealment for stealth camping) ──
  way["natural"="scrub"](around:${radiusMeters},${lat},${lon});

  // ── Heath / moorland ──
  way["natural"="heath"](around:${radiusMeters},${lat},${lon});

  // ── Drinking water sources (expanded) ──
  node["amenity"="drinking_water"](around:${radiusMeters},${lat},${lon});
  node["amenity"="water_point"](around:${radiusMeters},${lat},${lon});
  node["man_made"="water_tap"]["drinking_water"!="no"](around:${radiusMeters},${lat},${lon});
  node["natural"="spring"]["drinking_water"="yes"](around:${radiusMeters},${lat},${lon});
  node["man_made"="water_well"]["drinking_water"="yes"](around:${radiusMeters},${lat},${lon});

  // ── Public toilets ──
  node["amenity"="toilets"](around:${radiusMeters},${lat},${lon});

  // ── Rest areas (highway pull-offs with toilets/tables) ──
  node["highway"="rest_area"](around:${radiusMeters},${lat},${lon});
  way["highway"="rest_area"](around:${radiusMeters},${lat},${lon});

  // ── Phone / device charging stations ──
  node["amenity"="device_charging_station"](around:${radiusMeters},${lat},${lon});
  node["amenity"="power_supply"](around:${radiusMeters},${lat},${lon});

  // ── Hostels (cheap bunks, showers, lockers) ──
  node["tourism"="hostel"](around:${radiusMeters},${lat},${lon});
  way["tourism"="hostel"](around:${radiusMeters},${lat},${lon});

  // ── Overnight parking (Walmart, truck stops, etc.) ──
  node["amenity"="parking"]["access"!="private"]["fee"="no"](around:${radiusMeters},${lat},${lon});
  way["amenity"="parking"]["access"!="private"]["fee"="no"](around:${radiusMeters},${lat},${lon});

  // ── Caravan / RV sites (vehicle camping with hookups) ──
  node["tourism"="caravan_site"](around:${radiusMeters},${lat},${lon});
  way["tourism"="caravan_site"](around:${radiusMeters},${lat},${lon});

  // ── Dump stations for van/RV life ──
  node["amenity"="sanitary_dump_station"](around:${radiusMeters},${lat},${lon});
  way["amenity"="sanitary_dump_station"](around:${radiusMeters},${lat},${lon});
);
out center body;
>;
out skel qt;
`;
}

/**
 * Search Overpass for camping-related locations.
 */
async function search(lat, lon, radiusMiles) {
  const radiusMeters = Math.round(radiusMiles * 1609.34);

  // Cap at 40 km to keep queries fast
  const cappedRadius = Math.min(radiusMeters, 40000);

  const query = buildQuery(lat, lon, cappedRadius);

  const { data } = await overpassQuery(query, 50000);

  const elements = data?.elements || [];
  const results = [];
  const seen = new Set();

  for (const el of elements) {
    // Get coordinates (nodes have lat/lon, ways/relations have center)
    let elLat = el.lat || el.center?.lat;
    let elLon = el.lon || el.center?.lon;
    if (!elLat || !elLon) continue;

    const tags = el.tags || {};
    const tourism = tags.tourism || '';
    const amenity = tags.amenity || '';
    const leisure = tags.leisure || '';
    const natural = tags.natural || '';
    const landuse = tags.landuse || '';
    const building = tags.building || '';
    const manMade = tags.man_made || '';
    const tunnel = tags.tunnel || '';
    const parking = tags.parking || '';
    const highway = tags.highway || '';

    // Skip non-relevant elements (skeleton nodes from way expansion)
    if (!tourism && !amenity && !leisure && !natural && !landuse && !building && !manMade && !tunnel && !parking && !highway) continue;

    // Build a key for dedup
    const key = `${elLat.toFixed(4)}-${elLon.toFixed(4)}-${tags.name || el.type}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const dist = haversine(lat, lon, elLat, elLon);

    const location = {
      id: `osm-${el.type}-${el.id}`,
      name: tags.name || inferName(tags, tourism, amenity, leisure, natural, landuse),
      description: buildDescription(tags),
      lat: elLat,
      lon: elLon,
      distanceMiles: Math.round(dist * 10) / 10,
      type: classifyOSM(tourism, amenity, leisure, natural, landuse, tags, building, manMade, tunnel, parking),
      source: 'OpenStreetMap',
      sourceIcon: 'fa-map',
      reservable: tags.reservation === 'required' || tags.reservation === 'yes',
      url: `https://www.openstreetmap.org/${el.type}/${el.id}`,
      fee: tags.fee === 'yes' ? 'Fee required' : tags.fee === 'no' ? 'Free' : 'Unknown',
      stealthRating: computeOSMStealthRating(tags, tourism, amenity, leisure, natural, landuse, building, manMade, tunnel, parking),
      tags: extractOSMTags(tags),
      amenities: extractAmenities(tags),
    };

    results.push(location);
  }

  return results;
}

function inferName(tags, tourism, amenity, leisure, natural, landuse) {
  if (tags.operator) return tags.operator;
  if (tourism === 'camp_site') return 'Camping Area';
  if (tourism === 'camp_pitch') return 'Camp Pitch';
  if (tourism === 'wilderness_hut') return 'Wilderness Shelter';
  if (tourism === 'alpine_hut') return 'Alpine Hut';
  if (tourism === 'picnic_site') return 'Picnic Area';
  if (amenity === 'shelter') {
    const st = tags.shelter_type || '';
    if (st === 'picnic_shelter' || st === 'pavilion') return 'Covered Picnic Shelter';
    if (st === 'public_transport') return 'Bus Shelter';
    if (st === 'weather_shelter') return 'Weather Shelter';
    if (st === 'rock_shelter') return 'Rock Overhang Shelter';
    if (st === 'lean_to') return 'Lean-To Shelter';
    return 'Public Shelter';
  }
  if (amenity === 'drinking_water') return 'Water Source';
  if (amenity === 'water_point') return 'Water Refill Point';
  if (tags.man_made === 'water_tap') return 'Water Tap';
  if (tags.man_made === 'water_well') return 'Water Well';
  if (natural === 'spring' && tags.drinking_water === 'yes') return 'Natural Spring';
  if (amenity === 'toilets') return 'Public Restroom';
  if (tags.highway === 'rest_area') return 'Highway Rest Area';
  if (amenity === 'device_charging_station') return 'Phone Charging Station';
  if (amenity === 'power_supply') return 'Power Outlet';
  if (amenity === 'parking' && tags.parking === 'multi-storey') return 'Parking Garage';
  if (amenity === 'parking' && tags.fee === 'no') return 'Free Parking Lot';
  if (amenity === 'sanitary_dump_station') return 'Dump Station';
  if (tourism === 'hostel') return 'Hostel';
  if (tourism === 'caravan_site') return 'RV/Caravan Park';
  if (natural === 'cave_entrance') return 'Cave Entrance';
  if (tags.building === 'pavilion') return 'Pavilion';
  if (tags.building === 'roof') return 'Covered Structure';
  if (tags.building === 'gazebo') return 'Gazebo';
  if (leisure === 'bandstand') return 'Bandstand / Gazebo';
  if (tags.man_made === 'tunnel' || tags.tunnel === 'building_passage') return 'Tunnel / Covered Passage';
  if (leisure === 'nature_reserve') return 'Nature Reserve';
  if (natural === 'wood') {
    if (tags.leaf_type === 'needleleaved') return 'Evergreen Forest (Dense Canopy)';
    return 'Wooded Area';
  }
  if (landuse === 'forest') {
    if (tags.leaf_type === 'needleleaved') return 'Conifer Forest (Dense Canopy)';
    return 'Forest Area';
  }
  if (natural === 'beach') return tags.surface ? `Beach (${tags.surface})` : 'Beach';
  if (natural === 'scrub') return 'Scrubland / Bushes';
  if (natural === 'heath') return 'Heath / Moorland';
  return 'Point of Interest';
}

function classifyOSM(tourism, amenity, leisure, natural, landuse, tags, building, manMade, tunnel, parking) {
  if (tourism === 'camp_site') {
    if (tags.backcountry === 'yes') return 'Backcountry Campsite';
    return 'Campground';
  }
  if (tourism === 'camp_pitch') return 'Camp Pitch';
  if (tourism === 'wilderness_hut') return 'Wilderness Shelter';
  if (tourism === 'alpine_hut') return 'Alpine Hut';
  if (tourism === 'picnic_site') return 'Picnic Site';

  // Covered / rain-protected structures
  if (amenity === 'shelter') {
    const st = tags.shelter_type || '';
    if (st === 'picnic_shelter' || st === 'pavilion') return 'Covered Pavilion';
    if (st === 'public_transport') return 'Bus Shelter (Covered)';
    if (st === 'weather_shelter') return 'Weather Shelter';
    if (st === 'rock_shelter') return 'Rock Overhang';
    if (st === 'lean_to') return 'Lean-To Shelter';
    return 'Covered Shelter';
  }
  if (natural === 'cave_entrance') return 'Cave / Rock Overhang';
  if (building === 'pavilion') return 'Covered Pavilion';
  if (building === 'roof') return 'Covered Structure';
  if (building === 'gazebo') return 'Gazebo (Covered)';
  if (leisure === 'bandstand') return 'Bandstand (Covered)';
  if (amenity === 'parking' && parking === 'multi-storey') return 'Parking Garage (Covered)';
  if (manMade === 'tunnel' || tunnel === 'building_passage') return 'Tunnel / Passage';

  // Services & utilities
  if (amenity === 'drinking_water') return 'Water Source';
  if (amenity === 'water_point') return 'Water Refill Point';
  if (tags.man_made === 'water_tap') return 'Water Tap';
  if (tags.man_made === 'water_well') return 'Water Well';
  if (natural === 'spring' && tags.drinking_water === 'yes') return 'Natural Spring';
  if (amenity === 'toilets') return 'Restroom';
  if (tags.highway === 'rest_area') return 'Highway Rest Stop';
  if (amenity === 'device_charging_station') return 'Phone Charging';
  if (amenity === 'power_supply') return 'Power Outlet';
  if (tourism === 'hostel') return 'Hostel (Budget Sleep)';
  if (tourism === 'caravan_site') {
    if (tags.fee === 'no') return 'Free RV/Van Camping';
    return 'RV/Caravan Site';
  }
  if (amenity === 'sanitary_dump_station') return 'Dump Station (RV/Van)';
  if (amenity === 'parking' && tags.fee === 'no' && parking !== 'multi-storey') return 'Free Parking (Overnight?)';

  // Nature
  if (leisure === 'nature_reserve') return 'Nature Reserve';
  if ((natural === 'wood' || landuse === 'forest') && tags.leaf_type === 'needleleaved') return 'Dense Canopy (Evergreen)';
  if (natural === 'wood' || landuse === 'forest') return 'Wooded Area';
  if (natural === 'beach') return 'Beach';
  if (natural === 'scrub') return 'Scrubland / Bushes';
  if (natural === 'heath') return 'Heath / Moorland';

  return 'Point of Interest';
}

function computeOSMStealthRating(tags, tourism, amenity, leisure, natural, landuse, building, manMade, tunnel, parking) {
  let rating = 3;

  // Forests and woods = great for stealth camping
  if (natural === 'wood' || landuse === 'forest') rating = 5;
  // Dense evergreen canopy = best tree cover
  if ((natural === 'wood' || landuse === 'forest') && tags.leaf_type === 'needleleaved') rating = 5;

  // Scrubland / bushes — decent concealment
  if (natural === 'scrub') rating = 3;

  // Beach — exposed but can be secluded if remote
  if (natural === 'beach') rating = 3;

  // Heath — open moorland, low cover
  if (natural === 'heath') rating = 2;

  // Backcountry campsites
  if (tags.backcountry === 'yes') rating = 5;

  // Free = better for displaced people
  if (tags.fee === 'no') rating += 1;

  // Nature reserves – officially protected but sometimes allow camping
  if (leisure === 'nature_reserve') rating = 3;

  // Developed campgrounds – less stealthy but more amenities
  if (tourism === 'camp_site' && tags.fee === 'yes') rating = 2;

  // Wilderness huts = great
  if (tourism === 'wilderness_hut' || tourism === 'alpine_hut') rating = 5;

  // Caves & rock overhangs — excellent natural shelter, very stealthy
  if (natural === 'cave_entrance') rating = 5;

  // Covered structures — good rain protection
  if (amenity === 'shelter') {
    const st = tags.shelter_type || '';
    if (st === 'rock_shelter') rating = 5;
    if (st === 'lean_to') rating = 5;
    if (st === 'weather_shelter') rating = 4;
    if (st === 'picnic_shelter' || st === 'pavilion') rating = 4;
    if (st === 'public_transport') rating = 2; // bus stops too visible
    if (!st) rating = 4;
  }

  // Pavilions, gazebos, bandstands — covered but visible
  if (building === 'pavilion' || building === 'gazebo' || leisure === 'bandstand') rating = 3;

  // Roof-only structures — great cover
  if (building === 'roof') rating = 4;

  // Parking garages — dry but urban, security risk
  if (amenity === 'parking' && parking === 'multi-storey') rating = 2;

  // Tunnels — very stealthy, dry
  if (manMade === 'tunnel' || tunnel === 'building_passage') rating = 4;

  // Rest areas — legal overnight, good amenities but visible
  if (tags.highway === 'rest_area') rating = 3;

  // Phone charging / power — utility feature, not a sleep spot
  if (amenity === 'device_charging_station' || amenity === 'power_supply') rating = 1;

  // Hostels — indoors, cheap sleep, low stealth but high utility
  if (tourism === 'hostel') rating = 2;

  // Caravan/RV sites — good for vehicle dwellers
  if (tourism === 'caravan_site') rating = tags.fee === 'no' ? 4 : 2;

  // Dump stations — utility, not a sleep spot
  if (amenity === 'sanitary_dump_station') rating = 1;

  // Free parking lots — can sleep in vehicle, moderate stealth
  if (amenity === 'parking' && tags.fee === 'no' && parking !== 'multi-storey') rating = 3;

  // Water sources — support features, not sleep spots
  if (amenity === 'drinking_water' || amenity === 'toilets' || amenity === 'water_point' ||
      tags.man_made === 'water_tap' || tags.man_made === 'water_well') rating = 1;
  if (natural === 'spring') rating = 3; // springs often in remote stealthy areas

  return Math.max(1, Math.min(5, rating));
}

function extractOSMTags(tags) {
  const result = [];
  if (tags.fee === 'no') result.push('free');
  if (tags.drinking_water === 'yes') result.push('water-nearby');
  if (tags.toilets === 'yes') result.push('restroom');
  if (tags.backcountry === 'yes') result.push('backcountry');
  if (tags.tents === 'yes') result.push('tents-allowed');
  if (tags.caravans === 'yes') result.push('rv-friendly');
  if (tags.openfire === 'yes') result.push('campfire-allowed');
  if (tags.access === 'yes' || tags.access === 'permissive') result.push('public-access');
  if (tags.shelter_type) result.push(tags.shelter_type);
  if (tags.fireplace === 'yes') result.push('fireplace');
  if (tags.covered === 'yes') result.push('covered');
  if (tags.lit === 'yes') result.push('lit');
  if (tags.wheelchair === 'yes') result.push('accessible');
  if (tags.dog === 'yes') result.push('dogs-ok');
  if (tags.internet_access === 'wlan') result.push('wifi');
  if (tags.power_supply === 'yes') result.push('power');
  return result;
}

function extractAmenities(tags) {
  const amenities = [];
  if (tags.drinking_water === 'yes') amenities.push('Drinking Water');
  if (tags.toilets === 'yes') amenities.push('Toilets');
  if (tags.shower === 'yes' || tags.shower === 'hot') amenities.push('Showers');
  if (tags.bbq === 'yes') amenities.push('BBQ/Grill');
  if (tags.picnic_table === 'yes') amenities.push('Picnic Tables');
  if (tags.internet_access === 'yes' || tags.internet_access === 'wlan') amenities.push('WiFi');
  if (tags.power_supply === 'yes') amenities.push('Power Hookup');
  if (tags.fireplace === 'yes') amenities.push('Fireplace');
  if (tags.mattress === 'yes') amenities.push('Mattresses');
  if (tags.covered === 'yes') amenities.push('Covered');
  if (tags.bench === 'yes') amenities.push('Benches');
  if (tags.bin === 'yes') amenities.push('Trash Bins');
  if (tags.wheelchair === 'yes') amenities.push('Wheelchair Accessible');
  if (tags.dog === 'yes') amenities.push('Dogs Allowed');
  if (tags.tents === 'yes') amenities.push('Tents Allowed');
  if (tags.caravans === 'yes') amenities.push('RVs/Vans Allowed');
  return amenities;
}

function buildDescription(tags) {
  const parts = [];
  if (tags.description) parts.push(tags.description);
  if (tags.operator) parts.push(`Operated by: ${tags.operator}`);
  if (tags.opening_hours) parts.push(`Hours: ${tags.opening_hours}`);
  if (tags.access) parts.push(`Access: ${tags.access}`);
  if (tags.capacity) parts.push(`Capacity: ${tags.capacity}`);
  if (tags.beds) parts.push(`Beds: ${tags.beds}`);
  if (tags.fireplace === 'yes') parts.push('🔥 Fireplace/Stove');
  if (tags.mattress === 'yes') parts.push('🛏️ Mattresses');
  if (tags.wood_provided === 'yes') parts.push('🪵 Firewood provided');
  if (tags.drinking_water === 'yes') parts.push('💧 Drinking water');
  if (tags.toilets === 'yes') parts.push('🚻 Toilets');
  if (tags.shower === 'yes' || tags.shower === 'hot') parts.push('🚿 Showers');
  if (tags.covered === 'yes') parts.push('Covered/roofed');
  if (tags.shelter_type) parts.push(`Shelter: ${tags.shelter_type.replace(/_/g, ' ')}`);
  if (tags.surface) parts.push(`Surface: ${tags.surface}`);
  if (tags.fee === 'no') parts.push('✅ Free');
  if (tags.fee === 'yes' && tags.charge) parts.push(`💰 ${tags.charge}`);
  if (tags.reservation === 'required') parts.push('⚠️ Reservation required');
  if (tags.lit === 'yes') parts.push('Lit at night');
  if (tags.wheelchair === 'yes') parts.push('♿ Accessible');
  if (tags.dog === 'yes') parts.push('🐕 Dogs allowed');
  if (tags.tents === 'yes') parts.push('⛺ Tents allowed');
  if (tags.caravans === 'yes') parts.push('🚐 RVs/vans allowed');
  if (tags.internet_access === 'wlan') parts.push('📶 WiFi');
  if (tags.power_supply === 'yes') parts.push('🔌 Power hookup');
  if (tags.note) parts.push(`Note: ${tags.note}`);
  return parts.join(' | ') || 'Community-mapped location from OpenStreetMap.';
}

module.exports = { search };
