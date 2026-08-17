/**
 * ╔═══════════════════════════════════════════════════════════════════╗
 * ║          OpenVibeApp – USFS Recreation Sites Module                ║
 * ║   National Forest campgrounds, trailheads, picnic areas, etc.    ║
 * ╚═══════════════════════════════════════════════════════════════════╝
 *
 * Data Source:
 *   USFS Enterprise Data Warehouse – Recreation Opportunities
 *   ArcGIS REST API (free, no auth required)
 *   Covers all National Forest recreation sites nationwide
 *   Fields: RECAREANAME, LAT/LON, MARKERACTIVITY, FEEDESCRIPTION,
 *           OPERATIONAL_HOURS, FORESTNAME, RECAREAURL, OPENSTATUS,
 *           RESERVATION_INFO, RESTRICTIONS, ACCESSIBILITY
 */
const axios = require('axios');
const { haversine } = require('./utils');

const USFS_API = 'https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_RecreationOpportunities_01/MapServer/0/query';

// Activity → type classification for OpenVibeApp
const ACTIVITY_MAP = {
  'Campground Camping':       { type: 'USFS Campground',      icon: 'fa-campground',  stealth: 2 },
  'Cabin Rentals':            { type: 'USFS Cabin',            icon: 'fa-house',       stealth: 2 },
  'Group Camping':            { type: 'USFS Group Camp',       icon: 'fa-campground',  stealth: 1 },
  'Dispersed Camping':        { type: 'Dispersed (USFS)',      icon: 'fa-tree',        stealth: 5 },
  'Day Hiking':               { type: 'Trailhead',             icon: 'fa-person-hiking', stealth: 3 },
  'Backpacking':              { type: 'Backpacking Trail',     icon: 'fa-person-hiking', stealth: 5 },
  'Picnicking':               { type: 'USFS Picnic Area',      icon: 'fa-utensils',    stealth: 2 },
  'Fishing':                  { type: 'Fishing Access',        icon: 'fa-fish',        stealth: 3 },
  'Swimming':                 { type: 'Swimming Area',         icon: 'fa-water',       stealth: 2 },
  'Boating':                  { type: 'Boat Launch',           icon: 'fa-sailboat',    stealth: 2 },
  'Mountain Biking':          { type: 'MTB Trailhead',         icon: 'fa-bicycle',     stealth: 3 },
  'Winter Sports':            { type: 'Winter Sports Area',    icon: 'fa-snowflake',   stealth: 2 },
  'OHV/Off-Highway Driving':  { type: 'OHV Area',             icon: 'fa-truck-monster', stealth: 4 },
  'Horseback Riding':         { type: 'Equestrian Trailhead',  icon: 'fa-horse',       stealth: 3 },
  'Wildlife Viewing':         { type: 'Wildlife Viewing',      icon: 'fa-binoculars',  stealth: 3 },
  'Visitor Centers':          { type: 'Visitor Center',        icon: 'fa-info-circle', stealth: 1 },
  'Nature Viewing':           { type: 'Nature Viewing',        icon: 'fa-binoculars',  stealth: 3 },
  'Interpretive Programs':    { type: 'Interpretive Site',     icon: 'fa-book-open',   stealth: 1 },
  'Climbing':                 { type: 'Climbing Area',         icon: 'fa-mountain',    stealth: 4 },
  'Water Sports':             { type: 'Water Sports',          icon: 'fa-water',       stealth: 2 },
};

/**
 * Clean HTML from USFS fee descriptions
 */
function cleanHtml(str) {
  if (!str) return '';
  return str
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Classify USFS activity into OpenVibeApp type/stealth
 */
function classifyActivity(activity) {
  if (!activity) return { type: 'USFS Recreation', icon: 'fa-tree', stealth: 3 };
  // Direct match
  if (ACTIVITY_MAP[activity]) return ACTIVITY_MAP[activity];
  // Partial match
  const lower = activity.toLowerCase();
  if (lower.includes('camp')) return { type: 'USFS Campground', icon: 'fa-campground', stealth: 2 };
  if (lower.includes('hik')) return { type: 'Trailhead', icon: 'fa-person-hiking', stealth: 3 };
  if (lower.includes('trail')) return { type: 'Trailhead', icon: 'fa-person-hiking', stealth: 3 };
  if (lower.includes('picnic')) return { type: 'USFS Picnic Area', icon: 'fa-utensils', stealth: 2 };
  if (lower.includes('fish')) return { type: 'Fishing Access', icon: 'fa-fish', stealth: 3 };
  if (lower.includes('boat') || lower.includes('water')) return { type: 'Water Access', icon: 'fa-water', stealth: 2 };
  if (lower.includes('cabin')) return { type: 'USFS Cabin', icon: 'fa-house', stealth: 2 };
  return { type: 'USFS Recreation', icon: 'fa-tree', stealth: 3 };
}

/**
 * Parse fee info from HTML description
 */
function parseFee(feeDesc) {
  const clean = cleanHtml(feeDesc);
  if (!clean) return 'Unknown';
  if (/no fee|free/i.test(clean)) return 'Free';
  const match = clean.match(/\$(\d+(?:\.\d+)?)/);
  if (match) return `$${match[1]}/night`;
  return clean.length > 80 ? clean.substring(0, 77) + '...' : clean;
}

/**
 * Search USFS recreation sites near a location.
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @param {number} radiusMiles - Search radius in miles
 */
async function search(lat, lon, radiusMiles = 25) {
  const radiusMeters = Math.round(radiusMiles * 1609.34);

  const params = new URLSearchParams({
    where: '1=1',
    geometry: `${lon},${lat}`,
    geometryType: 'esriGeometryPoint',
    spatialRel: 'esriSpatialRelIntersects',
    distance: String(Math.min(radiusMeters, 80000)), // cap at 80km
    units: 'esriSRUnit_Meter',
    outFields: 'RECAREANAME,LATITUDE,LONGITUDE,MARKERACTIVITY,FEEDESCRIPTION,OPERATIONAL_HOURS,OPENSTATUS,FORESTNAME,RECAREAURL,RESERVATION_INFO,RESTRICTIONS,ACCESSIBILITY',
    f: 'json',
    resultRecordCount: '200',
  });

  const { data } = await axios.get(`${USFS_API}?${params.toString()}`, {
    timeout: 30000,
    headers: {
      'User-Agent': 'OpenVibeApp/2.0 (stealth camping tool)',
    },
  });

  const features = data?.features || [];
  const results = [];
  const seen = new Set();

  for (const feat of features) {
    const attrs = feat.attributes || {};
    const elLat = parseFloat(attrs.LATITUDE);
    const elLon = parseFloat(attrs.LONGITUDE);
    if (!elLat || !elLon || isNaN(elLat) || isNaN(elLon)) continue;

    const name = attrs.RECAREANAME || 'USFS Recreation Site';
    const key = `${elLat.toFixed(3)}-${elLon.toFixed(3)}-${name}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const dist = haversine(lat, lon, elLat, elLon);
    const activity = attrs.MARKERACTIVITY || '';
    const classified = classifyActivity(activity);
    const fee = parseFee(attrs.FEEDESCRIPTION);
    const restrictions = cleanHtml(attrs.RESTRICTIONS);
    const hours = cleanHtml(attrs.OPERATIONAL_HOURS);
    const accessibility = cleanHtml(attrs.ACCESSIBILITY);
    const reserveInfo = cleanHtml(attrs.RESERVATION_INFO);

    // Build rich description
    const descParts = [];
    if (attrs.FORESTNAME) descParts.push(`🌲 ${attrs.FORESTNAME}`);
    if (activity) descParts.push(`Activity: ${activity}`);
    if (fee && fee !== 'Unknown') descParts.push(`Fee: ${fee}`);
    if (hours) descParts.push(`Hours: ${hours}`);
    if (attrs.OPENSTATUS && attrs.OPENSTATUS !== 'Open') descParts.push(`Status: ${attrs.OPENSTATUS}`);
    if (reserveInfo) descParts.push(`Reservations: ${reserveInfo.substring(0, 60)}`);
    if (restrictions) descParts.push(`⚠️ ${restrictions.substring(0, 80)}`);
    if (accessibility) descParts.push(`♿ ${accessibility.substring(0, 60)}`);

    results.push({
      id: `usfs-${elLat.toFixed(4)}-${elLon.toFixed(4)}`,
      name,
      description: descParts.join(' | ') || 'USFS National Forest recreation site.',
      lat: elLat,
      lon: elLon,
      distanceMiles: Math.round(dist * 10) / 10,
      type: classified.type,
      source: 'USFS',
      sourceIcon: 'fa-tree',
      reservable: /reserv/i.test(reserveInfo),
      url: attrs.RECAREAURL || null,
      fee: fee === 'Free' ? 'Free' : fee.startsWith('$') ? fee : 'Unknown',
      stealthRating: Math.max(1, Math.min(5,
        classified.stealth + (fee === 'Free' ? 1 : 0) + (/dispersed|backcountry/i.test(activity) ? 1 : 0)
      )),
      tags: [
        'usfs', 'national-forest',
        fee === 'Free' ? 'free' : '',
        activity ? activity.toLowerCase().replace(/\s+/g, '-') : '',
      ].filter(Boolean),
      amenities: [],
      forestName: attrs.FORESTNAME || null,
      activity,
      openStatus: attrs.OPENSTATUS || 'Unknown',
    });
  }

  return results.sort((a, b) => a.distanceMiles - b.distanceMiles);
}

module.exports = { search, ACTIVITY_MAP };
