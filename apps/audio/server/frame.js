'use strict';

// ═══════════════════════════════════════════════════════════════
// The tool frame for the audio pages (openvibe-shared ≥ 4.57.1, owner ask 11, part 2).
//
// Every audio host — mp3, trim, merge, reverb and the rest — is a tool page in the shared frame: the
// head (the family crumb, the tool's name, one sentence, the terms), the box (a drop zone and the
// tool's own options), the answer (the file it made, its size before and after, and Download), the
// family, the folds and "People also use".
//
// The box's options are the tool's own descriptor (server/descriptors.js): a field the descriptor does
// not have is not on the page, and its range and its default are the ones the tool reads. The terms
// come from the app's real configuration: the file's lifetime from config.js's retention, its size
// from config.js's upload limits, and the anonymous rate from the guard's quota table.
// ═══════════════════════════════════════════════════════════════

const kit = require('openvibe-shared/kit');
const serve = require('openvibe-shared/serve');
const frame = require('../../_shared/frame')({ kit, serve });
const config = require('./config');
const { DOMAIN_MAP } = require('./domain-map');
const { SPECS, FORMAT_MIME, AUDIO_ACCEPT } = require('./descriptors');
const { TOOLS } = require('./tools');

const HUB = 'https://audio.openvibe.tools/';
const esc = kit.esc;

// The tools, in the order the family row shows them: the formats first, then the edits and the effects.
const TOOL_LIST = [
    ['mp3', 'MP3 Converter', 'MP3', 'Convert any audio file to MP3, the format every player reads.', 'Convert to MP3'],
    ['wav', 'WAV Converter', 'WAV', 'Convert audio to WAV, the uncompressed format every program reads.', 'Convert to WAV'],
    ['flac', 'FLAC Converter', 'FLAC', 'Convert audio to FLAC, the lossless format.', 'Convert to FLAC'],
    ['ogg', 'OGG Converter', 'OGG', 'Convert audio to OGG Vorbis, the open format.', 'Convert to OGG'],
    ['m4a', 'M4A Converter', 'M4A', 'Convert audio to M4A, the format phones and podcasts use.', 'Convert to M4A'],
    ['opus', 'Opus Converter', 'Opus', 'Convert audio to Opus, the smallest format for speech.', 'Convert to Opus'],
    ['aac', 'AAC Converter', 'AAC', 'Convert audio to AAC, the format inside an MP4.', 'Convert to AAC'],
    ['wma', 'WMA Converter', 'WMA', 'Convert audio to WMA, the format Windows plays.', 'Convert to WMA'],
    ['aiff', 'AIFF Converter', 'AIFF', 'Convert audio to AIFF, the format audio programs write.', 'Convert to AIFF'],
    ['ac3', 'AC3 Converter', 'AC3', 'Convert audio to AC3, the surround-sound format.', 'Convert to AC3'],
    ['extract', 'Extract Audio', 'Extract', 'Take the sound out of a video file.', 'Extract audio'],
    ['trim', 'Trim Audio', 'Trim', 'Cut a recording down to the part you want to keep.', 'Trim'],
    ['merge', 'Merge Audio', 'Merge', 'Join up to five recordings into one file.', 'Merge'],
    ['ringtone', 'Ringtone Maker', 'Ringtone', 'Cut a ringtone for a phone.', 'Make ringtone'],
    ['speed', 'Change Speed', 'Speed', 'Make a recording play faster or slower, with the pitch kept.', 'Change speed'],
    ['pitch', 'Change Pitch', 'Pitch', 'Make a recording sound higher or lower without changing its speed.', 'Change pitch'],
    ['reverse', 'Reverse Audio', 'Reverse', 'Play a recording backwards.', 'Reverse'],
    ['normalize', 'Normalize Volume', 'Normalize', 'Make a recording as loud as it should be.', 'Normalize'],
    ['noise', 'Reduce Noise', 'Noise', 'Take the hiss and the hum out of a recording.', 'Reduce noise'],
    ['silence', 'Remove Silence', 'Silence', 'Cut the quiet parts out of a recording.', 'Remove silence'],
    ['vocal', 'Remove Vocals', 'Vocals', 'Take the singing out of a recording, or keep only the singing.', 'Remove vocals'],
    ['fade', 'Add Fade', 'Fade', 'Fade a recording in at the start and out at the end.', 'Add fade'],
    ['loop', 'Loop Audio', 'Loop', 'Play a recording more than once.', 'Loop'],
    ['bass', 'Boost Bass', 'Bass', 'Make the low end of a recording louder.', 'Boost bass'],
    ['equalizer', 'Equalizer', 'Equalizer', 'Change the balance of the frequencies in a recording.', 'Equalize'],
    ['compressor', 'Compressor', 'Compressor', 'Even out the quiet parts and the loud parts of a recording.', 'Compress'],
    ['podcast', 'Podcast', 'Podcast', 'Make a recording ready to publish as a podcast.', 'Optimize for podcast'],
    ['voice', 'Voice Changer', 'Voice', 'Change a voice into chipmunk, robot, giant and more.', 'Change voice'],
    ['echo', 'Add Echo', 'Echo', 'Add an echo to a recording.', 'Add echo'],
    ['reverb', 'Add Reverb', 'Reverb', 'Put a recording in a room, a hall or a cathedral.', 'Add reverb'],
    ['chorus', 'Add Chorus', 'Chorus', 'Double a recording\'s voice with a chorus.', 'Add chorus'],
    ['distortion', 'Add Distortion', 'Distortion', 'Make a recording sound driven and rough.', 'Add distortion'],
    ['bitcrusher', 'Bitcrusher', 'Lo-Fi', 'Make a recording sound old and lo-fi.', 'Add lo-fi'],
    ['stereo', 'Stereo', 'Stereo', 'Turn a recording into stereo or into mono.', 'Change channels'],
    ['waveform', 'Waveform Image', 'Waveform', 'Draw the shape of a recording as a picture.', 'Draw waveform'],
    ['metadata', 'Edit Metadata', 'Metadata', 'Read and write the tags inside an audio file.', 'Save metadata'],
];

const RECS = TOOL_LIST.map(([id, name, short, task, verb]) => ({ id, name, short, task, verb, op: id }));
const BY_ID = new Map(RECS.map((r) => [r.id, r]));
const SPEC = new Map(SPECS.map((s) => [s.id, s]));

const HUB_TOOL = {
    id: 'hub', name: 'Audio.OpenVibe', short: 'All tools', task: 'Convert audio to any format, and change it with the tools below.', verb: 'Convert',
    op: 'convert',
    about: 'Every audio tool in one place: convert a recording to another format, cut it, join it, and put an effect on it.',
};

/** The tool a host is for (the karaoke host is the vocal tool under another name). */
function toolFor(host) {
    const ctx = DOMAIN_MAP[host];
    if (!ctx) return null;
    if (ctx.toolId === 'hub') return HUB_TOOL;
    return BY_ID.get(ctx.toolId) || null;
}

/** The verb of a host: the karaoke host says what it makes. */
function verbFor(rec, host) {
    if (host === 'karaoke.openvibe.tools') return 'Make karaoke';
    if (rec.id === 'hub') return 'Convert';
    return rec.verb;
}

/** The terms of a tool, from the app's real configuration and the tool's own descriptor. */
function termsOf(rec) {
    const spec = SPEC.get(rec.id === 'hub' ? 'convert' : rec.id);
    return frame.terms({
        work: 'server',
        ttlMs: config.retention.anonTTL,
        maxBytes: config.upload.maxFileSize,
        maxFiles: (spec && spec.files && spec.files.max) || 1,
        quotaClass: (spec && spec.quotaClass) || 'tools-job',
        cost: (spec && spec.cost) || 1,
        unit: 'runs',
        needsAccount: !!(spec && spec.auth && spec.auth.anonymous === false),
    });
}

/** The labels of the descriptor's fields, in the words a person reads. */
const FIELD_LABEL = {
    format: 'Output format', bitrate: 'Bitrate (kbps)', sampleRate: 'Sample rate (Hz)', channels: 'Channels',
    start: 'Start', end: 'End', speed: 'Speed', semitones: 'Semitones', mode: 'Mode', target: 'Target (dB)',
    strength: 'Strength', threshold: 'Silence below (dB)', minDuration: 'Shortest gap (s)', device: 'Phone',
    fadeIn: 'Fade in (s)', fadeOut: 'Fade out (s)', count: 'Times', gain: 'Gain (dB)', frequency: 'Frequency (Hz)',
    preset: 'Preset', mix: 'Wet mix (%)', delay: 'Delay (ms)', decay: 'Decay', repeats: 'Repeats', bits: 'Bits',
    width: 'Width (px)', height: 'Height (px)', color: 'Colour', bgColor: 'Background',
    title: 'Title', artist: 'Artist', album: 'Album', genre: 'Genre', year: 'Year', track: 'Track', comment: 'Comment',
};

/** The values a person reads better than the code's: the channels are mono and stereo. */
const VALUE_LABEL = { 1: 'Mono', 2: 'Stereo' };

/** The box's options: the tool's own descriptor fields, with their ranges and their defaults. */
function optionsFor(rec) {
    const spec = SPEC.get(rec.id === 'hub' ? 'convert' : rec.id);
    const props = (spec && spec.input && spec.input.properties) || {};
    const fixed = rec.op === 'convert' && (DOMAIN_MAP[`${rec.id}.openvibe.tools`] || {}).defaultFormat;
    const out = [];
    for (const [name, s] of Object.entries(props)) {
        // A format host fixes its own format; the page does not offer another one.
        if (name === 'format' && fixed) continue;
        out.push(frame.field(name, s, FIELD_LABEL, VALUE_LABEL));
    }
    return out.join('');
}

/**
 * The box: a drop zone for the recording, the tool's options and the one button.
 * @param {object} rec the tool record
 */
function boxFor(rec, host) {
    const spec = SPEC.get(rec.id === 'hub' ? 'convert' : rec.id);
    const many = (spec && spec.files && spec.files.max) > 1;
    const accept = (spec && spec.files && spec.files.accept) || AUDIO_ACCEPT;
    const drop = kit.drop({
        name: 'file', accept: accept.join(','), id: 'file-input', multiple: many,
        label: many ? 'Drop your recordings here' : 'Drop a recording here',
        hint: many ? 'Up to five files at once' : 'MP3, WAV, FLAC, OGG, M4A, AAC, Opus, WMA, AIFF, MP4, WebM',
    });
    return `<form class="ovk-tool-form" id="ovk-audio-form" enctype="multipart/form-data" data-ovk-tool-form>`
        + drop
        + `<p class="ovk-try"><span>Try</span><a href="/sample.mp3" data-ovk-sample="/sample.mp3">A sample recording</a></p>`
        + `<div id="options-panel" hidden>${optionsFor(rec)}</div>`
        + `<div class="ovk-tool-buttons">${frame.verbButton(verbFor(rec, host), { id: 'process-btn', icon: 'wave' })}`
        + `<button type="button" class="ovk-btn ovk-btn--quiet ovk-btn--small" id="clear-btn">${kit.icon('close')}<span>Clear</span></button></div>`
        + `</form>`;
}

/** The family: every audio tool, with the one on the page marked. */
function familyItems(rec) {
    // The hub is the first of the family: the whole audio suite, and the page the family marks there.
    const hub = { href: HUB, label: 'Audio.OpenVibe', short: 'All tools', current: rec.id === 'hub' };
    return [hub, ...RECS.map((t) => ({ href: `https://${t.id}.openvibe.tools/`, label: t.name, short: t.short, current: t.id === rec.id }))];
}

/** "People also use": the tools next to this one in the family. */
function relatedFor(rec) {
    const at = RECS.findIndex((t) => t.id === rec.id);
    const out = [];
    for (let i = 1; out.length < 3 && i < RECS.length + 1; i++) {
        const other = RECS[(at + i) % RECS.length];
        if (other.id !== rec.id) out.push(other);
    }
    return out.map((t) => kit.row({ href: `https://${t.id}.openvibe.tools/`, title: t.name, sub: t.task }));
}

/**
 * The whole frame for one host.
 * @param {string} host the satellite's own hostname, e.g. 'mp3.openvibe.tools'
 * @returns {string} HTML
 */
function frameFor(host) {
    const rec = toolFor(host);
    if (!rec) return '';
    const spec = SPEC.get(rec.id === 'hub' ? 'convert' : rec.id);
    const fields = spec && spec.input && spec.input.properties ? Object.keys(spec.input.properties).join(', ') : 'none';
    const apiId = rec.id === 'hub' ? 'convert' : rec.id;
    const input = spec && spec.input && spec.input.properties ? Object.fromEntries(
        Object.entries(spec.input.properties).map(([k, v]) => [k, v.default !== undefined ? v.default : '']),
    ) : {};
    const about = rec.about || `The ${rec.name.toLowerCase()} tool works on our server: the recording is sent to us, changed there and sent back as a file.`;
    const faq = [
        ['Is it free?', 'Yes. Every audio tool here is free, with a fair-use limit per address so the shared servers stay fast for everyone.'],
        ['How long is my recording kept?', 'An hour for a visitor, a day for a signed-in person. Then the file is gone.'],
        ['What does it accept?', 'MP3, WAV, FLAC, OGG, M4A, AAC, Opus, WMA, AIFF and the video formats that carry audio.'],
    ];
    return frame.page({
        id: rec.id,
        icon: 'wave', hue: 265, family: 'audio',
        crumb: { href: HUB, label: 'Audio tools' },
        title: rec.name, task: rec.task, facts: termsOf(rec),
        box: boxFor(rec, host),
        familyTitle: 'More audio tools',
        familyMore: { href: HUB, label: `All ${RECS.length + 1}` },
        familyItems: familyItems(rec),
        about, faq,
        api: {
            id: apiId, path: `/api/v1/tools/${apiId}/run`, fields, payload: { input },
            needsAccount: !!(spec && spec.auth && spec.auth.anonymous === false),
        },
        related: relatedFor(rec),
    });
}

module.exports = { frameFor, toolFor, termsOf, boxFor, verbFor, optionsFor, RECS, HUB_TOOL };
