'use strict';
/**
 * The one door out of apps/maps. Every outbound HTTP request from this server goes through `get` /
 * `post` here, and this file reaches the network only through the shared SSRF guard
 * (apps/_shared/egress.js): the hostname is resolved, every answer must be a public address, and the
 * connection is pinned to the checked address. On top of that guard this adapter enforces:
 *
 *   - HTTPS only, to the allowlisted source hosts below and nothing else. The check runs before
 *     every request, redirect hops included (a redirect to a new host is re-checked), so a source
 *     answering `Location: http://…` or a non-allowlisted name is refused before any connection.
 *   - a per-host response-size cap (the number after each host). A body over the cap is refused as
 *     tools.maps.response_too_large, whether the server sent it raw (truncated at the socket) or
 *     gzip/deflate/brotli (the decompressor is capped at the same number).
 *   - at most 3 redirects, GET only; a redirect in answer to a POST is refused.
 *   - host and pathname only in errors: source API keys ride in query strings (NPS, OpenChargeMap)
 *     and headers (RIDB), so a message that echoed the URL would leak a key into logs.
 *
 * Allowlist (host -> max response bytes):
 *   nominatim.openstreetmap.org      256 KB  — small JSON, a handful of geocode hits
 *   overpass-api.de                   32 MB  — Overpass QL can answer a whole OSM extract
 *   ridb.recreation.gov                2 MB  — facility/recarea JSON lists
 *   developer.nps.gov                  8 MB  — campground, visitor-centre and parking JSON
 *   api.openchargemap.io               4 MB  — charge-point POI pages
 *   api.weather.gov                    2 MB  — points and active-alerts JSON
 *   api.open-meteo.com                 1 MB  — forecast and elevation JSON
 *   apps.fs.usda.gov                  16 MB  — ArcGIS USFS recreation features (GeoJSON)
 *   services.arcgis.com               16 MB  — ArcGIS National Bridge Inventory features
 *   www.refugerestrooms.org            1 MB  — restroom JSON, small
 *   www.ioverlander.com                4 MB  — scraped place pages (HTML)
 *   freecampsites.net                  8 MB  — scraped WordPress pages (HTML)
 *   www.campendium.com                 2 MB  — campground API JSON
 *   edits.nationalmap.gov              2 MB  — gazetteer search JSON
 *   www.walmart.com                    4 MB  — scraped store-search page (HTML)
 */
const zlib = require('zlib');
const { createEgress } = require('../../_shared/egress');

const KB = 1024;

const ALLOW = Object.freeze({
    'nominatim.openstreetmap.org': 256 * KB,
    'overpass-api.de': 32 * KB * KB,
    'ridb.recreation.gov': 2 * KB * KB,
    'developer.nps.gov': 8 * KB * KB,
    'api.openchargemap.io': 4 * KB * KB,
    'api.weather.gov': 2 * KB * KB,
    'api.open-meteo.com': 1 * KB * KB,
    'apps.fs.usda.gov': 16 * KB * KB,
    'services.arcgis.com': 16 * KB * KB,
    'www.refugerestrooms.org': 1 * KB * KB,
    'www.ioverlander.com': 4 * KB * KB,
    'freecampsites.net': 8 * KB * KB,
    'www.campendium.com': 2 * KB * KB,
    'edits.nationalmap.gov': 2 * KB * KB,
    'www.walmart.com': 4 * KB * KB,
});

let egress = createEgress();

/** Replace the guard; tests inject createEgress({ lookup, httpsRequest }) mocks. */
function setEgress(e) { egress = e; }

class MapsEgressError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'MapsEgressError';
        this.code = code;
        this.status = 502;
    }
}

const REDIRECTS = [301, 302, 303, 307, 308];
const tooBig = (host) => `${host} answered more than ${ALLOW[host]} bytes`;

async function send(method, rawUrl, { params, headers = {}, timeout = 10000, body } = {}) {
    let url = new URL(rawUrl);
    if (params) {
        for (const [k, v] of Object.entries(params)) {
            if (v !== undefined && v !== null) url.searchParams.append(k, String(v));
        }
    }

    // The caller's headers (an API key rides in RIDB's apikey) belong to the origin the caller asked
    // for; a redirect to another allowlisted host must not carry them across.
    const origin = url.origin;

    for (let redirects = 0; ;) {
        const host = url.hostname;
        if (url.protocol !== 'https:' || !Object.prototype.hasOwnProperty.call(ALLOW, host)) {
            throw new MapsEgressError(`${host} is not an allowed maps source`, 'tools.maps.host_not_allowed');
        }

        let r;
        try {
            r = await egress.request(url.href, {
                method,
                headers: { 'Accept-Encoding': 'identity', ...(url.origin === origin ? headers : {}) },
                timeoutMs: timeout,
                maxBytes: ALLOW[host],
                body,
            });
        } catch (err) {
            if (err && (err.name === 'TimeoutError' || err.message === 'Timeout')) {
                const e = new Error(`timeout of ${timeout}ms exceeded`);
                e.code = 'ECONNABORTED';
                throw e;
            }
            throw err;
        }

        const location = r.headers.location;
        if (REDIRECTS.includes(r.status) && location) {
            if (method !== 'GET') throw new MapsEgressError(`${host}${url.pathname} redirected a POST`, 'tools.maps.redirect_refused');
            if (redirects >= 3) throw new MapsEgressError(`too many redirects from ${host}`, 'tools.maps.too_many_redirects');
            redirects++;
            url = new URL(location, url);
            continue;
        }

        if (r.truncated === true) throw new MapsEgressError(tooBig(host), 'tools.maps.response_too_large');

        let buf = r.body;
        const encoding = String(r.headers['content-encoding'] || '').toLowerCase();
        if (encoding === 'gzip' || encoding === 'deflate' || encoding === 'br') {
            try {
                const opts = { maxOutputLength: ALLOW[host] };
                buf = encoding === 'gzip' ? zlib.gunzipSync(buf, opts)
                    : encoding === 'deflate' ? zlib.inflateSync(buf, opts)
                        : zlib.brotliDecompressSync(buf, opts);
            } catch (err) {
                if (err instanceof RangeError) throw new MapsEgressError(tooBig(host), 'tools.maps.response_too_large');
                throw err;
            }
        }

        let data = buf.toString('utf8');
        try { data = JSON.parse(data); } catch { /* not JSON: keep the string, cheerio callers want HTML */ }

        if (r.status < 200 || r.status > 299) {
            const err = new Error(`Request failed with status code ${r.status}`);
            err.response = { status: r.status, headers: r.headers, data };
            throw err;
        }
        return { status: r.status, headers: r.headers, data };
    }
}

const get = (url, opts) => send('GET', url, opts);
const post = (url, body, opts) => send('POST', url, { ...opts, body });

module.exports = { get, post, ALLOW, setEgress, MapsEgressError };
