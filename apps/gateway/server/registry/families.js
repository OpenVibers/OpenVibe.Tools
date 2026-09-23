'use strict';

// ═══════════════════════════════════════════════════════════════
// Tool families — the sections of openvibe.tools.
//
//   id     stable key used by tools (`tool.family`) and by the Network launcher
//   path   the family page on the apex (openvibe.tools/<path>)
//   hub    the subdomain that serves the family's own hub app, when it has one
//   port   the satellite that serves the family (null = this gateway)
// ═══════════════════════════════════════════════════════════════

const FAMILIES = [
    {
        id: 'net', name: 'Network Tools', icon: 'network', path: '/network-tools', hub: 'net', hubAliases: ['network'], port: null,
        tagline: 'Look up DNS, IPs, domains, certificates and mail servers',
        description: 'Diagnostics for anyone who runs a website, a mail server or a home network. Look up DNS records, find out who owns an IP address or a domain, check an SSL certificate, test a port or a mail server, check blacklists and see whether a site is up from outside your own network.',
        intro: 'These tools answer the questions that come up when something on the internet does not work: where does this domain point, why is mail bouncing, is the certificate about to expire, is the site down for everyone. Each one takes a domain, an IP address or a URL and gives a readable answer in a few seconds.',
        faq: [
            ['Do I need to install anything?', 'No. Every lookup runs from our servers and the result appears in your browser, so the tools work on a phone, a locked-down work laptop or a Chromebook.'],
            ['Where do the lookups run from?', 'Every check runs from the OpenVibe server, outside your own network. Ping and latency are timed TCP connections; traceroute and MTR are not available because they need raw network access the server does not give the tools.'],
            ['Can I check a server inside my own network?', 'No. The checks come from the public internet, so the target has to be reachable from outside your network.'],
        ],
    },
    {
        id: 'dev', name: 'Developer Tools', icon: 'code', path: '/developer-tools', hub: 'dev', hubAliases: ['code', 'build', 'debug'], port: null,
        tagline: 'Format, convert, encode and test data while you code',
        description: 'Small utilities for everyday programming: format and validate JSON, YAML, XML and SQL, decode Base64 and JWTs, test regular expressions, compare two files, generate UUIDs and hashes, read cron expressions and convert timestamps.',
        intro: 'Paste something in, get the answer, move on. Most of these tools do their work inside your browser, so the data you paste is not uploaded. The few that need the network, such as the Open Graph preview and the webhook inspector, say so on the page.',
        faq: [
            ['Is the data I paste sent to a server?', 'Formatters, encoders, generators and the diff tool run in your browser. Tools that have to fetch a URL for you make one request to that URL and nothing else.'],
            ['Do the tools work offline?', 'Once a page has loaded, the browser-side tools keep working without a connection.'],
            ['Is there a size limit?', 'Browser-side tools are limited only by your device memory. Documents of a few megabytes are fine.'],
        ],
    },
    {
        id: 'img', name: 'Image Tools', icon: 'image', path: '/image-tools', hub: 'img', hubAliases: [], port: 4012,
        tagline: 'Convert, compress, resize and crop pictures',
        description: 'Change an image from one format to another, make it smaller, resize it to exact pixel dimensions or crop it to a ratio. Works with PNG, JPG, WebP, AVIF, HEIC photos from iPhones, SVG, GIF, ICO, TIFF and BMP.',
        intro: 'Pick the tool named after what you want to end up with: a PNG, a smaller file, a square crop, a favicon. Drop one or more pictures on the page, adjust the quality or size if you want to, and download the result.',
        faq: [
            ['Which image formats can I upload?', 'PNG, JPG, WebP, AVIF, HEIC and HEIF, SVG, GIF, ICO, TIFF and BMP are accepted by every image tool.'],
            ['What happens to my pictures?', 'Files are processed on our server, kept only long enough for you to download the result, and then deleted.'],
            ['Can I convert several images at once?', 'Yes. Drop a batch of files and download the results one by one or together.'],
        ],
    },
    {
        id: 'audio', name: 'Audio Tools', icon: 'audio', path: '/audio-tools', hub: 'audio', hubAliases: ['convert.audio'], port: 4014,
        tagline: 'Convert, cut, clean up and add effects to sound files',
        description: 'Convert recordings between MP3, WAV, FLAC, OGG, M4A and other formats, trim a clip, join files, change speed or pitch, remove background noise, make a ringtone or pull the soundtrack out of a video.',
        intro: 'Upload a sound file (or a video, for the extractor), choose what to do with it and download the result. Format converters let you pick the bitrate; the editing tools show a preview before you commit.',
        faq: [
            ['Which audio formats are supported?', 'MP3, WAV, FLAC, OGG, M4A, AAC, Opus, WMA, AIFF and AC3, plus the audio track of common video files such as MP4, MKV and WebM.'],
            ['Will converting reduce the quality?', 'Converting to a lossless format such as WAV or FLAC keeps everything. Converting to MP3, AAC, OGG or Opus discards some detail; pick a higher bitrate to keep more of it.'],
            ['How large can a file be?', 'Uploads of up to 100 MB are accepted, which covers most songs, podcasts and voice recordings.'],
        ],
    },
    {
        id: 'docs', name: 'PDF & Document Tools', icon: 'pdf', path: '/pdf-tools', hub: 'docs', hubAliases: ['pdf'], port: 4016,
        tagline: 'Merge, split, compress, protect and convert PDFs',
        description: 'Everyday PDF jobs without desktop software: combine several PDFs into one, pull pages out, shrink a file so it fits in an email, rotate or reorder pages, add a watermark or a password, and turn pictures into a PDF or a PDF into pictures.',
        intro: 'Each tool does one job. Upload your PDF or images, set the options, and download the new file. Your original is never changed.',
        faq: [
            ['Are my documents kept?', 'No. Files are processed, offered for download and then removed from the server.'],
            ['Can I unlock a PDF without the password?', 'No. The unlock tool removes protection from a PDF when you know its password; it does not break into files.'],
            ['Is there a page limit?', 'Documents of up to 500 pages are accepted, and each file can be up to 100 MB. PDF to image converts up to 50 pages at a time (fewer at high resolution).'],
        ],
    },
    {
        id: 'text', name: 'Text & Logo Tools', icon: 'text', path: '/text-tools', hub: 'text', hubAliases: ['type', 'fonts'], port: 4015,
        tagline: 'Fancy fonts, text clean-up, counters, logos and banners',
        description: 'Generators and fixers for words: fancy Unicode fonts for social profiles, case converters, word counters, line sorters, text comparison, Morse, Braille and binary translators, plus simple makers for logos, stream titles, thumbnails, badges and watermarks.',
        intro: 'Type or paste your text and copy the result. Everything here works instantly in the browser. The logo and graphics makers export a PNG you can use on a stream, a channel or a profile.',
        faq: [
            ['How do the fancy fonts work?', 'They are not fonts. The generators swap your letters for look-alike Unicode characters, which is why the result can be pasted into a bio, a username or a chat message.'],
            ['Will the styled text show up everywhere?', 'Almost every modern phone and browser displays these characters. A few older devices show empty boxes for the rarer styles.'],
            ['Can I use the logos I make commercially?', 'Yes. What you make is yours. Check the licence of any font or image you add yourself.'],
        ],
    },
    {
        id: 'media', name: 'Video Tools (YouTube)', icon: 'youtube', path: '/video-tools', hub: null, hubAliases: [], port: 4013,
        tagline: 'Save YouTube videos and audio',
        description: 'Download a YouTube video as an MP4 in the resolution you choose, or keep only the sound as an MP3 or M4A file. Useful for watching offline, archiving your own uploads and saving talks or music you have the right to keep.',
        intro: 'Paste a video link, choose video or audio and the quality, and the file is prepared on our server while a progress bar shows how far along it is.',
        faq: [
            ['Which sites are supported?', 'YouTube videos, Shorts and music links. Live streams can be saved once they have ended.'],
            ['Is downloading from YouTube allowed?', 'Download only videos you own, videos in the public domain or under a licence that permits it, or where your local law allows a personal copy.'],
            ['Why does a long video take a while?', 'The server fetches the video and the audio separately and joins them. A one-hour 1080p video usually takes a minute or two.'],
        ],
    },
    {
        id: 'places', name: 'Maps & Food', icon: 'map', path: '/maps-and-food', hub: null, hubAliases: [], port: null,
        tagline: 'Find water, shelter, supplies and somewhere to eat',
        description: 'Two practical maps. The survival map shows drinking water, public toilets, shelters, hospitals, fuel and other essentials near any place on earth. The food finder shows restaurants, cafes, markets and food banks around you.',
        intro: 'Both tools use open map data. Allow location access or search for a town, then filter the map to the kind of place you need.',
        faq: [
            ['Where does the map data come from?', 'OpenStreetMap and other open datasets, maintained by volunteers around the world. Coverage is best in towns and cities.'],
            ['Do I have to share my location?', 'No. You can search for any place by name instead.'],
        ],
    },
    {
        id: 'pastes', name: 'Pastes', icon: 'paste', path: null, hub: null, hubAliases: [], port: null, external: 'https://openvibe.community/',
        tagline: 'Share text and code snippets with a link',
        description: 'Pastes now live on OpenVibe.Community. Post a snippet of text or code, get a short link, and let people comment on it.',
        intro: '', faq: [],
    },
];

const FAMILY_MAP = new Map(FAMILIES.map((f) => [f.id, f]));

module.exports = { FAMILIES, FAMILY_MAP };
