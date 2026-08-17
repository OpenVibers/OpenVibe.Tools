/**
 * OpenVibeApp – Survival Resources Module
 * Queries OpenStreetMap Overpass API for essential survival amenities:
 *   - Libraries (free WiFi, charging, warmth, restrooms)
 *   - Public showers
 *   - Laundromats
 *   - Community centers / social facilities
 *   - Drinking water sources (fountains, taps, springs)
 *   - Food banks / soup kitchens
 *   - Free WiFi hotspots
 *
 * All data sourced from OpenStreetMap via Overpass API.
 */
const axios = require('axios');
const { haversine, OVERPASS_URL, overpassQuery } = require('./utils');

// ═══════════════════════════════════════════════════════════════════
// RESOURCE CATEGORIES
// ═══════════════════════════════════════════════════════════════════
const RESOURCE_TYPES = {
  library:        { label: 'Library',           icon: 'fa-book',               color: '#8b5cf6' },
  shower:         { label: 'Public Shower',     icon: 'fa-shower',             color: '#06b6d4' },
  laundry:        { label: 'Laundromat',        icon: 'fa-shirt',              color: '#f59e0b' },
  community:      { label: 'Community Center',  icon: 'fa-people-roof',        color: '#ec4899' },
  water:          { label: 'Drinking Water',    icon: 'fa-faucet-drip',        color: '#3b82f6' },
  food_bank:      { label: 'Food Bank',         icon: 'fa-utensils',           color: '#ef4444' },
  social:         { label: 'Social Services',   icon: 'fa-hand-holding-heart', color: '#10b981' },
  wifi:           { label: 'Free WiFi',         icon: 'fa-wifi',               color: '#a855f7' },
  phone_charging: { label: 'Phone Charging',    icon: 'fa-plug',               color: '#f97316' },
  rest_area:      { label: 'Rest Area',         icon: 'fa-square-parking',     color: '#64748b' },
  bottle_return:     { label: 'Bottle Return',     icon: 'fa-recycle',            color: '#22c55e' },
  clinic:            { label: 'Free Clinic',       icon: 'fa-kit-medical',        color: '#dc2626' },
  homeless_shelter:  { label: 'Homeless Shelter',   icon: 'fa-house-chimney',      color: '#7c3aed' },
  hospital:          { label: 'Hospital / ER',      icon: 'fa-hospital',           color: '#be123c' },
  pharmacy:          { label: 'Pharmacy',           icon: 'fa-prescription',       color: '#0891b2' },
  post_office:       { label: 'Post Office',        icon: 'fa-envelope',           color: '#4338ca' },
  thrift_store:      { label: 'Thrift / Free Store', icon: 'fa-shirt',             color: '#a16207' },
  public_bookcase:   { label: 'Little Free Library', icon: 'fa-book-open',          color: '#92400e' },
  water_point:       { label: 'Water Point (Tank)',   icon: 'fa-faucet',             color: '#0284c7' },
  place_of_worship:  { label: 'Church / Worship',     icon: 'fa-church',             color: '#6366f1' },
  bus_station:       { label: 'Bus / Transit Stop',   icon: 'fa-bus',                color: '#0ea5e9' },
  gas_station:       { label: 'Gas Station',          icon: 'fa-gas-pump',           color: '#f43f5e' },
  clothing_bank:     { label: 'Clothing Bank',        icon: 'fa-vest',               color: '#d946ef' },
  day_shelter:       { label: 'Day Shelter / Drop-In',icon: 'fa-sun',                color: '#fb923c' },
  pet_friendly:      { label: 'Pet-Friendly Shelter', icon: 'fa-paw',                color: '#84cc16' },
  warming_center:    { label: 'Warming / Cooling',    icon: 'fa-temperature-half',   color: '#ef4444' },
};

// ═══════════════════════════════════════════════════════════════════
// OVERPASS QUERY
// ═══════════════════════════════════════════════════════════════════

function buildResourceQuery(lat, lon, radiusMeters) {
  return `
[out:json][timeout:35];
(
  // ── Libraries (free WiFi, warmth, charging, bathrooms) ──
  node["amenity"="library"](around:${radiusMeters},${lat},${lon});
  way["amenity"="library"](around:${radiusMeters},${lat},${lon});

  // ── Public showers ──
  node["amenity"="shower"](around:${radiusMeters},${lat},${lon});
  way["amenity"="shower"](around:${radiusMeters},${lat},${lon});

  // ── Laundromats ──
  node["shop"="laundry"](around:${radiusMeters},${lat},${lon});
  way["shop"="laundry"](around:${radiusMeters},${lat},${lon});
  node["amenity"="laundry"](around:${radiusMeters},${lat},${lon});

  // ── Community centers ──
  node["amenity"="community_centre"](around:${radiusMeters},${lat},${lon});
  way["amenity"="community_centre"](around:${radiusMeters},${lat},${lon});

  // ── Drinking water (fountains, taps, springs) ──
  node["amenity"="drinking_water"](around:${radiusMeters},${lat},${lon});
  node["natural"="spring"]["drinking_water"="yes"](around:${radiusMeters},${lat},${lon});
  node["man_made"="water_tap"]["drinking_water"!="no"](around:${radiusMeters},${lat},${lon});

  // ── Food banks, soup kitchens, social facilities ──
  node["amenity"="social_facility"](around:${radiusMeters},${lat},${lon});
  way["amenity"="social_facility"](around:${radiusMeters},${lat},${lon});
  node["amenity"="food_bank"](around:${radiusMeters},${lat},${lon});
  node["social_facility"="soup_kitchen"](around:${radiusMeters},${lat},${lon});
  node["social_facility"="food_bank"](around:${radiusMeters},${lat},${lon});

  // ── Free WiFi spots (cafés/public spaces with explicit wifi tagging) ──
  node["internet_access"="wlan"]["internet_access:fee"="no"](around:${radiusMeters},${lat},${lon});
  way["internet_access"="wlan"]["internet_access:fee"="no"](around:${radiusMeters},${lat},${lon});

  // ── Phone / device charging stations ──
  node["amenity"="device_charging_station"](around:${radiusMeters},${lat},${lon});
  node["amenity"="power_supply"](around:${radiusMeters},${lat},${lon});

  // ── Highway rest areas (toilets, tables, sometimes legal overnight) ──
  node["highway"="rest_area"](around:${radiusMeters},${lat},${lon});
  way["highway"="rest_area"](around:${radiusMeters},${lat},${lon});

  // ── Bottle return / recycling machines (earn cash from cans/bottles) ──
  node["amenity"="recycling"]["recycling_type"="reverse_vending_machine"](around:${radiusMeters},${lat},${lon});
  node["amenity"="recycling"]["recycling:cans"="yes"](around:${radiusMeters},${lat},${lon});
  node["amenity"="recycling"]["recycling:plastic_bottles"="yes"](around:${radiusMeters},${lat},${lon});

  // ── Free / community health clinics ──
  node["amenity"="clinic"]["fee"="no"](around:${radiusMeters},${lat},${lon});
  node["healthcare"="clinic"]["fee"="no"](around:${radiusMeters},${lat},${lon});
  node["amenity"="social_facility"]["social_facility"="healthcare"](around:${radiusMeters},${lat},${lon});

  // ── Homeless / emergency shelters ──
  node["amenity"="social_facility"]["social_facility"="shelter"](around:${radiusMeters},${lat},${lon});
  way["amenity"="social_facility"]["social_facility"="shelter"](around:${radiusMeters},${lat},${lon});
  node["social_facility"="shelter"](around:${radiusMeters},${lat},${lon});

  // ── Hospitals & ERs ──
  node["amenity"="hospital"](around:${radiusMeters},${lat},${lon});
  way["amenity"="hospital"](around:${radiusMeters},${lat},${lon});

  // ── Pharmacies ──
  node["amenity"="pharmacy"](around:${radiusMeters},${lat},${lon});
  way["amenity"="pharmacy"](around:${radiusMeters},${lat},${lon});

  // ── Post offices (General Delivery for mail without address) ──
  node["amenity"="post_office"](around:${radiusMeters},${lat},${lon});
  way["amenity"="post_office"](around:${radiusMeters},${lat},${lon});

  // ── Thrift stores, charity shops, free shops, give boxes ──
  node["shop"="charity"](around:${radiusMeters},${lat},${lon});
  way["shop"="charity"](around:${radiusMeters},${lat},${lon});
  node["shop"="second_hand"](around:${radiusMeters},${lat},${lon});
  way["shop"="second_hand"](around:${radiusMeters},${lat},${lon});
  node["amenity"="freeshop"](around:${radiusMeters},${lat},${lon});
  node["amenity"="give_box"](around:${radiusMeters},${lat},${lon});

  // ── Little Free Libraries / public bookcases ──
  node["amenity"="public_bookcase"](around:${radiusMeters},${lat},${lon});
  way["amenity"="public_bookcase"](around:${radiusMeters},${lat},${lon});

  // ── Water points (large fill-up for RV/van tanks) ──
  node["amenity"="water_point"](around:${radiusMeters},${lat},${lon});
  way["amenity"="water_point"](around:${radiusMeters},${lat},${lon});

  // ── Places of worship (warming centers, food, overnight in winter) ──
  node["amenity"="place_of_worship"](around:${radiusMeters},${lat},${lon});
  way["amenity"="place_of_worship"](around:${radiusMeters},${lat},${lon});

  // ── Bus / transit stations (covered, lighting, sometimes 24/7) ──
  node["amenity"="bus_station"](around:${radiusMeters},${lat},${lon});
  way["amenity"="bus_station"](around:${radiusMeters},${lat},${lon});
  node["public_transport"="station"](around:${radiusMeters},${lat},${lon});
  way["public_transport"="station"](around:${radiusMeters},${lat},${lon});

  // ── Gas stations (24/7 restrooms, warmth, water) ──
  node["amenity"="fuel"]["opening_hours"~"24"](around:${radiusMeters},${lat},${lon});
  way["amenity"="fuel"]["opening_hours"~"24"](around:${radiusMeters},${lat},${lon});

  // ── Clothing banks / donation bins ──
  node["social_facility"="clothing_bank"](around:${radiusMeters},${lat},${lon});
  node["amenity"="recycling"]["recycling:clothes"="yes"](around:${radiusMeters},${lat},${lon});

  // ── Day shelters / drop-in centers ──
  node["amenity"="social_facility"]["social_facility"="day_care"]["social_facility:for"~"homeless|underprivileged"](around:${radiusMeters},${lat},${lon});
  way["amenity"="social_facility"]["social_facility"="outreach"](around:${radiusMeters},${lat},${lon});
  node["amenity"="social_facility"]["social_facility"="outreach"](around:${radiusMeters},${lat},${lon});
);
out center body;
>;
out skel qt;
`;
}

// ═══════════════════════════════════════════════════════════════════
// PARSE RESULTS
// ═══════════════════════════════════════════════════════════════════

function classifyResource(tags) {
  const amenity = tags.amenity || '';
  const shop = tags.shop || '';
  const natural = tags.natural || '';
  const manMade = tags.man_made || '';
  const socialFacility = tags.social_facility || '';

  if (amenity === 'library') return 'library';
  if (amenity === 'shower') return 'shower';
  if (shop === 'laundry' || amenity === 'laundry') return 'laundry';
  if (amenity === 'community_centre') return 'community';
  if (amenity === 'drinking_water' || natural === 'spring' || manMade === 'water_tap') return 'water';
  if (amenity === 'food_bank' || socialFacility === 'food_bank' || socialFacility === 'soup_kitchen') return 'food_bank';
  if (amenity === 'social_facility' && tags.social_facility !== 'food_bank' && tags.social_facility !== 'soup_kitchen' && tags.social_facility !== 'healthcare') return 'social';
  if (tags.internet_access === 'wlan' && tags['internet_access:fee'] === 'no') return 'wifi';
  if (amenity === 'device_charging_station' || amenity === 'power_supply') return 'phone_charging';
  if (tags.highway === 'rest_area') return 'rest_area';
  if (amenity === 'recycling' && (tags.recycling_type === 'reverse_vending_machine' || tags['recycling:cans'] === 'yes' || tags['recycling:plastic_bottles'] === 'yes')) return 'bottle_return';
  if ((amenity === 'clinic' || tags.healthcare === 'clinic') && tags.fee === 'no') return 'clinic';
  if (amenity === 'social_facility' && tags.social_facility === 'healthcare') return 'clinic';
  if (amenity === 'social_facility' && socialFacility === 'shelter') return 'homeless_shelter';
  if (socialFacility === 'shelter') return 'homeless_shelter';
  if (amenity === 'hospital') return 'hospital';
  if (amenity === 'pharmacy') return 'pharmacy';
  if (amenity === 'post_office') return 'post_office';
  if (tags.shop === 'charity' || tags.shop === 'second_hand' || amenity === 'freeshop' || amenity === 'give_box') return 'thrift_store';
  if (amenity === 'public_bookcase') return 'public_bookcase';
  if (amenity === 'water_point') return 'water_point';
  if (amenity === 'place_of_worship') return 'place_of_worship';
  if (amenity === 'bus_station' || tags.public_transport === 'station') return 'bus_station';
  if (amenity === 'fuel' && (tags.opening_hours || '').includes('24')) return 'gas_station';
  if (socialFacility === 'clothing_bank' || (amenity === 'recycling' && tags['recycling:clothes'] === 'yes')) return 'clothing_bank';
  if (socialFacility === 'outreach' || (socialFacility === 'day_care' && (tags['social_facility:for'] || '').match(/homeless|underprivileged/))) return 'day_shelter';
  return null;
}

function buildResourceName(tags, resourceType) {
  if (tags.name) return tags.name;
  const typeDef = RESOURCE_TYPES[resourceType];
  if (typeDef) return typeDef.label;
  return 'Resource';
}

function buildResourceDescription(tags, resourceType) {
  const parts = [];

  if (tags.description) parts.push(tags.description);
  if (tags.operator) parts.push(`Operated by: ${tags.operator}`);
  if (tags.opening_hours) parts.push(`Hours: ${tags.opening_hours}`);

  // Type-specific info
  if (resourceType === 'library') {
    if (tags.internet_access === 'wlan' || tags.internet_access === 'yes') parts.push('Free WiFi');
    if (tags.air_conditioning === 'yes') parts.push('Air conditioning');
    parts.push('Typically offers: WiFi, outlets, restrooms, warmth');
  }
  if (resourceType === 'shower') {
    if (tags.fee === 'yes') parts.push('Fee required');
    else if (tags.fee === 'no') parts.push('Free');
    if (tags.hot_water === 'yes') parts.push('Hot water');
    if (tags.wheelchair === 'yes') parts.push('Wheelchair accessible');
  }
  if (resourceType === 'laundry') {
    if (tags.self_service === 'yes') parts.push('Self-service');
    if (tags.fee === 'yes') parts.push('Coin-operated');
  }
  if (resourceType === 'water') {
    if (tags.bottle === 'yes') parts.push('Bottle filling');
    if (tags.seasonal === 'yes') parts.push('Seasonal (may be off in winter)');
    if (tags.dog === 'yes' || tags.dog === 'designated') parts.push('Dog bowl available');
  }
  if (resourceType === 'food_bank') {
    if (tags.social_facility === 'soup_kitchen') parts.push('Soup kitchen — provides meals');
    else parts.push('Food distribution');
  }
  if (resourceType === 'wifi') {
    if (tags.amenity) parts.push(`At: ${tags.amenity.replace(/_/g, ' ')}`);
    parts.push('Free WiFi confirmed');
  }
  if (resourceType === 'phone_charging') {
    if (tags.fee === 'no') parts.push('Free charging');
    else if (tags.fee === 'yes') parts.push('Fee required');
    if (tags.capacity) parts.push(`${tags.capacity} slots`);
    if (tags.lockable === 'yes') parts.push('Lockable (safe to leave device)');
    parts.push('Charge your phone/device here');
  }
  if (resourceType === 'rest_area') {
    if (tags.toilets === 'yes') parts.push('Has toilets');
    if (tags.drinking_water === 'yes') parts.push('Has drinking water');
    if (tags.picnic_table === 'yes') parts.push('Picnic tables');
    if (tags.shower === 'yes') parts.push('Showers available');
    parts.push('Highway rest stop — often legal to sleep 8hrs');
  }
  if (resourceType === 'bottle_return') {
    if (tags.recycling_type === 'reverse_vending_machine') parts.push('Reverse vending machine — insert cans/bottles for cash');
    if (tags['recycling:cans'] === 'yes') parts.push('Accepts cans');
    if (tags['recycling:plastic_bottles'] === 'yes') parts.push('Accepts plastic bottles');
    if (tags['recycling:glass_bottles'] === 'yes') parts.push('Accepts glass bottles');
    parts.push('Earn money recycling — WA pays 5¢-10¢ per container');
  }
  if (resourceType === 'clinic') {
    parts.push('Free or low-cost healthcare');
    if (tags.healthcare_speciality) parts.push(`Specialty: ${tags.healthcare_speciality}`);
  }
  if (resourceType === 'homeless_shelter') {
    parts.push('Emergency or transitional shelter');
    if (tags['social_facility:for']) parts.push(`For: ${tags['social_facility:for'].replace(/;/g, ', ')}`);
    if (tags.beds) parts.push(`${tags.beds} beds`);
    if (tags.capacity) parts.push(`Capacity: ${tags.capacity}`);
  }
  if (resourceType === 'hospital') {
    if (tags.emergency === 'yes') parts.push('Has ER / Emergency Room');
    else parts.push('Hospital — may have ER');
    if (tags.beds) parts.push(`${tags.beds} beds`);
  }
  if (resourceType === 'pharmacy') {
    if (tags.dispensing === 'yes') parts.push('Fills prescriptions');
    parts.push('Medication & basic first aid supplies');
  }
  if (resourceType === 'post_office') {
    parts.push('General Delivery — receive mail without an address. Ask for "General Delivery" service.');
  }
  if (resourceType === 'thrift_store') {
    if (tags.amenity === 'freeshop') parts.push('FREE — take what you need, leave what you can');
    else if (tags.amenity === 'give_box') parts.push('Community give box — free items');
    else if (tags.shop === 'charity') parts.push('Charity shop — affordable clothing & goods');
    else parts.push('Second-hand shop — cheap clothing & supplies');
    if (tags.second_hand === 'yes' || tags.second_hand === 'only') parts.push('Mostly second-hand goods');
  }
  if (resourceType === 'public_bookcase') {
    parts.push('📚 Little Free Library / Public Bookcase — take a book, leave a book');
    if (tags.books) parts.push(`Books: ${tags.books}`);
    if (tags.capacity) parts.push(`Capacity: ${tags.capacity} books`);
    if (tags.lit === 'yes') parts.push('Lit at night');
    if (tags.covered === 'yes') parts.push('Covered/sheltered');
  }
  if (resourceType === 'water_point') {
    parts.push('💧 Large water fill-up point — fill RV/van water tanks');
    if (tags.fee === 'no') parts.push('Free');
    else if (tags.fee === 'yes' || tags.charge) parts.push(`Fee: ${tags.charge || 'Yes'}`);
    if (tags.drinking_water === 'yes') parts.push('Potable / drinkable');
    if (tags.capacity) parts.push(`Capacity: ${tags.capacity}`);
  }
  if (resourceType === 'place_of_worship') {
    if (tags.religion) parts.push(`Religion: ${tags.religion}`);
    if (tags.denomination) parts.push(`Denomination: ${tags.denomination}`);
    parts.push('⛪ May offer: warming center, meals, clothing, overnight shelter in emergencies');
  }
  if (resourceType === 'bus_station') {
    parts.push('🚌 Covered transit station — seating, lighting, sometimes 24/7');
    if (tags.bench === 'yes') parts.push('Has benches');
    if (tags.shelter === 'yes') parts.push('Covered shelter');
    if (tags.toilets === 'yes') parts.push('Has restrooms');
    if (tags.network) parts.push(`Network: ${tags.network}`);
  }
  if (resourceType === 'gas_station') {
    parts.push('⛽ 24-hour gas station — restrooms, warmth, water');
    if (tags.brand) parts.push(`Brand: ${tags.brand}`);
    if (tags.shop === 'convenience') parts.push('Has convenience store');
    if (tags.compressed_air === 'yes') parts.push('Air compressor available');
  }
  if (resourceType === 'clothing_bank') {
    parts.push('👕 Free clothing distribution — warm layers, boots, essentials');
    if (tags['social_facility:for']) parts.push(`For: ${tags['social_facility:for'].replace(/;/g, ', ')}`);
  }
  if (resourceType === 'day_shelter') {
    parts.push('☀️ Daytime drop-in center — warmth, services, referrals');
    if (tags['social_facility:for']) parts.push(`For: ${tags['social_facility:for'].replace(/;/g, ', ')}`);
    if (tags.beds) parts.push(`Beds: ${tags.beds}`);
  }

  if (tags.phone) parts.push(`Phone: ${tags.phone}`);
  if (tags.website) parts.push(`Website: ${tags.website}`);
  if (tags.wheelchair === 'yes') parts.push('Wheelchair accessible');
  if (tags.access) parts.push(`Access: ${tags.access}`);

  return parts.join(' | ') || RESOURCE_TYPES[resourceType]?.label || 'Community resource.';
}

function extractResourceAmenities(tags, resourceType) {
  const amenities = [];
  if (resourceType === 'library') {
    amenities.push('Free WiFi', 'Outlets', 'Restrooms');
    if (tags.internet_access === 'wlan') amenities.push('WiFi Confirmed');
    if (tags.air_conditioning === 'yes') amenities.push('A/C');
  }
  if (tags.drinking_water === 'yes') amenities.push('Drinking Water');
  if (tags.toilets === 'yes') amenities.push('Restrooms');
  if (tags.wheelchair === 'yes') amenities.push('Accessible');
  if (tags.hot_water === 'yes') amenities.push('Hot Water');
  if (tags.fee === 'no') amenities.push('Free');
  if (tags.bottle === 'yes') amenities.push('Bottle Fill');
  return amenities;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN SEARCH FUNCTION
// ═══════════════════════════════════════════════════════════════════

async function findResources(lat, lon, radiusMiles = 10) {
  const radiusMeters = Math.min(Math.round(radiusMiles * 1609.34), 25000);
  const query = buildResourceQuery(lat, lon, radiusMeters);

  try {
    const { data } = await overpassQuery(query, 45000);

    const elements = data?.elements || [];
    const results = [];
    const seen = new Set();

    // Categorize results
    const categorized = {
      library: [], shower: [], laundry: [], community: [],
      water: [], food_bank: [], social: [], wifi: [],
      phone_charging: [], rest_area: [], bottle_return: [], clinic: [],
      homeless_shelter: [], hospital: [], pharmacy: [], post_office: [], thrift_store: [],
      public_bookcase: [], water_point: [], place_of_worship: [], bus_station: [],
      gas_station: [], clothing_bank: [], day_shelter: [], pet_friendly: [], warming_center: [],
    };

    for (const el of elements) {
      const elLat = el.lat || el.center?.lat;
      const elLon = el.lon || el.center?.lon;
      if (!elLat || !elLon) continue;

      const tags = el.tags || {};
      if (!tags.amenity && !tags.shop && !tags.natural && !tags.man_made && !tags.internet_access && !tags.highway && !tags.healthcare && !tags.social_facility && !tags.public_transport) continue;

      const resourceType = classifyResource(tags);
      if (!resourceType) continue;

      const key = `${elLat.toFixed(4)}-${elLon.toFixed(4)}-${resourceType}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const dist = haversine(lat, lon, elLat, elLon);
      const typeDef = RESOURCE_TYPES[resourceType];

      const resource = {
        id: `res-${el.type}-${el.id}`,
        name: buildResourceName(tags, resourceType),
        description: buildResourceDescription(tags, resourceType),
        lat: elLat,
        lon: elLon,
        distanceMiles: Math.round(dist * 10) / 10,
        resourceType,
        typeLabel: typeDef.label,
        icon: typeDef.icon,
        color: typeDef.color,
        source: 'OpenStreetMap',
        hours: tags.opening_hours || null,
        phone: tags.phone || null,
        website: tags.website || null,
        wheelchair: tags.wheelchair === 'yes',
        fee: tags.fee === 'yes' ? true : tags.fee === 'no' ? false : null,
        amenities: extractResourceAmenities(tags, resourceType),
        osmUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
      };

      results.push(resource);
      if (categorized[resourceType]) {
        categorized[resourceType].push(resource);
      }
    }

    // Sort each category by distance
    for (const cat of Object.values(categorized)) {
      cat.sort((a, b) => a.distanceMiles - b.distanceMiles);
    }

    return {
      resources: results.sort((a, b) => a.distanceMiles - b.distanceMiles),
      categorized,
      counts: Object.fromEntries(
        Object.entries(categorized).map(([k, v]) => [k, v.length])
      ),
      total: results.length,
    };
  } catch (err) {
    console.error('Resources search error:', err.message);
    return { resources: [], categorized: {}, counts: {}, total: 0, error: err.message };
  }
}

module.exports = { findResources, RESOURCE_TYPES };
