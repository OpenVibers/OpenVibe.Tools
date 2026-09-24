'use strict';
// ═══════════════════════════════════════════════════════════════
// Net.OpenVibe — what each network tool is, for the tool registry (tools.tool@1 specs, ADR-027;
// apps/_shared/tools/descriptor.js joins them with the catalogue's name, summary and hosts).
//
// Every net tool is a server lookup answered inline (execution sync) by the /api/net endpoint that
// net/config.js names for it; `route` says how its input becomes that request (the query the page
// adds: MX for mx., _dmarc. for dmarc., ten pings for latency…). They all reach a host the caller
// chose (egress), always through the SSRF guard, except myip.
//
// Who may call them (ADR-027, lead decision 1):
//   probes    port, ping, latency, traceroute, mtr: they send traffic to the target itself, so through
//             the API they need the partner capability tools.net.probe and never run anonymously;
//             people keep the pages.
//   lookups   everything else is open, with a per-target throttle across all callers
//             (limits.perTargetPerMinute). The SMTP test talks to a mail server, which a mail server
//             can hold against our address, so it needs at least a browser session or a token.
// Unavailable tools (net/config.js status) have no engine and no API until they are built.
// ═══════════════════════════════════════════════════════════════

const { NET_TOOL_MAP, getNetConfig } = require('./config');
const { PROP_TYPES, SMTP_PORTS } = require('./checks');

const DNS_TYPES = getNetConfig(null).dnsTypes;
const DEFAULT_DNS_TYPES = ['A', 'AAAA', 'MX', 'TXT', 'CNAME', 'NS', 'SOA'];   // routes.js /dns without ?types=
const TLS_PORTS = [443, 465, 636, 853, 990, 993, 995, 2083, 2087, 5061, 8443];  // direct-TLS ports the SSL check may use through the API
const PROBES = new Set(['port', 'ping', 'latency', 'traceroute', 'mtr']);

const KiB = 1024;
const MIN = 60 * 1000;
// How long the run API may reuse a lookup's answer (same tool, same input). Records and registration
// data move slowly (and the routes cache their upstreams anyway); live checks (ping, ports, headers,
// redirects, uptime, SMTP) and myip (the caller's own address) are never reused.
const CACHE_TTL = {
    dns: MIN, dig: MIN, nslookup: MIN, mx: MIN, txt: MIN, ns: MIN, spf: MIN, dkim: MIN, dmarc: MIN, dnspropagation: MIN,
    ip: 10 * MIN, geoip: 10 * MIN, isp: 10 * MIN, asn: 10 * MIN, ipv4: 10 * MIN, ipv6: 10 * MIN,
    hostname: 5 * MIN, rdns: 5 * MIN, whois: 60 * MIN, rdap: 60 * MIN,
    blacklist: 5 * MIN, ssl: 5 * MIN, robots: 5 * MIN, sitemap: 5 * MIN, lookup: 5 * MIN,
};
const target = (description) => ({ type: 'string', minLength: 1, maxLength: 253 + 2048, description });
const HOST = 'A domain or an IP address';
const URL_OR_DOMAIN = 'A URL, or a domain (https:// is assumed)';
const obj = (properties, required = ['target']) => ({ type: 'object', additionalProperties: false, required, properties });
const out = (properties, required) => ({ type: 'object', ...(required && { required }), properties });
const S = { type: 'string' }, I = { type: 'integer' }, O = { type: 'object' }, A = { type: 'array' }, B = { type: 'boolean' };
const nul = (t) => ({ type: [t.type, 'null'] });

// What each endpoint answers (routes.js and checks.js), as result.data. Extra fields may be added.
const OUTPUT = {
    '/lookup': out({ target: S, badges: { type: 'array', items: S }, ip: nul(O), dns: nul(O), rdap: nul(O), ssl: nul(O), headers: nul(O) }, ['target']),
    '/myip': out({ ip: S, version: nul(I) }, ['ip']),
    '/ip': out({ ip: S, hostname: nul(S), geo: O, network: O, reverse: nul(S) }, ['ip']),
    '/ipv4': out({ ip: S, hostname: nul(S), ipv4: O, cidr: O, note: S, geo: O, network: O }, ['ip']),
    '/ipv6': out({ ip: S, hostname: nul(S), ipv6: out({ type: S, scope: nul(S), prefix: nul(S), expanded: S, compressed: S, ptr: nul(S) }), geo: O, network: O }, ['ip', 'ipv6']),
    '/rdns': out({ ip: S, hostnames: { type: 'array', items: S }, ptr: nul(S) }, ['ip']),
    '/rdap': out({ target: S, type: { enum: ['domain', 'ip'] }, summary: O, raw: O }, ['target', 'summary']),
    '/dns': out({ target: S, server: S, records: { type: 'object', description: 'record type → answers' } }, ['target', 'records']),
    '/dnsprop': out({ target: S, type: S, resolvers: A, agree: B, answered: I, majority: nul(O) }, ['target', 'resolvers']),
    '/ping': out({ target: S, ip: S, count: I, results: A, stats: out({ min: { type: 'number' }, max: { type: 'number' }, avg: { type: 'number' }, loss: { type: 'number' } }) }, ['target', 'stats']),
    '/port': out({ target: S, ip: S, ports: { type: 'array', items: out({ port: I, status: S, ms: { type: ['number', 'null'] } }) } }, ['target', 'ports']),
    '/headers': out({ url: S, status: I, statusText: S, headers: O, timing: O, security: O, securityScore: S, server: nul(S), poweredBy: nul(S), contentType: nul(S) }, ['url', 'status', 'headers']),
    '/redirects': out({ originalUrl: S, finalUrl: S, hops: I, chain: A, stopped: S }, ['originalUrl', 'finalUrl', 'chain']),
    '/ssl': out({ target: S, ip: S, port: I, protocol: S, cipher: nul(O), certificate: O, chain: A }, ['target', 'certificate']),
    '/blacklist': out({ target: S, kind: { enum: ['ip', 'domain'] }, ip: nul(S), domain: S, listedCount: I, cleanCount: I, unknownCount: I, lists: A }, ['target', 'lists']),
    '/smtp': out({ target: S, host: S, mx: A, ip: S, port: I, connected: B, banner: S, extensions: A, starttls: O, error: S }, ['target', 'host']),
    '/uptime': out({ url: S, state: { enum: ['up', 'down'] }, status: nul(I), finalUrl: S, redirects: I, ms: I, checkedAt: S }, ['url', 'state']),
    '/robots': out({ url: S, finalUrl: S, status: I, found: B, groups: A, sitemaps: A, warnings: A, verdict: S, test: O }, ['url', 'found']),
    '/sitemap': out({ url: S, finalUrl: S, status: I, kind: nul(S), count: I, sample: A, children: A, issues: A, valid: B }, ['url', 'valid']),
};

// Per tool: its input schema, the fixed query the page adds (route.query) or how the target is built
// (route.target), the timeout, the per-target throttle and the cost. Endpoints come from net/config.js.
const TOOLS = {
    lookup: { input: obj({ target: target(`${HOST}, or a URL`) }), timeoutMs: 30000, perTarget: 10, cost: 5 },
    myip: { input: obj({}, []), timeoutMs: 2000, cost: 1 },
    ip: { input: obj({ target: target(HOST) }) }, geoip: { input: obj({ target: target(HOST) }) },
    isp: { input: obj({ target: target(HOST) }) }, asn: { input: obj({ target: target(HOST) }) },
    ipv4: { input: obj({ target: target('An IPv4 address, a CIDR block (192.168.1.0/24) or a domain') }) },
    ipv6: { input: obj({ target: target('An IPv6 address or a domain') }) },
    hostname: { input: obj({ target: target(HOST) }) }, rdns: { input: obj({ target: target(HOST) }) },
    whois: { input: obj({ target: target(HOST) }) }, rdap: { input: obj({ target: target(HOST) }) },
    dns: { input: dnsInput() }, dig: { input: dnsInput() }, nslookup: { input: dnsInput() },
    mx: { input: obj({ target: target('A domain') }), query: { types: 'MX' } },
    txt: { input: obj({ target: target('A domain') }), query: { types: 'TXT' } },
    ns: { input: obj({ target: target('A domain') }), query: { types: 'NS' } },
    spf: { input: obj({ target: target('A domain') }), query: { types: 'TXT' } },
    dmarc: { input: obj({ target: target('A domain') }), query: { types: 'TXT' }, targetTemplate: '_dmarc.{target}' },
    dkim: { input: obj({ target: target('A domain'), selector: { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,63}$', default: 'default', description: 'The DKIM selector (default, google, s1…)' } }), query: { types: 'TXT' }, targetTemplate: '{selector}._domainkey.{target}' },
    dnspropagation: { input: obj({ target: target('A domain'), type: { enum: PROP_TYPES, default: 'A' } }), timeoutMs: 25000, perTarget: 10, cost: 3 },
    ping: { input: obj({ target: target(HOST), count: { type: 'integer', minimum: 1, maximum: 10, default: 4 } }), timeoutMs: 60000, perTarget: 6, cost: 3 },
    latency: { input: obj({ target: target(HOST) }), query: { count: '10' }, timeoutMs: 60000, perTarget: 6, cost: 5 },
    traceroute: {}, mtr: {},
    port: { input: obj({ target: target(HOST), ports: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: { type: 'integer', minimum: 1, maximum: 65535 }, description: 'Default: 80, 443, 22, 21, 25, 53, 3306, 5432, 8080, 8443' } }), timeoutMs: 15000, perTarget: 6, cost: 5 },
    headers: { input: obj({ target: target(URL_OR_DOMAIN), ua: { type: 'string', maxLength: 300, description: 'User-Agent to send' } }), perTarget: 10, cost: 2 },
    curl: { input: obj({ target: target(URL_OR_DOMAIN), ua: { type: 'string', maxLength: 300 } }), perTarget: 10, cost: 2 },
    httpstatus: { input: obj({ target: target(URL_OR_DOMAIN) }), perTarget: 10, cost: 2 },
    redirects: { input: obj({ target: target(URL_OR_DOMAIN) }), timeoutMs: 60000, perTarget: 10, cost: 3 },
    ssl: { input: obj({ target: target('A domain or an IP address'), port: { enum: TLS_PORTS, default: 443 } }), perTarget: 10, cost: 2 },
    blacklist: { input: obj({ target: target('An IPv4 address or a domain') }), timeoutMs: 20000, perTarget: 10, cost: 3 },
    reputation: {},
    smtp: { input: obj({ target: target('A mail server, or a domain (its first MX is tested)'), port: { enum: SMTP_PORTS, default: 25 } }), timeoutMs: 40000, perTarget: 3, cost: 5, anonymous: false },
    uptime: { input: obj({ target: target(URL_OR_DOMAIN) }), timeoutMs: 20000, perTarget: 10, cost: 2 },
    robots: { input: obj({ target: target(URL_OR_DOMAIN), path: { type: 'string', maxLength: 2048, description: 'A path (or URL) to test against the rules' }, ua: { type: 'string', maxLength: 100, default: '*', description: 'The crawler to test as' } }), perTarget: 10, cost: 2 },
    sitemap: { input: obj({ target: target('A sitemap URL, or a domain (its robots.txt Sitemap line, else /sitemap.xml)') }), timeoutMs: 45000, perTarget: 5, cost: 5 },
};

function dnsInput() {
    return obj({
        target: target('A domain'),
        types: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: DNS_TYPES }, default: DEFAULT_DNS_TYPES },
        server: { type: 'string', maxLength: 45, pattern: '^[0-9A-Fa-f:.]+$', description: 'Ask this public DNS server (an IP address) instead of the system resolver' },
        doh: { type: 'boolean', default: false, description: 'Ask over DNS-over-HTTPS' },
    });
}

function spec(id) {
    const def = NET_TOOL_MAP.get(id);
    if (!def || def.hub) throw new Error(`net: ${id} is not a tool in net/config.js`);
    const t = TOOLS[id];
    if (!t) throw new Error(`net: ${id} has no descriptor`);
    const probe = PROBES.has(id);
    const egress = id !== 'myip';
    const anonymous = !probe && t.anonymous !== false;
    const unavailable = def.status === 'unavailable';
    const endpoint = def.endpoint;
    return {
        id, execution: 'sync', api: !unavailable,
        ...(unavailable && { status: 'unavailable', statusReason: def.unavailable }),
        input: unavailable ? null : t.input,
        files: null,
        output: { kind: 'json', schema: OUTPUT[endpoint] || out({}) },
        limits: {
            timeoutMs: t.timeoutMs || 15000, ...(!unavailable && { maxInputBytes: 4 * KiB }),
            ...(egress && { perTargetPerMinute: t.perTarget || 20 }),
        },
        auth: { anonymous, capability: probe ? 'tools.net.probe' : 'tools.tool.run' },
        quotaClass: probe ? 'tools-probe' : egress ? 'tools-fetch' : 'tools-run', cost: t.cost || 1, egress,
        ...(endpoint && {
            legacy: [`GET /api/net${endpoint}${endpoint === '/myip' ? '' : '/:target'}`],
            route: { method: 'GET', path: `/api/net${endpoint}`, ...(t.query && { query: t.query }), ...(t.targetTemplate && { target: t.targetTemplate }) },
        }),
        example: { input: endpoint === '/myip' ? {} : { target: 'example.com' } },
        cacheTtlMs: CACHE_TTL[id] || 0,
    };
}

const IDS = ['lookup', 'myip', 'ip', 'ipv4', 'ipv6', 'geoip', 'hostname', 'isp', 'asn', 'rdns', 'whois', 'rdap', 'dns', 'dig', 'nslookup', 'dnspropagation', 'mx', 'txt', 'ns', 'spf', 'dkim', 'dmarc', 'ping', 'traceroute', 'mtr', 'port', 'headers', 'redirects', 'ssl', 'curl', 'httpstatus', 'latency', 'blacklist', 'reputation', 'smtp', 'uptime', 'robots', 'sitemap'];
const SPECS = IDS.map(spec);

module.exports = { SPECS, OUTPUT, PROBES, TLS_PORTS };
