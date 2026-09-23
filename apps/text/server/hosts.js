'use strict';

// ── Hostname → HTML file mapping ─────────────────────────────
// Each subdomain gets its own static HTML page for SEO + focused UX.
// Every host here must also be in deploy/nginx/text.openvibe.tools.conf, and must not be
// claimed by another app's vhost or by the gateway's net/dev catalogs: json., markdown.,
// escape., diff., compare. and slug. are ours (the gateway's generic versions moved to
// jsonfmt., md., entities., codediff. and slugify.).
const HOSTNAME_MAP = {
    // Text hubs
    'text.openvibe.tools':       'index.html',
    'type.openvibe.tools':       'index.html',
    'fonts.openvibe.tools':      'index.html',
    // Fancy text generators
    'fancy.openvibe.tools':      'fancy.html',
    'zalgo.openvibe.tools':      'zalgo.html',
    'ascii.openvibe.tools':      'ascii.html',
    'symbols.openvibe.tools':    'symbols.html',
    'unicode.openvibe.tools':    'unicode.html',
    'bubble.openvibe.tools':     'bubble.html',
    'glitch.openvibe.tools':     'zalgo.html',
    'smallcaps.openvibe.tools':  'fancy.html',
    'cursive.openvibe.tools':    'fancy.html',
    'gothic.openvibe.tools':     'fancy.html',
    'wide.openvibe.tools':       'fancy.html',
    'monospaced.openvibe.tools': 'fancy.html',
    'braille.openvibe.tools':    'braille.html',
    'morse.openvibe.tools':      'morse.html',
    'binary.openvibe.tools':     'binary.html',
    // Quick-action text tools
    'case.openvibe.tools':       'case.html',
    'caps.openvibe.tools':       'case.html',
    'titlecase.openvibe.tools':  'case.html',
    // reverse.openvibe.tools is the Audio app's (reverse an audio file); the text flipper
    // lives on reversetext. + mirror. instead. Keep this in step with deploy/nginx.
    'reversetext.openvibe.tools':'reverse.html',
    'mirror.openvibe.tools':     'reverse.html',
    'clean.openvibe.tools':      'clean.html',
    'strip.openvibe.tools':      'clean.html',
    'count.openvibe.tools':      'count.html',
    'lines.openvibe.tools':      'count.html',
    'sort.openvibe.tools':       'sort.html',
    'dedupe.openvibe.tools':     'sort.html',
    'slug.openvibe.tools':       'slug.html',
    'compare.openvibe.tools':    'compare.html',
    'diff.openvibe.tools':       'compare.html',
    'markdown.openvibe.tools':   'markdown.html',
    'json.openvibe.tools':       'json.html',
    'escape.openvibe.tools':     'escape.html',
    // Identity / social
    'bio.openvibe.tools':        'bio.html',
    'nickname.openvibe.tools':   'nickname.html',
    'username.openvibe.tools':   'nickname.html',
    'gamertag.openvibe.tools':   'nickname.html',
    'kaomoji.openvibe.tools':    'kaomoji.html',
    'emojis.openvibe.tools':     'kaomoji.html',
    'copypaste.openvibe.tools':  'symbols.html',
    // ASCII art / banners
    'banner.openvibe.tools':     'ascii.html',
    'textart.openvibe.tools':    'ascii.html',
    'figlet.openvibe.tools':     'ascii.html',
    // Logo / title / design
    'logo.openvibe.tools':       'logo-hub.html',
    'title.openvibe.tools':      'title.html',
    'wordmark.openvibe.tools':   'wordmark.html',
    'textlogo.openvibe.tools':   'wordmark.html',
    'transparent.openvibe.tools':'transparent.html',
    'badge.openvibe.tools':      'badge.html',
    'sticker.openvibe.tools':    'badge.html',
    'thumbnail.openvibe.tools':  'thumbnail.html',
    'cover.openvibe.tools':      'thumbnail.html',
    'channelart.openvibe.tools': 'thumbnail.html',
    'watermark.openvibe.tools':  'watermark.html',
    'neon.openvibe.tools':       'wordmark.html',
    'overlay.openvibe.tools':    'watermark.html',
    'lowerthird.openvibe.tools': 'watermark.html',
    // Community / Mexican tools
    'ice.openvibe.tools':        'ice.html',
    'peso.openvibe.tools':       'peso.html',
    'currency.openvibe.tools':   'peso.html',
    'mxn.openvibe.tools':        'peso.html',
    'spanish.openvibe.tools':    'spanish.html',
    'espanol.openvibe.tools':    'spanish.html',
    'slang.openvibe.tools':      'slang.html',
};

module.exports = { HOSTNAME_MAP };
