/**
 * OpenVibeApp – Harm Reduction Services Module
 * Queries OpenStreetMap Overpass API for harm reduction and community health services:
 *   - Syringe service programs (needle exchanges)
 *   - Condom distribution / sexual health
 *   - Naloxone / overdose prevention
 *   - Harm reduction drop-in centers
 *   - Drug counselling / addiction services
 *   - HIV / STI testing
 *   - Vending machines (condoms, syringes, naloxone)
 *   - Family planning / sexual health clinics
 *
 * Data sourced from OpenStreetMap via Overpass API.
 */
const { haversine, overpassQuery } = require('./utils');

// ═══════════════════════════════════════════════════════════════════
// HARM REDUCTION CATEGORIES
// ═══════════════════════════════════════════════════════════════════
const HR_TYPES = {
  needle_exchange:    { label: 'Syringe Exchange',         icon: 'fa-syringe',           color: '#dc2626' },
  condom_dist:        { label: 'Condom Distribution',      icon: 'fa-heart',             color: '#ec4899' },
  naloxone:           { label: 'Naloxone / Narcan',        icon: 'fa-kit-medical',       color: '#f97316' },
  harm_reduction:     { label: 'Harm Reduction Center',    icon: 'fa-hand-holding-heart', color: '#8b5cf6' },
  addiction_counsel:  { label: 'Addiction Counselling',     icon: 'fa-comments',          color: '#3b82f6' },
  hiv_testing:        { label: 'HIV / STI Testing',        icon: 'fa-vial',              color: '#ef4444' },
  sexual_health:      { label: 'Sexual Health Clinic',     icon: 'fa-stethoscope',       color: '#0891b2' },
  family_planning:    { label: 'Family Planning',          icon: 'fa-baby',              color: '#a855f7' },
  vending_health:     { label: 'Health Vending Machine',   icon: 'fa-cash-register',     color: '#22c55e' },
  outreach:           { label: 'Outreach Program',         icon: 'fa-people-arrows',     color: '#10b981' },
  rehab:              { label: 'Rehab / Recovery',         icon: 'fa-house-medical',     color: '#6366f1' },
  social_health:      { label: 'Community Health Services', icon: 'fa-hospital',          color: '#0ea5e9' },
};

// ═══════════════════════════════════════════════════════════════════
// OVERPASS QUERY — Harm Reduction & Community Health
// ═══════════════════════════════════════════════════════════════════
function buildHRQuery(lat, lon, radiusMeters) {
  return `
[out:json][timeout:30];
(
  // ── Syringe exchanges / needle programs ──
  node["healthcare:speciality"="harm_reduction"](around:${radiusMeters},${lat},${lon});
  way["healthcare:speciality"="harm_reduction"](around:${radiusMeters},${lat},${lon});
  node["amenity"="needle_exchange"](around:${radiusMeters},${lat},${lon});
  node["amenity"="syringe_exchange"](around:${radiusMeters},${lat},${lon});

  // ── Syringe vending machines ──
  node["amenity"="vending_machine"]["vending"="syringe"](around:${radiusMeters},${lat},${lon});
  node["amenity"="vending_machine"]["vending"="syringes"](around:${radiusMeters},${lat},${lon});
  node["amenity"="vending_machine"]["vending"="needle"](around:${radiusMeters},${lat},${lon});

  // ── Condom distribution / vending / sexual health ──
  node["amenity"="vending_machine"]["vending"="condoms"](around:${radiusMeters},${lat},${lon});
  node["amenity"="vending_machine"]["vending"="condom"](around:${radiusMeters},${lat},${lon});
  node["healthcare"="sexual_health"](around:${radiusMeters},${lat},${lon});
  way["healthcare"="sexual_health"](around:${radiusMeters},${lat},${lon});

  // ── Harm reduction social facilities ──
  node["amenity"="social_facility"]["social_facility:for"~"drug_addicted|substance"](around:${radiusMeters},${lat},${lon});
  way["amenity"="social_facility"]["social_facility:for"~"drug_addicted|substance"](around:${radiusMeters},${lat},${lon});
  node["amenity"="social_facility"]["social_facility"="outreach"]["social_facility:for"~"drug|homeless|underprivileged"](around:${radiusMeters},${lat},${lon});
  way["amenity"="social_facility"]["social_facility"="outreach"]["social_facility:for"~"drug|homeless|underprivileged"](around:${radiusMeters},${lat},${lon});

  // ── Drug consumption rooms / safe injection sites ──
  node["amenity"="drug_consumption"](around:${radiusMeters},${lat},${lon});
  node["healthcare"="drug_consumption"](around:${radiusMeters},${lat},${lon});

  // ── Addiction / substance abuse counselling ──
  node["healthcare"="counselling"]["healthcare:counselling"="addiction"](around:${radiusMeters},${lat},${lon});
  way["healthcare"="counselling"]["healthcare:counselling"="addiction"](around:${radiusMeters},${lat},${lon});
  node["healthcare"="counselling"]["healthcare:counselling"="drug"](around:${radiusMeters},${lat},${lon});
  way["healthcare"="counselling"]["healthcare:counselling"="drug"](around:${radiusMeters},${lat},${lon});

  // ── HIV testing / STI clinics ──
  node["healthcare"="hiv_testing"](around:${radiusMeters},${lat},${lon});
  way["healthcare"="hiv_testing"](around:${radiusMeters},${lat},${lon});
  node["healthcare"="clinic"]["healthcare:speciality"="STD"](around:${radiusMeters},${lat},${lon});
  way["healthcare"="clinic"]["healthcare:speciality"="STD"](around:${radiusMeters},${lat},${lon});
  node["healthcare"="clinic"]["healthcare:speciality"="sexual_health"](around:${radiusMeters},${lat},${lon});

  // ── Family planning / reproductive health ──
  node["amenity"="social_facility"]["social_facility"="family_planning"](around:${radiusMeters},${lat},${lon});
  node["healthcare"="clinic"]["healthcare:speciality"="family_planning"](around:${radiusMeters},${lat},${lon});
  way["healthcare"="clinic"]["healthcare:speciality"="family_planning"](around:${radiusMeters},${lat},${lon});

  // ── Naloxone distribution (tagged in OSM) ──
  node["amenity"="vending_machine"]["vending"="naloxone"](around:${radiusMeters},${lat},${lon});
  node["amenity"="vending_machine"]["vending"="narcan"](around:${radiusMeters},${lat},${lon});

  // ── Rehabilitation / recovery centers ──
  node["healthcare"="rehabilitation"]["healthcare:speciality"~"drug|addict|substance"](around:${radiusMeters},${lat},${lon});
  way["healthcare"="rehabilitation"]["healthcare:speciality"~"drug|addict|substance"](around:${radiusMeters},${lat},${lon});

  // ── Broad: any healthcare=counselling with description hinting harm reduction ──
  node["healthcare"="counselling"]["healthcare:counselling"="substance_abuse"](around:${radiusMeters},${lat},${lon});
  way["healthcare"="counselling"]["healthcare:counselling"="substance_abuse"](around:${radiusMeters},${lat},${lon});

  // ── Planned Parenthood and similar ──
  node["name"~"Planned Parenthood|Family Planning",i](around:${radiusMeters},${lat},${lon});
  way["name"~"Planned Parenthood|Family Planning",i](around:${radiusMeters},${lat},${lon});

  // ── Broad harm reduction catch: social facilities tagged for health ──
  node["amenity"="social_facility"]["social_facility"="healthcare"](around:${radiusMeters},${lat},${lon});
  way["amenity"="social_facility"]["social_facility"="healthcare"](around:${radiusMeters},${lat},${lon});
);
out center body;
>;
out skel qt;
`;
}

// ═══════════════════════════════════════════════════════════════════
// CLASSIFY
// ═══════════════════════════════════════════════════════════════════
function classifyHR(tags) {
  const amenity = tags.amenity || '';
  const healthcare = tags.healthcare || '';
  const speciality = tags['healthcare:speciality'] || '';
  const counselling = tags['healthcare:counselling'] || '';
  const socialFor = tags['social_facility:for'] || '';
  const socialFacility = tags.social_facility || '';
  const vending = tags.vending || '';
  const name = (tags.name || '').toLowerCase();

  // Syringe exchange
  if (amenity === 'needle_exchange' || amenity === 'syringe_exchange') return 'needle_exchange';
  if (speciality.match(/harm_reduction/i)) return 'harm_reduction';
  if (vending.match(/syringe|needle/i)) return 'needle_exchange';

  // Naloxone
  if (vending.match(/naloxone|narcan/i)) return 'naloxone';

  // Condom vending / sexual health
  if (vending.match(/condom/i)) return 'condom_dist';
  if (healthcare === 'sexual_health') return 'sexual_health';
  if (speciality.match(/STD|sexual_health/i)) return 'hiv_testing';

  // HIV testing
  if (healthcare === 'hiv_testing') return 'hiv_testing';

  // Addiction counselling
  if (counselling.match(/addiction|drug|substance/i)) return 'addiction_counsel';

  // Family planning / Planned Parenthood
  if (socialFacility === 'family_planning' || speciality.match(/family_planning/i)) return 'family_planning';
  if (name.match(/planned parenthood|family planning/i)) return 'family_planning';

  // Drug consumption rooms
  if (amenity === 'drug_consumption' || healthcare === 'drug_consumption') return 'harm_reduction';

  // Rehab
  if (healthcare === 'rehabilitation' && speciality.match(/drug|addict|substance/i)) return 'rehab';

  // Social facility for drug addicted / substance
  if (socialFor.match(/drug|substance/i)) return 'harm_reduction';
  if (socialFacility === 'outreach' && socialFor.match(/drug|homeless|underprivileged/i)) return 'outreach';
  if (socialFacility === 'healthcare') return 'social_health';

  return 'harm_reduction';
}

function buildHRName(tags, hrType) {
  if (tags.name) return tags.name;
  const def = HR_TYPES[hrType];
  return def ? def.label : 'Harm Reduction Service';
}

function buildHRDescription(tags, hrType) {
  const parts = [];

  if (tags.description) parts.push(tags.description);
  if (tags.operator) parts.push(`Operated by: ${tags.operator}`);
  if (tags.opening_hours) parts.push(`Hours: ${tags.opening_hours}`);
  if (tags.phone || tags['contact:phone']) parts.push(`Phone: ${tags.phone || tags['contact:phone']}`);

  // Type-specific descriptions
  if (hrType === 'needle_exchange') {
    parts.push('Syringe service program — free clean needles, safe disposal, harm reduction supplies');
    if (tags.fee === 'no') parts.push('Free — no ID required at most programs');
  }
  if (hrType === 'condom_dist') {
    parts.push('Free condoms available. Practice safe sex');
  }
  if (hrType === 'naloxone') {
    parts.push('Naloxone (Narcan) available — reverses opioid overdose. Can save a life');
  }
  if (hrType === 'harm_reduction') {
    parts.push('Harm reduction center — safer use supplies, counselling, referrals');
  }
  if (hrType === 'addiction_counsel') {
    parts.push('Substance use counselling and support services');
  }
  if (hrType === 'hiv_testing') {
    parts.push('Free or low-cost HIV / STI testing. Confidential');
  }
  if (hrType === 'sexual_health') {
    parts.push('Sexual health services — testing, treatment, education, condoms');
  }
  if (hrType === 'family_planning') {
    parts.push('Reproductive health services — birth control, STI testing, condoms, health education. Income-based fees');
  }
  if (hrType === 'vending_health') {
    parts.push('Health vending machine — 24/7 access to harm reduction supplies');
  }
  if (hrType === 'rehab') {
    parts.push('Substance use rehabilitation and recovery services');
  }

  if (parts.length === 0) parts.push('Community health / harm reduction service');
  return parts.join(' | ');
}

// ═══════════════════════════════════════════════════════════════════
// MAIN SEARCH
// ═══════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════
// CURATED HARM REDUCTION SERVICES — Washington State
// ═══════════════════════════════════════════════════════════════════
const CURATED_SERVICES = [
  { id: 'hr-cur-1', name: 'People\'s Harm Reduction Alliance', lat: 47.6144, lon: -122.3208, hrType: 'needle_exchange', description: 'Seattle\'s largest SSP. Free syringes, naloxone, fentanyl test strips, wound care, HIV/HCV testing. Walk-in friendly. Multiple weekly locations.', website: 'https://peoplesharmreductionalliance.org', phone: '206-432-PHRA', hours: 'See website for schedule', amenities: ['Clean Syringes', 'Naloxone/Narcan', 'Fentanyl Test Strips', 'HIV Testing', 'Wound Care', 'Free Condoms'] },
  { id: 'hr-cur-2', name: 'North Sound Accountable Communities of Health', lat: 48.1989, lon: -122.1253, hrType: 'harm_reduction', description: 'Regional health initiative covering Snohomish, Skagit, Island, San Juan, Whatcom counties. Overdose prevention, naloxone distribution.', website: 'https://northsoundach.org', amenities: ['Naloxone/Narcan', 'Health Education'] },
  { id: 'hr-cur-3', name: 'Snohomish County Syringe Services', lat: 47.9793, lon: -122.2022, hrType: 'needle_exchange', description: 'County-authorized SSP in Everett. Clean syringes, safe disposal, naloxone, HIV/HCV testing. No ID required.', hours: 'M-F variable, call ahead', amenities: ['Clean Syringes', 'Naloxone/Narcan', 'HIV Testing', 'HCV Testing', 'Safe Disposal'] },
  { id: 'hr-cur-4', name: 'Downtown Emergency Service Center (DESC)', lat: 47.6013, lon: -122.3320, hrType: 'outreach', description: 'Comprehensive services for people experiencing homelessness. Mental health, substance use support, housing. Multiple Seattle locations.', website: 'https://www.desc.org', phone: '206-464-1570', amenities: ['Mental Health', 'Substance Use Support', 'Housing Referral'] },
  { id: 'hr-cur-5', name: 'Planned Parenthood - Everett', lat: 47.9756, lon: -122.2003, hrType: 'family_planning', description: 'Sexual & reproductive health. Free condoms, STI testing, PrEP, birth control. Sliding scale fees. Walk-ins accepted for some services.', website: 'https://www.plannedparenthood.org', phone: '1-800-230-7526', hours: 'M-F 8am-5pm', amenities: ['Free Condoms', 'STI Testing', 'PrEP', 'Birth Control', 'Sliding Scale'] },
  { id: 'hr-cur-6', name: 'Planned Parenthood - Mount Vernon', lat: 48.4214, lon: -122.3346, hrType: 'family_planning', description: 'Sexual health services for Skagit Valley. Free condoms, testing, contraception.', website: 'https://www.plannedparenthood.org', phone: '1-800-230-7526', hours: 'M-F 9am-5pm', amenities: ['Free Condoms', 'STI Testing', 'Birth Control'] },
  { id: 'hr-cur-7', name: 'Compass Health - Arlington Clinic', lat: 48.2013, lon: -122.1261, hrType: 'addiction_counsel', description: 'Behavioral health services including substance use disorder treatment. Accepts Medicaid. Serves Snohomish County.', website: 'https://www.compasshealth.org', phone: '425-349-6200', hours: 'M-F 8am-5pm', amenities: ['Addiction Counseling', 'Mental Health', 'Medicaid Accepted'] },
  { id: 'hr-cur-8', name: 'Skagit County Needle Exchange', lat: 48.4489, lon: -122.3372, hrType: 'needle_exchange', description: 'Syringe services program serving Skagit County from the Public Health building in Mount Vernon. Free naloxone kits.', hours: 'Tu-Th 9am-4pm', amenities: ['Clean Syringes', 'Naloxone/Narcan', 'Safe Disposal'] },
  { id: 'hr-cur-9', name: 'SRHD Syringe Services - Spokane', lat: 47.6553, lon: -117.4256, hrType: 'needle_exchange', description: 'Spokane Regional Health District SSP. Free clean syringes, naloxone, HIV testing. No questions, no ID.', website: 'https://srhd.org', hours: 'M-F 8am-4pm', amenities: ['Clean Syringes', 'Naloxone/Narcan', 'HIV Testing', 'Safe Disposal'] },
  { id: 'hr-cur-10', name: 'Tacoma Needle Exchange (TNEX)', lat: 47.2495, lon: -122.4381, hrType: 'needle_exchange', description: 'Tacoma\'s syringe exchange. Clean works, safe disposal, naloxone, wound care. Peer support.', hours: 'M-F 8:30am-4pm', amenities: ['Clean Syringes', 'Naloxone/Narcan', 'Wound Care', 'Peer Support'] },
  { id: 'hr-cur-11', name: 'Night Owl Outreach - Whatcom Co', lat: 48.7509, lon: -122.4782, hrType: 'outreach', description: 'Street outreach in Bellingham/Whatcom County. Distributes naloxone, clean supplies, food. Mobile harm reduction.', amenities: ['Naloxone/Narcan', 'Clean Syringes', 'Food', 'Outreach'] },
  { id: 'hr-cur-12', name: 'WA State Naloxone Hotline', lat: 47.0379, lon: -122.9007, hrType: 'naloxone', description: 'Statewide naloxone by mail program. Call to get free Narcan mailed to you anywhere in WA state. No questions asked.', phone: '1-888-811-NARCAN', website: 'https://stopoverdose.org', amenities: ['Naloxone/Narcan', 'Free by Mail', 'Statewide'] },
];

async function findHarmReduction(lat, lon, radiusMiles) {
  const radiusMeters = Math.min(radiusMiles, 20) * 1609.344;
  const query = buildHRQuery(lat, lon, radiusMeters);
  const seen = new Set();

  try {
    const resp = await overpassQuery(query, 30000);
    const elements = resp?.data?.elements || [];
    const services = [];

    for (const el of elements) {
      if (!el.tags) continue;
      const elLat = el.lat || el.center?.lat;
      const elLon = el.lon || el.center?.lon;
      if (!elLat || !elLon) continue;

      const coordKey = `${elLat.toFixed(5)},${elLon.toFixed(5)}`;
      if (seen.has(coordKey)) continue;
      seen.add(coordKey);

      const hrType = classifyHR(el.tags);
      const typeDef = HR_TYPES[hrType] || HR_TYPES.harm_reduction;
      const dist = haversine(lat, lon, elLat, elLon);

      services.push({
        id: `hr-${el.type}-${el.id}`,
        name: buildHRName(el.tags, hrType),
        description: buildHRDescription(el.tags, hrType),
        lat: elLat,
        lon: elLon,
        distanceMiles: Math.round(dist * 10) / 10,
        hrType,
        typeLabel: typeDef.label,
        icon: typeDef.icon,
        color: typeDef.color,
        fee: el.tags.fee === 'yes' ? true : el.tags.fee === 'no' ? false : null,
        hours: el.tags.opening_hours || null,
        wheelchair: el.tags.wheelchair === 'yes',
        website: el.tags.website || el.tags['contact:website'] || null,
        osmUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
        phone: el.tags.phone || el.tags['contact:phone'] || null,
        amenities: [
          hrType === 'needle_exchange' ? 'Clean Syringes' : '',
          hrType === 'condom_dist' || hrType === 'sexual_health' || hrType === 'family_planning' ? 'Free Condoms' : '',
          hrType === 'naloxone' ? 'Naloxone/Narcan' : '',
          el.tags.wheelchair === 'yes' ? 'Wheelchair Accessible' : '',
        ].filter(Boolean),
      });
    }

    // Merge curated services within search radius
    const curatedInRange = CURATED_SERVICES
      .map(c => {
        const dist = haversine(lat, lon, c.lat, c.lon);
        if (dist > radiusMiles) return null;
        const t = HR_TYPES[c.hrType] || HR_TYPES.social_health;
        return {
          ...c,
          distanceMiles: Math.round(dist * 100) / 100,
          typeLabel: t.label,
          icon: t.icon,
          color: t.color,
          fee: false,
          curated: true,
        };
      })
      .filter(Boolean)
      .filter(c => !services.some(s =>
        Math.abs(s.lat - c.lat) < 0.001 && Math.abs(s.lon - c.lon) < 0.001
      ));

    const all = [...services, ...curatedInRange];
    all.sort((a, b) => a.distanceMiles - b.distanceMiles);
    return { services: all };
  } catch (err) {
    console.error('[HarmReduction] Overpass error:', err.message);
    // Return curated data as fallback on Overpass failure
    const curatedFallback = CURATED_SERVICES
      .map(c => {
        const dist = haversine(lat, lon, c.lat, c.lon);
        if (dist > radiusMiles) return null;
        const t = HR_TYPES[c.hrType] || HR_TYPES.social_health;
        return { ...c, distanceMiles: Math.round(dist * 100) / 100, typeLabel: t.label, icon: t.icon, color: t.color, fee: false, curated: true };
      })
      .filter(Boolean)
      .sort((a, b) => a.distanceMiles - b.distanceMiles);
    return { services: curatedFallback };
  }
}

module.exports = { findHarmReduction, HR_TYPES };
