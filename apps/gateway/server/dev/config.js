'use strict';

// ═══════════════════════════════════════════════════════════════
// Dev.OpenVibe — Developer & SEO Tools Configuration
// ═══════════════════════════════════════════════════════════════

const DEV_TOOLS = [
    // Hub
    { id: 'dev',       subdomain: 'dev',       name: 'Dev.OpenVibe',       icon: 'fa-code',                 desc: 'Developer & SEO Tools Hub', hub: true, category: 'hub' },

    // Data & Formats
    { id: 'json',      subdomain: 'json',      name: 'OpenVibeJSON',      icon: 'fa-code',                 desc: 'JSON formatter, validator, minifier & converter', category: 'data' },
    { id: 'yaml',      subdomain: 'yaml',      name: 'OpenVibeYAML',      icon: 'fa-file-code',            desc: 'YAML formatter, validator & JSON converter', category: 'data' },
    { id: 'xml',       subdomain: 'xml',       name: 'OpenVibeXML',       icon: 'fa-file-code',            desc: 'XML formatter, validator & converter', category: 'data' },
    { id: 'csv',       subdomain: 'csv',       name: 'OpenVibeCSV',       icon: 'fa-table',                desc: 'CSV viewer, converter & JSON transformer', category: 'data' },
    { id: 'sql',       subdomain: 'sql',       name: 'OpenVibeSQL',       icon: 'fa-database',             desc: 'SQL formatter & syntax highlighter', category: 'data' },
    { id: 'markdown',  subdomain: 'markdown',  name: 'OpenVibeMarkdown',  icon: 'fa-file-lines',           desc: 'Markdown editor with live HTML preview', category: 'data' },
    { id: 'html',      subdomain: 'html',      name: 'OpenVibeHTML',      icon: 'fa-file-code',            desc: 'HTML formatter, minifier & entity encoder', category: 'data' },

    // Encoding & Crypto
    { id: 'base64',    subdomain: 'base64',    name: 'OpenVibeBase64',    icon: 'fa-lock',                 desc: 'Base64 encode & decode text and files', category: 'encoding' },
    { id: 'url',       subdomain: 'url',       name: 'OpenVibeURL',       icon: 'fa-link',                 desc: 'URL encode, decode & component parser', category: 'encoding' },
    { id: 'jwt',       subdomain: 'jwt',       name: 'OpenVibeJWT',       icon: 'fa-key',                  desc: 'JWT decoder — inspect header, payload & expiry', category: 'encoding' },
    { id: 'uuid',      subdomain: 'uuid',      name: 'OpenVibeUUID',      icon: 'fa-fingerprint',          desc: 'UUID v4 generator, bulk generate & validator', category: 'encoding' },
    { id: 'hash',      subdomain: 'hash',      name: 'OpenVibeHash',      icon: 'fa-hashtag',              desc: 'SHA-1, SHA-256 & SHA-512 hash generator', category: 'encoding' },
    { id: 'hex',       subdomain: 'hex',       name: 'OpenVibeHex',       icon: 'fa-barcode',              desc: 'Hex encoder/decoder & binary converter', category: 'encoding' },
    { id: 'escape',    subdomain: 'escape',    name: 'OpenVibeEscape',    icon: 'fa-shield-halved',        desc: 'HTML, JavaScript & URL escape/unescape', category: 'encoding' },

    // Time & Scheduling
    { id: 'timestamp', subdomain: 'timestamp', name: 'OpenVibeTimestamp', icon: 'fa-clock',                desc: 'Unix timestamp ↔ date converter with timezones', category: 'time' },
    { id: 'cron',      subdomain: 'cron',      name: 'OpenVibeCron',      icon: 'fa-calendar-check',       desc: 'Cron expression parser with next run calculator', category: 'time' },

    // Code Quality
    { id: 'beautify',  subdomain: 'beautify',  name: 'OpenVibeBeautify',  icon: 'fa-wand-magic-sparkles',  desc: 'Beautify & format JS, HTML, CSS, JSON & SQL', category: 'quality' },
    { id: 'minify',    subdomain: 'minify',    name: 'OpenVibeMinify',    icon: 'fa-compress',             desc: 'Minify JS, HTML, CSS & JSON', category: 'quality' },
    { id: 'diff',      subdomain: 'diff',      name: 'OpenVibeDiff',      icon: 'fa-code-compare',         desc: 'Side-by-side text & code diff checker', category: 'quality' },
    { id: 'regex',     subdomain: 'regex',     name: 'OpenVibeRegex',     icon: 'fa-magnifying-glass',     desc: 'Regex tester with match highlighting & capture groups', category: 'quality' },
    { id: 'slug',      subdomain: 'slug',      name: 'OpenVibeSlug',      icon: 'fa-link',                 desc: 'URL slug generator from any text', category: 'quality' },
    { id: 'lorem',     subdomain: 'lorem',     name: 'OpenVibeLorem',     icon: 'fa-paragraph',            desc: 'Lorem ipsum & placeholder text generator', category: 'quality' },

    // HTTP & API
    { id: 'curl',      subdomain: 'curl',      name: 'OpenVibeCurl',      icon: 'fa-terminal',             desc: 'Parse curl commands & convert to fetch, Python, Node.js', category: 'http' },
    { id: 'webhook',   subdomain: 'webhook',   name: 'OpenVibeWebhook',   icon: 'fa-satellite-dish',       desc: 'Webhook request inspector & debugging bin', category: 'http' },

    // Frontend & SEO
    { id: 'color',     subdomain: 'color',     name: 'OpenVibeColor',     icon: 'fa-palette',              desc: 'Color picker, HEX/RGB/HSL converter & palette generator', category: 'frontend' },
    { id: 'opengraph', subdomain: 'opengraph', name: 'OpenVibeOpenGraph', icon: 'fa-share-nodes',          desc: 'Open Graph & Twitter Card preview & validator', category: 'frontend' },
];

const DEV_TOOL_MAP = new Map();
for (const t of DEV_TOOLS) DEV_TOOL_MAP.set(t.subdomain, t);

const DEV_ALIASES = {
    code:         'dev',
    build:        'dev',
    debug:        'dev',
    compare:      'diff',
    format:       'beautify',
    prettier:     'beautify',
    md:           'markdown',
    colours:      'color',
    colors:       'color',
    og:           'opengraph',
    guid:         'uuid',
    unix:         'timestamp',
    unixtime:     'timestamp',
    epoch:        'timestamp',
    jwtdecode:    'jwt',
    b64:          'base64',
    urlencode:    'url',
    urldecode:    'url',
    entities:     'escape',
    htmlentities: 'escape',
    checksum:     'hash',
    sha256:       'hash',
    sha1:         'hash',
    sha512:       'hash',
    ini:          'json',
    toml:         'json',
    env:          'json',
    request:      'curl',
    http:         'curl',
};

module.exports = { DEV_TOOLS, DEV_TOOL_MAP, DEV_ALIASES };
