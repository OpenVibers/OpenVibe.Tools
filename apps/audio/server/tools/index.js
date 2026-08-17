'use strict';

// ═══════════════════════════════════════════════════════════════
// Audio.OpenVibe — Tool Registry
// Central registry of all audio processing tools.
// Each tool exports: { label, description, accepts, handler }
// ═══════════════════════════════════════════════════════════════

const convert      = require('./convert');
const trim         = require('./trim');
const pitch        = require('./pitch');
const speed        = require('./speed');
const reverse      = require('./reverse');
const normalize    = require('./normalize');
const fade         = require('./fade');
const loop         = require('./loop');
const bass         = require('./bass');
const equalizer    = require('./equalizer');
const extract      = require('./extract');
const waveform     = require('./waveform');
const ringtone     = require('./ringtone');
const podcast      = require('./podcast');
const voice        = require('./voice');
const noise        = require('./noise');
const bitcrusher   = require('./bitcrusher');
const echo         = require('./echo');
const reverb       = require('./reverb');
const chorus       = require('./chorus');
const distortion   = require('./distortion');
const compressor   = require('./compressor');
const stereo       = require('./stereo');
const silence      = require('./silence');
const vocal        = require('./vocal');
const { readMetadata, writeMetadata } = require('./metadata');

const AUDIO_FORMATS = ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'opus', 'wma', 'aiff', 'ac3', 'webm', 'amr'];
const VIDEO_FORMATS = ['mp4', 'webm', 'mkv', 'avi', 'mov', 'flv', 'ogv'];

const TOOLS = {
    convert: {
        id: 'convert',
        label: 'Convert',
        description: 'Convert audio between formats',
        faIcon: 'fa-arrows-rotate',
        accepts: AUDIO_FORMATS,
        category: 'conversion',
        handler: convert,
    },
    trim: {
        id: 'trim',
        label: 'Trim',
        description: 'Cut audio to a specific time range',
        faIcon: 'fa-scissors',
        accepts: AUDIO_FORMATS,
        category: 'editing',
        handler: trim,
    },
    pitch: {
        id: 'pitch',
        label: 'Pitch',
        description: 'Shift audio pitch up or down',
        faIcon: 'fa-wave-square',
        accepts: AUDIO_FORMATS,
        category: 'effects',
        handler: pitch,
    },
    speed: {
        id: 'speed',
        label: 'Speed',
        description: 'Change audio playback speed',
        faIcon: 'fa-gauge-high',
        accepts: AUDIO_FORMATS,
        category: 'effects',
        handler: speed,
    },
    reverse: {
        id: 'reverse',
        label: 'Reverse',
        description: 'Reverse audio playback',
        faIcon: 'fa-backward',
        accepts: AUDIO_FORMATS,
        category: 'effects',
        handler: reverse,
    },
    normalize: {
        id: 'normalize',
        label: 'Normalize',
        description: 'Normalize audio volume',
        faIcon: 'fa-sliders',
        accepts: AUDIO_FORMATS,
        category: 'editing',
        handler: normalize,
    },
    fade: {
        id: 'fade',
        label: 'Fade',
        description: 'Add fade-in and fade-out',
        faIcon: 'fa-volume-low',
        accepts: AUDIO_FORMATS,
        category: 'editing',
        handler: fade,
    },
    loop: {
        id: 'loop',
        label: 'Loop',
        description: 'Loop audio multiple times',
        faIcon: 'fa-repeat',
        accepts: AUDIO_FORMATS,
        category: 'editing',
        handler: loop,
    },
    bass: {
        id: 'bass',
        label: 'Bass Boost',
        description: 'Boost or reduce bass frequencies',
        faIcon: 'fa-volume-high',
        accepts: AUDIO_FORMATS,
        category: 'effects',
        handler: bass,
    },
    equalizer: {
        id: 'equalizer',
        label: 'Equalizer',
        description: 'Apply EQ presets',
        faIcon: 'fa-bars-staggered',
        accepts: AUDIO_FORMATS,
        category: 'effects',
        handler: equalizer,
    },
    vocal: {
        id: 'vocal',
        label: 'Vocal Remove',
        description: 'Remove or isolate vocals',
        faIcon: 'fa-microphone',
        accepts: AUDIO_FORMATS,
        category: 'effects',
        handler: vocal,
    },
    extract: {
        id: 'extract',
        label: 'Extract',
        description: 'Extract audio from video',
        faIcon: 'fa-music',
        accepts: [...AUDIO_FORMATS, ...VIDEO_FORMATS],
        category: 'conversion',
        handler: extract,
    },
    waveform: {
        id: 'waveform',
        label: 'Waveform',
        description: 'Generate waveform visualization',
        faIcon: 'fa-chart-line',
        accepts: AUDIO_FORMATS,
        category: 'analysis',
        handler: waveform,
    },
    ringtone: {
        id: 'ringtone',
        label: 'Ringtone',
        description: 'Create ringtones (M4R/MP3)',
        faIcon: 'fa-bell',
        accepts: AUDIO_FORMATS,
        category: 'specialized',
        handler: ringtone,
    },
    podcast: {
        id: 'podcast',
        label: 'Podcast',
        description: 'Optimize for podcast publishing',
        faIcon: 'fa-podcast',
        accepts: AUDIO_FORMATS,
        category: 'specialized',
        handler: podcast,
    },
    voice: {
        id: 'voice',
        label: 'Voice FX',
        description: 'Apply voice effects',
        faIcon: 'fa-user-astronaut',
        accepts: AUDIO_FORMATS,
        category: 'effects',
        handler: voice,
    },
    noise: {
        id: 'noise',
        label: 'Noise Reduce',
        description: 'Reduce background noise',
        faIcon: 'fa-broom',
        accepts: AUDIO_FORMATS,
        category: 'editing',
        handler: noise,
    },
    bitcrusher: {
        id: 'bitcrusher',
        label: 'Bitcrusher',
        description: 'Lo-fi bitcrusher effect',
        faIcon: 'fa-microchip',
        accepts: AUDIO_FORMATS,
        category: 'effects',
        handler: bitcrusher,
    },
    echo: {
        id: 'echo',
        label: 'Echo',
        description: 'Add echo & delay',
        faIcon: 'fa-tower-broadcast',
        accepts: AUDIO_FORMATS,
        category: 'effects',
        handler: echo,
    },
    reverb: {
        id: 'reverb',
        label: 'Reverb',
        description: 'Add reverb effect',
        faIcon: 'fa-church',
        accepts: AUDIO_FORMATS,
        category: 'effects',
        handler: reverb,
    },
    chorus: {
        id: 'chorus',
        label: 'Chorus',
        description: 'Add chorus effect',
        faIcon: 'fa-people-group',
        accepts: AUDIO_FORMATS,
        category: 'effects',
        handler: chorus,
    },
    distortion: {
        id: 'distortion',
        label: 'Distortion',
        description: 'Add distortion/overdrive',
        faIcon: 'fa-bolt',
        accepts: AUDIO_FORMATS,
        category: 'effects',
        handler: distortion,
    },
    compressor: {
        id: 'compressor',
        label: 'Compressor',
        description: 'Dynamic range compression',
        faIcon: 'fa-compress',
        accepts: AUDIO_FORMATS,
        category: 'editing',
        handler: compressor,
    },
    stereo: {
        id: 'stereo',
        label: 'Stereo',
        description: 'Stereo/mono conversion',
        faIcon: 'fa-arrows-left-right',
        accepts: AUDIO_FORMATS,
        category: 'editing',
        handler: stereo,
    },
    silence: {
        id: 'silence',
        label: 'Remove Silence',
        description: 'Remove silent sections',
        faIcon: 'fa-volume-xmark',
        accepts: AUDIO_FORMATS,
        category: 'editing',
        handler: silence,
    },
    metadata: {
        id: 'metadata',
        label: 'Metadata',
        description: 'View & edit audio tags',
        faIcon: 'fa-tags',
        accepts: AUDIO_FORMATS,
        category: 'analysis',
        handler: writeMetadata,
        read: readMetadata,
    },
};

function getTool(id) {
    return TOOLS[id] || null;
}

function listTools() {
    return Object.values(TOOLS).map(t => ({
        id: t.id, label: t.label, description: t.description,
        faIcon: t.faIcon, accepts: t.accepts, category: t.category,
    }));
}

module.exports = { TOOLS, getTool, listTools, AUDIO_FORMATS, VIDEO_FORMATS };
