/**
 * FreeCampsites.net Scraper Module
 * Scrapes community-contributed free camping locations from FreeCampsites.net
 * These are community-vetted, real-world locations perfect for stealth camping.
 *
 * We fetch their API-like endpoints that serve map data.
 */
const axios = require('axios');
const cheerio = require('cheerio');
const { haversine } = require('./utils');

const BASE_URL = 'https://freecampsites.net';



/**
 * Search for free campsites near a location.
 * FreeCampsites.net doesn't have a public JSON API, so we scrape their
 * wp-json/wp/v2/ endpoints and map markers.
 */
async function search(lat, lon, radiusMiles) {
  const results = [];

  try {
    // Try the WordPress REST API that many WP sites expose
    const { data } = await axios.get(`${BASE_URL}/wp-json/wp/v2/posts`, {
      params: {
        per_page: 50,
        search: 'camping',
        _fields: 'id,title,link,excerpt,content',
      },
      headers: {
        'User-Agent': 'WA-StealthCampLocator/1.0 (research-project)',
      },
      timeout: 15000,
    });

    if (Array.isArray(data)) {
      for (const post of data) {
        const coords = extractCoordinates(post.content?.rendered || '');
        if (coords) {
          const dist = haversine(lat, lon, coords.lat, coords.lon);
          if (dist <= radiusMiles) {
            results.push({
              id: `fcs-${post.id}`,
              name: cleanTitle(post.title?.rendered || 'Free Campsite'),
              description: cleanHtml(post.excerpt?.rendered || ''),
              lat: coords.lat,
              lon: coords.lon,
              distanceMiles: Math.round(dist * 10) / 10,
              type: 'Free Campsite',
              source: 'FreeCampsites.net',
              sourceIcon: 'fa-campground',
              reservable: false,
              url: post.link || BASE_URL,
              fee: 'Free',
              stealthRating: 4,
              tags: ['free', 'community-verified'],
            });
          }
        }
      }
    }
  } catch (err) {
    // WP JSON failed - try scraping the main page
    console.warn('[FreeCampsites] WP JSON unavailable:', err.message);
  }

  // Also try scraping their map page for WA state campsite markers
  try {
    const { data: html } = await axios.get(`${BASE_URL}/?s=washington+camping`, {
      headers: {
        'User-Agent': 'WA-StealthCampLocator/1.0 (research-project)',
      },
      timeout: 15000,
    });

    const $ = cheerio.load(html);

    // Look for embedded JSON data with coordinates
    $('script').each((_, script) => {
      const content = $(script).html() || '';
      // Look for patterns like lat: 47.xxxx, lng: -122.xxxx
      const coordMatches = content.matchAll(/lat['":\s]+([\d.-]+)[,\s]+l(?:ng|on)['":\s]+([\d.-]+)/gi);
      for (const match of coordMatches) {
        const cLat = parseFloat(match[1]);
        const cLon = parseFloat(match[2]);
        if (cLat > 45 && cLat < 50 && cLon < -116 && cLon > -125) {
          const dist = haversine(lat, lon, cLat, cLon);
          if (dist <= radiusMiles) {
            results.push({
              id: `fcs-scraped-${cLat.toFixed(4)}-${cLon.toFixed(4)}`,
              name: 'Free Campsite (Community)',
              description: 'Community-reported free camping location from FreeCampsites.net',
              lat: cLat,
              lon: cLon,
              distanceMiles: Math.round(dist * 10) / 10,
              type: 'Free Campsite',
              source: 'FreeCampsites.net',
              sourceIcon: 'fa-campground',
              reservable: false,
              url: BASE_URL,
              fee: 'Free',
              stealthRating: 4,
              tags: ['free', 'community-reported'],
            });
          }
        }
      }
    });

    // Also try to find links to individual campsite pages
    $('a[href*="freecampsites.net/"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const text = $(el).text().trim();
      if (href.includes('/wp-') || href.includes('/tag/') || href.includes('/category/')) return;
      if (text && text.length > 3 && href !== BASE_URL && !href.endsWith('.net/')) {
        // We found a campsite link – store for potential future fetching
      }
    });
  } catch (err) {
    console.warn('[FreeCampsites] Scrape error:', err.message);
  }

  return results;
}

function extractCoordinates(html) {
  // Look for GPS coordinates in the content
  const patterns = [
    /GPS[:\s]*([\d.-]+)[,\s]+([\d.-]+)/i,
    /latitude[:\s]*([\d.-]+)[,\s]*longitude[:\s]*([\d.-]+)/i,
    /(\d{2}\.\d{3,})[,\s]+(-\d{2,3}\.\d{3,})/,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      const lat = parseFloat(match[1]);
      const lon = parseFloat(match[2]);
      // Validate it's a reasonable coordinate in North America
      if (lat > 14 && lat < 72 && lon < -50 && lon > -170) {
        return { lat, lon };
      }
    }
  }
  return null;
}

function cleanTitle(html) {
  return html.replace(/<[^>]*>/g, '').replace(/&#8211;/g, '–').replace(/&#8217;/g, "'").replace(/&amp;/g, '&').trim();
}

function cleanHtml(html) {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().substring(0, 300);
}

module.exports = { search };
