'use strict';

// ═══════════════════════════════════════════════════════════════
// YT.OpenVibe — hosts and the server-rendered <head>
//
// public/index.html carries the tool and its crawlable copy; the head is stamped here per
// request so canonical / Open Graph / Twitter / JSON-LD name the right host:
//   - through the gateway (X-OV-* headers): the canonical host it names, so the short host
//     (yt.…) points at youtube-downloader.… or at a custom domain;
//   - reached directly: the host itself, as before.
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { canonicalHostFor, requestHost, isLocalHost } = require('../../_shared/host-role');

const PUBLIC = path.join(__dirname, '..', 'public');

// Code defaults; the gateway's catalog (and the Network's domain overrides) win when present.
const HOSTS = {
    canonical: 'youtube-downloader.openvibe.tools',
    short: 'yt.openvibe.tools',
    aliases: ['youtube.openvibe.tools', 'ytdl.openvibe.tools'],
};
const DEFAULT_HOST = HOSTS.short;

const knowsHost = (host) => host === HOSTS.canonical || host === HOSTS.short;
const aliasOf = (host) => (HOSTS.aliases.includes(host) ? HOSTS.short : '');

const TITLE = 'YouTube Downloader — Save Video & Audio | OpenVibe';
const DESCRIPTION = 'Download YouTube videos as MP4 or WebM up to 1080p, or keep just the audio as MP3, M4A, Opus or FLAC. Paste a link, pick a format, save the file.';
const KEYWORDS = ['youtube downloader', 'youtube to mp3', 'youtube to mp4', 'download youtube video', 'youtube audio downloader', 'youtube to flac'];

// The same questions are printed on the page (public/index.html) — keep the two in step.
const FAQ = [
    { q: 'How do I download a YouTube video?',
      a: 'Copy the video link from YouTube, paste it into the box at the top of this page and press Fetch. Pick a video quality or an audio format, press Download, and when the file is ready press Save file.' },
    { q: 'Which formats and qualities can I choose?',
      a: 'Video is saved as MP4 at the best available quality, 1080p, 720p, 480p or 360p, or as WebM (VP9). Audio only can be saved as MP3, M4A (AAC), Opus or FLAC.' },
    { q: 'How do I convert a YouTube video to MP3?',
      a: 'Paste the link, choose MP3 under Audio Only and press Download. The audio track is extracted and converted on the server, then offered as a single MP3 file named after the video.' },
    { q: 'Is it legal to download YouTube videos?',
      a: 'That depends on the video and on where you live. Downloading your own uploads, public-domain works and videos whose licence allows copies (for example Creative Commons) is generally fine. Other videos are protected by copyright and YouTube\'s terms of service restrict downloading them without permission. You are responsible for having the right to save what you download.' },
    { q: 'How long is my file kept?',
      a: 'Files are temporary. A finished download stays on the server for about an hour so you can save it, then it is deleted automatically.' },
    { q: 'Why did a download fail?',
      a: 'Private, members-only and age-restricted videos cannot be fetched, and very long videos (over three hours) are refused. If a quality is not offered for a video, pick another one. Occasionally YouTube rate-limits the server; trying again a few minutes later usually works.' },
];

const HOWTO_STEPS = [
    { name: 'Copy the video link', text: 'Open the video on YouTube and copy its address (youtube.com/watch… or youtu.be/…).' },
    { name: 'Paste it here', text: 'Paste the link into the box on this page and press Fetch to load the title, thumbnail and length.' },
    { name: 'Choose a format', text: 'Pick a video quality (up to 1080p MP4, or WebM) or an audio format (MP3, M4A, Opus, FLAC).' },
    { name: 'Download and save', text: 'Press Download, watch the progress, then press Save file. The file is named after the video.' },
];

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ldScript = (obj) => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;

function headTags(canonicalHost) {
    const url = `https://${canonicalHost}/`;
    const image = `https://${canonicalHost}/og.png`;
    const ld = [
        {
            '@context': 'https://schema.org', '@type': 'SoftwareApplication',
            name: 'OpenVibe YouTube Downloader', url, description: DESCRIPTION, image,
            applicationCategory: 'MultimediaApplication', operatingSystem: 'Any (web browser)',
            keywords: KEYWORDS.join(', '),
            featureList: ['MP4 up to 1080p', 'WebM (VP9)', 'MP3', 'M4A (AAC)', 'Opus', 'FLAC', 'Live progress with speed and time remaining'],
            publisher: { '@type': 'Organization', name: 'OpenVibe', url: 'https://openvibe.network/' },
        },
        {
            '@context': 'https://schema.org', '@type': 'HowTo',
            name: 'How to download a YouTube video', description: DESCRIPTION, url, image,
            totalTime: 'PT1M',
            step: HOWTO_STEPS.map((s, i) => ({ '@type': 'HowToStep', position: i + 1, name: s.name, text: s.text, url: `${url}#how-to` })),
        },
        {
            '@context': 'https://schema.org', '@type': 'FAQPage', url,
            mainEntity: FAQ.map(f => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
        },
        {
            '@context': 'https://schema.org', '@type': 'BreadcrumbList',
            itemListElement: [
                { '@type': 'ListItem', position: 1, name: 'OpenVibe Tools', item: 'https://openvibe.tools/' },
                { '@type': 'ListItem', position: 2, name: 'YouTube Downloader', item: url },
            ],
        },
    ];

    return [
        `<title>${esc(TITLE)}</title>`,
        `<meta name="description" content="${esc(DESCRIPTION)}">`,
        `<meta name="keywords" content="${esc(KEYWORDS.join(', '))}">`,
        `<link rel="canonical" href="${url}">`,
        '<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">',
        `<meta property="og:title" content="${esc(TITLE)}">`,
        `<meta property="og:description" content="${esc(DESCRIPTION)}">`,
        '<meta property="og:type" content="website">',
        `<meta property="og:url" content="${url}">`,
        `<meta property="og:image" content="${image}">`,
        '<meta property="og:image:width" content="1200">',
        '<meta property="og:image:height" content="630">',
        '<meta property="og:site_name" content="OpenVibe">',
        '<meta property="og:locale" content="en_US">',
        '<meta name="twitter:card" content="summary_large_image">',
        `<meta name="twitter:title" content="${esc(TITLE)}">`,
        `<meta name="twitter:description" content="${esc(DESCRIPTION)}">`,
        `<meta name="twitter:image" content="${image}">`,
        ...ld.map(ldScript),
    ].join('\n    ');
}

/** The how-to and the questions, visible on the page (and readable without JavaScript). */
function contentBlock() {
    return `<section class="yt-info" id="how-to" aria-labelledby="yt-howto-h"><h2 id="yt-howto-h">How to download a YouTube video</h2><ol>${HOWTO_STEPS.map(s => `<li><b>${esc(s.name)}.</b> ${esc(s.text)}</li>`).join('')}</ol></section>
<section class="yt-info" id="faq" aria-labelledby="yt-faq-h"><h2 id="yt-faq-h">Questions</h2>${FAQ.map(f => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('')}
<p class="yt-more">More tools: <a href="https://openvibe.tools/">every OpenVibe tool</a> · <a href="https://openvibe.tools/audio-tools">audio tools</a> · <a href="https://openvibe.tools/image-tools">image tools</a></p></section>
<style>.yt-info{max-width:760px;margin:36px auto 0;padding:0 20px;color:var(--text-secondary,#a8b3c4);line-height:1.6}.yt-info h2{color:var(--text-primary,#e6edf7);font-size:20px;margin:0 0 10px}.yt-info li{margin:6px 0}.yt-info details{border-bottom:1px solid var(--border,rgba(255,255,255,.08));padding:10px 0}.yt-info summary{cursor:pointer;color:var(--text-primary,#e6edf7);font-weight:600}.yt-more{margin-top:18px;font-size:14px}</style>`;
}

let _base = null;
const _cache = new Map();

function baseHtml() {
    if (_base === null || process.env.NODE_ENV === 'development') _base = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
    return _base;
}

function renderIndex(canonicalHost) {
    if (process.env.NODE_ENV !== 'development' && _cache.has(canonicalHost)) return _cache.get(canonicalHost);
    const out = baseHtml().replace('<!--OV:HEAD-->', headTags(canonicalHost)).replace('<!--OV:CONTENT-->', contentBlock());
    if (_cache.size > 50) _cache.clear();
    _cache.set(canonicalHost, out);
    return out;
}

/** Express handler: the page with this request's canonical host stamped into the head. */
function sendIndex(req, res) {
    const host = requestHost(req);
    const own = !host || isLocalHost(host) ? DEFAULT_HOST : host;
    // Reached directly (no gateway headers) on the short host: the canonical is still the descriptive host.
    const canonicalHost = canonicalHostFor(req, own === HOSTS.short ? HOSTS.canonical : own);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Vary', 'X-OV-Canonical-Host');
    return res.send(renderIndex(canonicalHost));
}

module.exports = { HOSTS, TITLE, DESCRIPTION, FAQ, HOWTO_STEPS, knowsHost, aliasOf, headTags, renderIndex, sendIndex };
