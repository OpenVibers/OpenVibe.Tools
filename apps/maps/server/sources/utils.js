/**
 * OpenVibeApp – Shared Utilities
 * Common functions used across multiple modules.
 */

const axios = require('axios');

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

// ═══════════════════════════════════════════════════════════════════
// OVERPASS QUEUE — Serialize requests to avoid 429 rate limits
// ═══════════════════════════════════════════════════════════════════
const _overpassQueue = [];
let _overpassRunning = 0;
const MAX_CONCURRENT_OVERPASS = 2;      // Max parallel Overpass requests
const MAX_QUEUED_OVERPASS = 60;         // More waiting than this: refuse (a search asks a handful at most)
const OVERPASS_RETRY_DELAYS = [2000, 5000, 12000]; // Backoff per retry

async function _processOverpassQueue() {
  while (_overpassQueue.length > 0 && _overpassRunning < MAX_CONCURRENT_OVERPASS) {
    const job = _overpassQueue.shift();
    _overpassRunning++;
    _runOverpassJob(job).finally(() => {
      _overpassRunning--;
      _processOverpassQueue();
    });
  }
}

async function _runOverpassJob({ query, timeout, resolve, reject, attempt = 0 }) {
  try {
    const resp = await axios.post(OVERPASS_URL, `data=${encodeURIComponent(query)}`, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout,
    });
    resolve(resp);
  } catch (err) {
    const status = err?.response?.status;
    // Retry on 429 (rate limit) or 504 (gateway timeout)
    if ((status === 429 || status === 504) && attempt < OVERPASS_RETRY_DELAYS.length) {
      const delay = OVERPASS_RETRY_DELAYS[attempt];
      console.warn(`[Overpass] ${status} on attempt ${attempt + 1}, retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
      return _runOverpassJob({ query, timeout, resolve, reject, attempt: attempt + 1 });
    }
    // Retry once on timeout
    if (err.code === 'ECONNABORTED' && attempt < 1) {
      console.warn(`[Overpass] Timeout on attempt ${attempt + 1}, retrying...`);
      await new Promise(r => setTimeout(r, 1500));
      return _runOverpassJob({ query, timeout: timeout + 10000, resolve, reject, attempt: attempt + 1 });
    }
    reject(err);
  }
}

/**
 * Queue an Overpass API request. Serializes calls to avoid 429 rate limits
 * and retries on 429/504 with exponential backoff.
 * @param {string} query  - The Overpass QL query
 * @param {number} timeout - Axios timeout in ms (default 45000)
 * @returns {Promise} Axios response
 */
function overpassQuery(query, timeout = 45000) {
  return new Promise((resolve, reject) => {
    if (_overpassQueue.length >= MAX_QUEUED_OVERPASS) {
      return reject(Object.assign(new Error('OpenStreetMap is busy with other searches; try again in a minute.'), { status: 503, busy: true }));
    }
    _overpassQueue.push({ query, timeout, resolve, reject });
    _processOverpassQueue();
  });
}

/**
 * Haversine distance in miles between two lat/lon points.
 */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Deduplicate locations by proximity + fuzzy name matching.
 * Uses a spatial hash grid for O(n) average performance.
 */
function dedup(locations) {
  const gridSize = 0.002; // ~220m grid cells
  const grid = new Map();

  function gridKey(lat, lon) {
    return `${Math.floor(lat / gridSize)},${Math.floor(lon / gridSize)}`;
  }

  const unique = [];
  for (const loc of locations) {
    const key = gridKey(loc.lat, loc.lon);
    let isDup = false;

    // Check current cell and 8 neighbors
    const gx = Math.floor(loc.lat / gridSize);
    const gy = Math.floor(loc.lon / gridSize);
    outer:
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const neighborKey = `${gx + dx},${gy + dy}`;
        const cell = grid.get(neighborKey);
        if (!cell) continue;
        for (const u of cell) {
          const latDiff = Math.abs(u.lat - loc.lat);
          const lonDiff = Math.abs(u.lon - loc.lon);
          if (latDiff < 0.0005 && lonDiff < 0.0005) { isDup = true; break outer; }
          if (latDiff < 0.002 && lonDiff < 0.002) {
            const n1 = (u.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            const n2 = (loc.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            if (n1 === n2) { isDup = true; break outer; }
            if (n1.length > 4 && n2.length > 4 && (n1.includes(n2) || n2.includes(n1))) { isDup = true; break outer; }
          }
        }
      }
    }

    if (!isDup) {
      unique.push(loc);
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(loc);
    }
  }
  return unique;
}

module.exports = { haversine, dedup, OVERPASS_URL, overpassQuery };
