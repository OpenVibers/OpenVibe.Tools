'use strict';
// ═══════════════════════════════════════════════════════════════
// Audio.OpenVibe — what each audio tool is, for the tool registry (tools.tool@1 specs, ADR-027;
// apps/_shared/tools/descriptor.js joins them with the catalogue's name, summary and hosts).
//
// Every audio tool is its host's operation (domain-map.js) run as an audio.process job. A format host
// (mp3., wav., …) forces its format on the page, so it is the job's preset here too. The option
// names and ranges are the ones each tools/<op>.js reads (and clamps to). Pure data: nothing here
// loads ffmpeg. apps/gateway/test/descriptors.test.js holds it to tools/index.js, process.js and config.js.
// ═══════════════════════════════════════════════════════════════

const { DOMAIN_MAP } = require('./domain-map');

// tools/convert.js FORMAT_CONFIG and tools/ffmpeg-helper.js FORMAT_MIME.
const FORMAT_MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', opus: 'audio/opus', wma: 'audio/x-ms-wma', aiff: 'audio/aiff', ac3: 'audio/ac3', webm: 'audio/webm' };
const FORMATS = Object.keys(FORMAT_MIME);
// What the bytes may be (checked against the bytes by the guard, apps/_shared/guard/sniff.js; the upload
// itself also lets application/octet-stream through, since browsers send it for audio they do not know).
// Every operation reads audio containers, including the video containers that carry audio (MP4, WebM,
// Matroska, QuickTime, Ogg); only the extractor also reads AVI and FLV (guard/ffmpeg.js formatsFor).
const AUDIO_ACCEPT = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/flac', 'audio/x-flac', 'audio/ogg', 'audio/vorbis', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/opus', 'audio/x-ms-wma', 'audio/aiff', 'audio/x-aiff', 'audio/ac3', 'audio/webm', 'audio/amr', 'video/mp4', 'video/webm', 'video/x-matroska', 'video/quicktime', 'video/ogg', 'application/ogg'];
const ACCEPT = [...AUDIO_ACCEPT, 'video/avi', 'video/x-msvideo', 'video/x-flv'];
const MAX_BYTES = 100 * 1024 * 1024;          // config.js upload.maxFileSize
const TIMEOUT_MS = 15 * 60 * 1000;            // process.js audio.process timeoutMs
const MERGE_MAX_SECONDS = 3 * 60 * 60;        // tools/merge.js MAX_TOTAL_SECONDS
// Longest input any operation reads (process.js probes it first; ffmpeg reads no more than this, -t).
const MAX_SECONDS = Math.max(1, parseInt(process.env.AUDIO_MAX_DURATION, 10) || 3 * 60 * 60);
// An effect keeps the input's own format unless `format` names one (ffmpeg-helper getMime: amr too, anything else octet-stream).
const ALL_OUT = [...new Set([...Object.values(FORMAT_MIME), 'audio/amr', 'application/octet-stream'])];

const RESULT = {
    type: 'object',
    description: 'result.data: what the operation made (the file itself is result.files[0])',
    required: ['tool', 'output'],
    properties: {
        tool: { type: 'string' },
        output: { type: 'object', properties: { mime: { type: 'string' }, ext: { type: 'string' }, size: { type: 'integer' }, sizeKB: { type: 'number' }, duration: { type: ['number', 'null'] } } },
        input: { type: 'object', properties: { size: { type: 'integer' }, sizeKB: { type: 'number' } } },
        metadata: { type: 'object', description: 'metadata: the tags written' },
        preset: { type: ['string', 'object'], description: 'the preset applied' },
        fileCount: { type: 'integer', description: 'merge: how many files were joined' },
    },
};

const fmt = { enum: FORMATS, description: 'Output format (default: the input\'s own)' };
const bitrate = { type: 'integer', minimum: 32, maximum: 320, description: 'kbps, lossy formats only' };
const time = { type: ['number', 'string'], pattern: '^\\d+(\\.\\d+)?$|^(\\d+:)?\\d{1,2}:\\d{2}(\\.\\d+)?$', minimum: 0, description: 'Seconds, or [HH:]MM:SS' };
const obj = (properties, required) => ({ type: 'object', additionalProperties: false, ...(required && { required }), properties });
const choice = (values, dflt, description) => ({ enum: values, default: dflt, ...(description && { description }) });

// The options each operation reads (tools/<op>.js), with the ranges it clamps to.
const INPUT = {
    convert: () => obj({ bitrate: { ...bitrate, default: 192 }, sampleRate: { type: 'integer', minimum: 8000, maximum: 192000, description: 'Hz (default: the input\'s)' }, channels: { enum: [1, 2], description: '1 = mono, 2 = stereo (default: the input\'s)' } }),
    extract: () => obj({ format: { enum: ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'opus', 'wma'], default: 'mp3' }, bitrate: { ...bitrate, default: 192 } }),
    trim: () => obj({ start: { ...time, default: 0 }, end: { ...time, description: 'Seconds or [HH:]MM:SS (default: the end)' }, format: fmt }),
    merge: () => obj({ format: { enum: FORMATS, default: 'mp3' }, bitrate: { ...bitrate, default: 192 } }),
    ringtone: () => obj({ start: { ...time, default: 0 }, end: { ...time, description: 'Default: 30 s after start' }, device: choice(['iphone', 'android'], 'iphone', 'iphone → M4R, android → MP3'), fadeIn: { type: 'number', minimum: 0, maximum: 30, default: 0 }, fadeOut: { type: 'number', minimum: 0, maximum: 30, default: 0.5 } }),
    speed: () => obj({ speed: { type: 'number', minimum: 0.25, maximum: 4, default: 1, description: 'Multiplier; the pitch is kept' }, format: fmt }),
    pitch: () => obj({ semitones: { type: 'number', minimum: -24, maximum: 24, default: 0 }, format: fmt }),
    reverse: () => obj({ format: fmt }),
    normalize: () => obj({ mode: choice(['peak', 'loudness', 'rms'], 'peak', 'peak, loudness (EBU R128) or rms'), target: { type: 'number', minimum: -70, maximum: 0, description: 'dB (default -1 peak, -16 loudness, -20 rms)' }, format: fmt }),
    noise: () => obj({ strength: choice(['light', 'medium', 'heavy'], 'medium'), format: fmt }),
    silence: () => obj({ threshold: { type: 'integer', minimum: -100, maximum: 0, default: -40, description: 'dB below which it counts as silence' }, minDuration: { type: 'number', minimum: 0.1, maximum: 60, default: 0.5, description: 'Shortest gap removed, seconds' }, format: fmt }),
    vocal: () => obj({ mode: choice(['remove', 'isolate'], 'remove', 'remove (karaoke) or isolate (vocals only)'), format: fmt }),
    fade: () => obj({ fadeIn: { type: 'number', minimum: 0, default: 0, description: 'Seconds' }, fadeOut: { type: 'number', minimum: 0, default: 0, description: 'Seconds' }, format: fmt }),
    loop: () => obj({ count: { type: 'integer', minimum: 2, maximum: 20, default: 2, description: 'How many times it plays in total' }, format: fmt }),
    bass: () => obj({ gain: { type: 'number', minimum: -20, maximum: 20, default: 6, description: 'dB' }, frequency: { type: 'integer', minimum: 20, maximum: 300, default: 100, description: 'Hz' }, format: fmt }),
    equalizer: () => obj({ preset: choice(['bass_boost', 'treble_boost', 'vocal_boost', 'flat', 'rock', 'pop', 'jazz', 'classical', 'electronic', 'hip_hop', 'podcast', 'telephone'], 'bass_boost'), format: fmt }),
    compressor: () => obj({ preset: choice(['light', 'medium', 'heavy', 'broadcast'], 'medium'), format: fmt }),
    podcast: () => obj({ format: { enum: FORMATS, default: 'mp3' }, bitrate: { ...bitrate, default: 128 }, mono: { type: 'boolean', default: true } }),
    voice: () => obj({ preset: choice(['chipmunk', 'deep', 'robot', 'echo', 'cave', 'radio', 'underwater', 'whisper', 'megaphone', 'demon'], 'chipmunk'), format: fmt }),
    echo: () => obj({ delay: { type: 'integer', minimum: 50, maximum: 2000, default: 250, description: 'ms' }, decay: { type: 'number', minimum: 0.1, maximum: 0.9, default: 0.5 }, repeats: { type: 'integer', minimum: 1, maximum: 10, default: 3 }, format: fmt }),
    reverb: () => obj({ preset: choice(['room', 'hall', 'cathedral', 'plate'], 'hall'), mix: { type: 'integer', minimum: 0, maximum: 100, default: 50, description: 'Wet/dry mix, %' }, format: fmt }),
    chorus: () => obj({ intensity: choice(['light', 'medium', 'heavy'], 'medium'), format: fmt }),
    distortion: () => obj({ gain: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Drive' }, format: fmt }),
    bitcrusher: () => obj({ bits: { type: 'integer', minimum: 2, maximum: 16, default: 8 }, sampleRate: { type: 'integer', minimum: 1000, maximum: 44100, default: 8000 }, format: fmt }),
    stereo: () => obj({ mode: choice(['mono', 'stereo', 'wide', 'narrow'], 'mono'), format: fmt }),
    waveform: () => obj({ width: { type: 'integer', minimum: 200, maximum: 4000, default: 1200 }, height: { type: 'integer', minimum: 60, maximum: 800, default: 200 }, color: { type: 'string', pattern: '^#?[0-9a-fA-F]{3,8}$', default: '#c0965c' }, bgColor: { type: 'string', pattern: '^#?[0-9a-fA-F]{3,8}(@[0-9.]+)?$', default: '#1a1a22' } }),
    metadata: () => obj(Object.fromEntries(['title', 'artist', 'album', 'genre', 'year', 'track', 'comment'].map(k => [k, { type: 'string', maxLength: 500 }]).concat([['format', fmt]]))),
};

/** One audio tool: its host's operation as an audio.process job. */
function tool(id, extra = {}) {
    const ctx = DOMAIN_MAP[`${id}.openvibe.tools`];
    if (!ctx || !ctx.defaultOp) throw new Error(`audio: ${id}.openvibe.tools has no operation in domain-map.js`);
    const op = ctx.defaultOp;
    const fixed = op === 'convert' && ctx.defaultFormat;
    const mime = fixed ? [FORMAT_MIME[ctx.defaultFormat]] : op === 'waveform' ? ['image/png'] : op === 'ringtone' ? ['audio/x-m4r', 'audio/mpeg'] : op === 'convert' || op === 'extract' || op === 'merge' || op === 'podcast' ? [...new Set(Object.values(FORMAT_MIME))] : ALL_OUT;
    return {
        id, execution: 'job', api: true,
        job: { type: 'audio.process', operation: op, ...(fixed && { preset: { format: ctx.defaultFormat } }) },
        legacy: [op === 'merge' ? 'POST /api/process/multi' : 'POST /api/process'],
        input: INPUT[op](),
        files: { min: op === 'merge' ? 2 : 1, max: op === 'merge' ? 5 : 1, accept: op === 'extract' ? ACCEPT : AUDIO_ACCEPT, maxBytes: MAX_BYTES },
        output: { kind: 'file', mime, schema: RESULT },
        limits: { timeoutMs: TIMEOUT_MS, maxDurationSec: op === 'merge' ? Math.min(MERGE_MAX_SECONDS, MAX_SECONDS) : MAX_SECONDS },
        // ffmpeg over an upload is heavy work: a browser session (the page has one), a person or a token.
        auth: { anonymous: false, capability: 'tools.tool.run' },
        quotaClass: 'tools-job', cost: op === 'merge' ? 20 : op === 'metadata' || op === 'waveform' ? 5 : 10, egress: false,
        requires: ['ffmpeg'],
        example: { input: {} },
        ...extra,
    };
}

const IDS = ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'opus', 'aac', 'wma', 'aiff', 'ac3', 'extract', 'trim', 'merge', 'ringtone', 'speed', 'pitch', 'reverse', 'normalize', 'noise', 'silence', 'vocal', 'fade', 'loop', 'bass', 'equalizer', 'compressor', 'podcast', 'voice', 'echo', 'reverb', 'chorus', 'distortion', 'bitcrusher', 'stereo', 'waveform', 'metadata'];
const SPECS = IDS.map(id => tool(id));

module.exports = { SPECS, FORMAT_MIME, ACCEPT, AUDIO_ACCEPT, MAX_BYTES, TIMEOUT_MS, MAX_SECONDS };
