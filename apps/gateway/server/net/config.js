'use strict';

// Tool names and descriptions live in server/seo/catalog.js so the UI, the page <title> and
// the structured data can never disagree. Entries here keep their id/subdomain/icon/category.
const { seoFor } = require('../seo/catalog');

// ═══════════════════════════════════════════════════════════════
// Net.OpenVibe — Network Tools Configuration
// API keys, rate limits, probe regions, and tool definitions.
// Admin-panel-configurable keys fall back to free/keyless APIs.
// ═══════════════════════════════════════════════════════════════

/**
 * Load a config value from the DB site_settings table, falling
 * back to the provided default.  All net.* keys are namespaced.
 */
function getSetting(db, key, fallback = '') {
    try {
        const row = db.prepare('SELECT value FROM site_settings WHERE key = ?').get(`net.${key}`);
        return row ? row.value : fallback;
    } catch { return fallback; }
}

function getNetConfig(db) {
    return {
        // ── External API keys (optional: free tiers work without keys) ──
        ipinfo: {
            token: getSetting(db, 'ipinfo_token', ''),       // ipinfo.io — 50k/month free
            baseUrl: 'https://ipinfo.io',
        },
        ipapi: {
            baseUrl: 'http://ip-api.com',                     // ip-api.com — free (non-commercial)
        },
        // RDAP is keyless (IANA standard, public registries)
        rdap: {
            baseUrl: 'https://rdap.org',
        },
        // Google DNS-over-HTTPS (public, no key)
        doh: {
            google: 'https://dns.google/resolve',
            cloudflare: 'https://cloudflare-dns.com/dns-query',
        },
        // Globalping (free tier: 100 credits/hour)
        globalping: {
            token: getSetting(db, 'globalping_token', ''),
            baseUrl: 'https://api.globalping.io/v1',
        },

        // ── Probe regions for distributed diagnostics ──
        probeRegions: [
            { id: 'us-east',  label: 'US East',  country: 'US', state: 'NY' },
            { id: 'us-west',  label: 'US West',  country: 'US', state: 'CA' },
            { id: 'eu-west',  label: 'Europe',    country: 'DE' },
            { id: 'asia',     label: 'Asia',      country: 'JP' },
            { id: 'oceania',  label: 'Oceania',   country: 'AU' },
            { id: 'sa',       label: 'S. America', country: 'BR' },
        ],

        // ── Rate limits for network tool API ──
        rateLimit: {
            windowMs: 60_000,
            maxPerWindow: 30,          // 30 requests/minute for anonymous
            maxPerWindowAuth: 120,     // 120/minute for logged-in users
        },

        // ── DNS record types supported ──
        dnsTypes: ['A', 'AAAA', 'MX', 'TXT', 'CNAME', 'NS', 'SOA', 'PTR', 'CAA', 'SRV', 'NAPTR', 'DNSKEY', 'DS'],

        // ── Max concurrent probes per request ──
        maxProbeRegions: 6,

        // ── Timeout for upstream API calls ──
        upstreamTimeoutMs: 12_000,
    };
}

// ── Tool definitions (drives the UI, routing, and directory) ──
const NET_TOOLS = [
    // Hub
    { id: 'net',              subdomain: 'net',              name: 'Net.OpenVibe',           icon: 'fa-network-wired',     desc: 'Network & Internet Diagnostics Hub', hub: true },
    { id: 'lookup',           subdomain: 'lookup',           name: 'OpenVibeLookup',        icon: 'fa-magnifying-glass',  desc: 'All-in-one domain/IP lookup supertool' },
    // IP / Identity
    { id: 'myip',             subdomain: 'myip',             name: 'OpenVibeMyIP',          icon: 'fa-location-crosshairs', desc: 'Your public IP, ISP, location & reverse DNS' },
    { id: 'ip',               subdomain: 'ip',               name: 'OpenVibeIP',            icon: 'fa-at',                desc: 'IP address lookup & details (IPv4 & IPv6)' },
    { id: 'ipv4',             subdomain: 'ipv4',             name: 'OpenVibeIPv4',          icon: 'fa-hashtag',           desc: 'IPv4 address lookup, class, CIDR calculator' },
    { id: 'ipv6',             subdomain: 'ipv6',             name: 'OpenVibeIPv6',          icon: 'fa-code',              desc: 'IPv6 address lookup, expansion, type detection' },
    { id: 'geoip',            subdomain: 'geoip',            name: 'OpenVibeGeoIP',         icon: 'fa-earth-americas',    desc: 'IP geolocation — country, city, timezone, map' },
    { id: 'hostname',         subdomain: 'hostname',         name: 'OpenVibeHostname',      icon: 'fa-server',            desc: 'Hostname & reverse DNS lookup' },
    { id: 'isp',              subdomain: 'isp',              name: 'OpenVibeISP',           icon: 'fa-building',          desc: 'ISP & organization info from IP' },
    { id: 'asn',              subdomain: 'asn',              name: 'OpenVibeASN',           icon: 'fa-diagram-project',   desc: 'Autonomous System Number lookup' },
    { id: 'rdns',             subdomain: 'rdns',             name: 'OpenVibeReverseDNS',    icon: 'fa-rotate-left',       desc: 'Reverse DNS (PTR) lookup for IPv4 & IPv6' },
    { id: 'whois',            subdomain: 'whois',            name: 'OpenVibeWhois',         icon: 'fa-address-book',      desc: 'Whois domain registration lookup' },
    { id: 'rdap',             subdomain: 'rdap',             name: 'OpenVibeRDAP',          icon: 'fa-id-card',           desc: 'RDAP — modern registration data lookup' },
    // DNS
    { id: 'dns',              subdomain: 'dns',              name: 'OpenVibeDNS',           icon: 'fa-sitemap',           desc: 'DNS record lookup — A, AAAA, MX, TXT, and more' },
    { id: 'dig',              subdomain: 'dig',              name: 'OpenVibeDig',           icon: 'fa-terminal',          desc: 'Online dig command — query any DNS record' },
    { id: 'nslookup',         subdomain: 'nslookup',         name: 'OpenVibeNSLookup',      icon: 'fa-magnifying-glass-arrow-right', desc: 'NSLookup — simple DNS query tool' },
    { id: 'dnspropagation',   subdomain: 'dnspropagation',   name: 'OpenVibeDNSPropagation', icon: 'fa-globe',            desc: 'Check DNS propagation across world regions' },
    { id: 'mx',               subdomain: 'mx',               name: 'OpenVibeMX',            icon: 'fa-envelope',          desc: 'MX record lookup — mail server discovery' },
    { id: 'txt',              subdomain: 'txt',              name: 'OpenVibeTXT',           icon: 'fa-file-lines',        desc: 'TXT record lookup — SPF, DKIM, verification' },
    { id: 'ns',               subdomain: 'ns',               name: 'OpenVibeNS',            icon: 'fa-server',            desc: 'NS record lookup — nameserver discovery' },
    { id: 'spf',              subdomain: 'spf',              name: 'OpenVibeSPF',           icon: 'fa-shield-halved',     desc: 'SPF record checker & validator' },
    { id: 'dkim',             subdomain: 'dkim',             name: 'OpenVibeDKIM',          icon: 'fa-key',               desc: 'DKIM record lookup & validation' },
    { id: 'dmarc',            subdomain: 'dmarc',            name: 'OpenVibeDMARC',         icon: 'fa-user-shield',       desc: 'DMARC policy checker' },
    // Active diagnostics
    { id: 'ping',             subdomain: 'ping',             name: 'OpenVibePing',          icon: 'fa-satellite-dish',    desc: 'Ping from multiple global regions' },
    { id: 'traceroute',       subdomain: 'traceroute',       name: 'OpenVibeTraceroute',    icon: 'fa-route',             desc: 'Traceroute — visualize network path & hops' },
    { id: 'mtr',              subdomain: 'mtr',              name: 'OpenVibeMTR',           icon: 'fa-chart-line',        desc: 'MTR — combined ping + traceroute analysis' },
    { id: 'port',             subdomain: 'port',             name: 'OpenVibePortCheck',     icon: 'fa-door-open',         desc: 'Port scanner — check if ports are open' },
    { id: 'headers',          subdomain: 'headers',          name: 'OpenVibeHeaders',       icon: 'fa-list',              desc: 'HTTP headers checker — security & cache analysis' },
    { id: 'redirects',        subdomain: 'redirects',        name: 'OpenVibeRedirects',     icon: 'fa-share',             desc: 'Redirect chain tracer — follow all hops' },
    { id: 'ssl',              subdomain: 'ssl',              name: 'OpenVibeSSL',           icon: 'fa-lock',              desc: 'SSL/TLS certificate checker & chain inspector' },
    { id: 'curl',             subdomain: 'curl',             name: 'OpenVibeCurl',          icon: 'fa-download',          desc: 'Online curl — HTTP request tester' },
    { id: 'httpstatus',       subdomain: 'httpstatus',       name: 'OpenVibeHTTPStatus',    icon: 'fa-circle-check',      desc: 'HTTP status code reference & checker' },
    { id: 'latency',          subdomain: 'latency',          name: 'OpenVibeLatency',       icon: 'fa-gauge-high',        desc: 'Latency tester — measure response times' },
    // Reputation / mail / infra
    { id: 'blacklist',        subdomain: 'blacklist',        name: 'OpenVibeBlacklist',     icon: 'fa-ban',               desc: 'Blacklist / RBL check for IP & domain' },
    { id: 'reputation',       subdomain: 'reputation',       name: 'OpenVibeReputation',    icon: 'fa-star',              desc: 'Domain & IP reputation score' },
    { id: 'smtp',             subdomain: 'smtp',             name: 'OpenVibeSMTP',          icon: 'fa-paper-plane',       desc: 'SMTP server connectivity tester' },
    { id: 'uptime',           subdomain: 'uptime',           name: 'OpenVibeUptime',        icon: 'fa-heart-pulse',       desc: 'Uptime & availability monitor' },
    { id: 'robots',           subdomain: 'robots',           name: 'OpenVibeRobots',        icon: 'fa-robot',             desc: 'robots.txt analyzer' },
    { id: 'sitemap',          subdomain: 'sitemap',          name: 'OpenVibeSitemap',       icon: 'fa-sitemap',           desc: 'Sitemap.xml validator' },
];

// Quick lookup: subdomain → tool definition
const NET_TOOL_MAP = new Map(NET_TOOLS.map(t => [t.subdomain, t]));

// Alias subdomains → canonical
const NET_ALIASES = {
    'network': 'net',
    'ptr':     'rdns',
    'tls':     'ssl',
    'ipv4lookup': 'ipv4',
    'ipv6lookup': 'ipv6',
};

for (const t of NET_TOOLS) { const seo = seoFor(t.subdomain); if (seo) { t.name = seo.name; t.desc = seo.desc; t.seo = seo; } }

module.exports = { getSetting, getNetConfig, NET_TOOLS, NET_TOOL_MAP, NET_ALIASES };
