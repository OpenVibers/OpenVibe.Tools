'use strict';

// ═══════════════════════════════════════════════════════════════
// The tool frame for the YouTube downloader (openvibe-shared ≥ 4.57.1, owner ask 11, part 2).
//
// The downloader is one tool on two hosts (yt.openvibe.tools and youtube-downloader.openvibe.tools),
// so its page is a tool page in the shared frame: the head (the crumb, the name, one sentence, the
// terms), the box (the link field and the app's own steps), the answer (the file it made and Download),
// the family, the folds and "People also use".
//
// The page around the tool changes; the download itself does not. The app's own sections keep their
// ids, so its script still finds them.
//
// The terms come from the app's real configuration: the file's lifetime from the cleanup config
// (config.js retention), its size and length from the download limits, and the rate from the guard's
// quota table and the tool's own cost in it.
// ═══════════════════════════════════════════════════════════════

const kit = require('openvibe-shared/kit');
const serve = require('openvibe-shared/serve');
const frame = require('../../_shared/frame')({ kit, serve });
const config = require('./config');
const { SPECS } = require('./descriptors');

const esc = kit.esc;
const SPEC = SPECS.find((s) => s.id === 'yt') || {};
const SITE = 'https://openvibe.tools';

// The hubs the other tools live in (the gateway's own families).
const HUBS = [
    { href: `${SITE}/video-tools`, label: 'Video Tools', short: 'Video' },
    { href: `${SITE}/audio-tools`, label: 'Audio Tools', short: 'Audio' },
    { href: `${SITE}/image-tools`, label: 'Image Tools', short: 'Image' },
    { href: `${SITE}/pdf-tools`, label: 'PDF & Document Tools', short: 'PDF' },
    { href: `${SITE}/text-tools`, label: 'Text & Logo Tools', short: 'Text' },
];

/** The length of a video in the words a person reads: "3 hours", "12 minutes". */
function lengthOf(seconds) {
    const s = Number(seconds) || 0;
    if (s >= 3600) return `${Math.round(s / 3600)} hour${Math.round(s / 3600) === 1 ? '' : 's'}`;
    if (s >= 60) return `${Math.round(s / 60)} minute${Math.round(s / 60) === 1 ? '' : 's'}`;
    return `${s} second${s === 1 ? '' : 's'}`;
}

/**
 * The terms of the downloader, from the app's real configuration and the guard's quota table.
 * @returns {Array<{text: string, icon: string}>}
 */
function termsOf() {
    const facts = frame.terms({
        work: 'server',
        ttlMs: config.retention.fileTTL,
        maxBytes: config.download.maxFilesize * 1024 * 1024,
        maxFiles: 1,
        quotaClass: SPEC.quotaClass || 'tools-download',
        cost: SPEC.cost || 50,
        unit: 'downloads',
    });
    // The length of the video is the download limit the app enforces.
    const at = facts.findIndex((f) => f.text.includes('up to'));
    const limit = { text: `Up to ${lengthOf(config.download.maxDuration)} long`, icon: 'clock' };
    if (at >= 0) facts.splice(at + 1, 0, limit);
    else facts.push(limit);
    return facts;
}

/** The family: the tool hubs this tool sits next to. */
function familyItems() {
    return HUBS.map((h, i) => ({ ...h, current: i === 0 }));
}

/** "People also use": the hubs, as rows. */
function relatedItems() {
    return HUBS.slice(1, 4).map((h) => kit.row({ href: h.href, title: h.label, sub: '' }));
}

/**
 * The box: the link field, the one button, and the app's own steps (the video card, the formats, the
 * progress and the error). The ids are the app's, so its script keeps working.
 */
function boxFor() {
    return `<form class="ovk-tool-form" id="ovk-yt-form" onsubmit="return false">
        <label class="ovk-tool-label" for="url-input">Video link</label>
        <div class="ovk-tool-row">
            <span class="ovk-tool-field"><input id="url-input" name="url" type="url" placeholder="Paste a YouTube link here…" autocomplete="off" spellcheck="false"></span>
            ${frame.verbButton('Fetch the video', { id: 'fetch-btn', icon: 'search' })}
        </div>
        <p class="ovk-try"><span>Try</span><a href="?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Daqz-KE-bpKQ" data-ovk-try="https://www.youtube.com/watch?v=aqz-KE-bpKQ" data-ovk-name="url" data-ovk-for="#url-input">Big Buck Bunny</a></p>
        <section class="loading" id="loading" style="display:none"><div class="spinner"></div><p>Fetching video info…</p></section>
        <section class="video-card" id="video-card" style="display:none">
            <div class="video-thumb" id="video-thumb"></div>
            <div class="video-info" id="video-info"></div>
        </section>
        <section class="format-section" id="format-section" style="display:none">
            <h3>Choose a format</h3>
            <div class="format-groups">
                <div class="format-group">
                    <h4><i class="fa-solid fa-video"></i> Video</h4>
                    <div class="format-list" id="video-formats"></div>
                </div>
                <div class="format-group">
                    <h4><i class="fa-solid fa-music"></i> Audio only</h4>
                    <div class="format-list" id="audio-formats"></div>
                </div>
            </div>
            <div class="ovk-tool-buttons">${frame.verbButton('Start the download', { id: 'download-btn', icon: 'download' })}</div>
        </section>
        <section class="progress-section" id="progress-section" style="display:none">
            <h3 id="progress-title">Downloading…</h3>
            <div class="progress-bar-wrap"><div class="progress-bar" id="progress-bar"></div></div>
            <div class="progress-stats" id="progress-stats"></div>
        </section>
        <section class="error-section" id="error-section" style="display:none">
            <div class="error-icon"><i class="fa-solid fa-circle-exclamation"></i></div>
            <p id="error-msg"></p>
            <button type="button" class="ovk-btn ovk-btn--quiet ovk-btn--small" id="retry-btn"><i class="fa-solid fa-arrow-rotate-left"></i> <span>Try again</span></button>
        </section>
    </form>`;
}

/** The answer: the file it made, its size, and Download. */
function answerFor() {
    return `<section class="ovk-answer" id="done-section" style="display:none" aria-live="polite">
        <div class="ovk-answer-head">
            <h2>Your file is ready</h2>
            <span class="ovk-answer-acts"><a class="ovk-btn ovk-btn--primary" id="save-btn" href="#" download>${kit.icon('download')}<span>Download</span></a></span>
        </div>
        <dl class="ovk-answer-rows"><div><dt>File</dt><dd id="done-info">Your file is ready</dd></div></dl>
        <div class="ovk-answer-body"><button type="button" class="ovk-btn ovk-btn--quiet ovk-btn--small" id="new-btn"><i class="fa-solid fa-arrow-rotate-left"></i> <span>Download another</span></button></div>
    </section>`;
}

/**
 * The whole frame for the downloader's page.
 * @param {string} [host] the host that serves it
 * @returns {string} HTML
 */
function frameFor(host) {
    const title = 'YouTube Downloader';
    const task = 'Save a YouTube video as MP4 or WebM, or keep just the audio as MP3.';
    const faq = [
        ['Is it free?', 'Yes. A download a minute without an account, and more when you sign in.'],
        ['How long is my file kept?', 'About an hour, so you can save it. Then it is deleted.'],
        ['How big can the video be?', `Up to ${frame.size(config.download.maxFilesize * 1024 * 1024)} and ${lengthOf(config.download.maxDuration)} long.`],
        ['Can I download any video?', 'Your own uploads, public-domain works and videos whose licence allows copies. You are responsible for having the right to save what you download.'],
    ];
    return `<div class="ovk-page ovk-page--wide" data-ov-tool-page="yt">${kit.tool({
        head: frame.head({
            icon: 'play', hue: 355, family: 'media',
            crumb: { href: SITE, label: 'Tools' },
            title, task, facts: termsOf(),
        }),
        input: boxFor(),
        answer: answerFor(),
        family: kit.family({
            title: 'More OpenVibe tools', more: { href: SITE, label: 'All tools' },
            items: familyItems(), label: 'More tools',
        }),
        folds: frame.folds({
            name: title,
            about: 'The downloader fetches one video with yt-dlp on our server and hands you the file as MP4, WebM, MP3, M4A, Opus or FLAC. The file is kept for about an hour and then deleted.',
            faq,
            api: null,
        }),
        related: kit.list(relatedItems(), { title: 'People also use' }),
    })}</div>`;
}

module.exports = { frameFor, termsOf, boxFor, answerFor, familyItems, relatedItems, HUBS, lengthOf };
