'use strict';

// ═══════════════════════════════════════════════════════════════
// Audio.OpenVibe — Domain → Context Mapping
// One Express server handles all audio subdomain hostnames.
// Each hostname maps to a brand name, default tool, and SEO data.
// ═══════════════════════════════════════════════════════════════

const DOMAIN_MAP = {
    // ── Hub ──────────────────────────────────────────────────
    'audio.openvibe.tools': {
        toolId: 'hub', brandName: 'Audio.OpenVibe', defaultOp: 'convert',
        faIcon: 'fa-headphones',
        seoTitle: 'Audio.OpenVibe — Online Audio Converter & Tools',
        seoDescription: 'Convert, trim, merge, pitch-shift, speed-change, and process audio files online. Supports MP3, WAV, FLAC, OGG, M4A, OPUS, AAC, WMA, AIFF, and more.',
    },

    // ── Format-specific converters ───────────────────────────
    'mp3.openvibe.tools': {
        toolId: 'mp3', brandName: 'OpenVibeMP3', defaultOp: 'convert', defaultFormat: 'mp3',
        faIcon: 'fa-file-audio',
        seoTitle: 'OpenVibeMP3 — Convert Audio to MP3 Online',
        seoDescription: 'Convert WAV, FLAC, OGG, M4A, AAC, WMA, AIFF and more to MP3 format online. Fast, no sign-up required.',
    },
    'wav.openvibe.tools': {
        toolId: 'wav', brandName: 'OpenVibeWAV', defaultOp: 'convert', defaultFormat: 'wav',
        faIcon: 'fa-file-audio',
        seoTitle: 'OpenVibeWAV — Convert Audio to WAV Online',
        seoDescription: 'Convert MP3, FLAC, OGG, M4A, AAC and more to lossless WAV format online. Fast, no sign-up required.',
    },
    'flac.openvibe.tools': {
        toolId: 'flac', brandName: 'OpenVibeFLAC', defaultOp: 'convert', defaultFormat: 'flac',
        faIcon: 'fa-file-audio',
        seoTitle: 'OpenVibeFLAC — Convert Audio to FLAC Online',
        seoDescription: 'Convert MP3, WAV, OGG, M4A, AAC and more to lossless FLAC format online. Fast, no sign-up required.',
    },
    'ogg.openvibe.tools': {
        toolId: 'ogg', brandName: 'OpenVibeOGG', defaultOp: 'convert', defaultFormat: 'ogg',
        faIcon: 'fa-file-audio',
        seoTitle: 'OpenVibeOGG — Convert Audio to OGG Vorbis Online',
        seoDescription: 'Convert MP3, WAV, FLAC, M4A, AAC and more to OGG Vorbis format online. Open-source codec.',
    },
    'm4a.openvibe.tools': {
        toolId: 'm4a', brandName: 'OpenVibeM4A', defaultOp: 'convert', defaultFormat: 'm4a',
        faIcon: 'fa-file-audio',
        seoTitle: 'OpenVibeM4A — Convert Audio to M4A (AAC) Online',
        seoDescription: 'Convert MP3, WAV, FLAC, OGG, WMA and more to M4A/AAC format online. Great quality at small file sizes.',
    },
    'opus.openvibe.tools': {
        toolId: 'opus', brandName: 'OpenVibeOpus', defaultOp: 'convert', defaultFormat: 'opus',
        faIcon: 'fa-file-audio',
        seoTitle: 'OpenVibeOpus — Convert Audio to Opus Online',
        seoDescription: 'Convert audio files to Opus format — the modern open-source codec. Best quality-to-size ratio for voice and music.',
    },
    'aac.openvibe.tools': {
        toolId: 'aac', brandName: 'OpenVibeAAC', defaultOp: 'convert', defaultFormat: 'aac',
        faIcon: 'fa-file-audio',
        seoTitle: 'OpenVibeAAC — Convert Audio to AAC Online',
        seoDescription: 'Convert MP3, WAV, FLAC, OGG and more to AAC format online. Fast, great for mobile devices.',
    },
    'wma.openvibe.tools': {
        toolId: 'wma', brandName: 'OpenVibeWMA', defaultOp: 'convert', defaultFormat: 'wma',
        faIcon: 'fa-file-audio',
        seoTitle: 'OpenVibeWMA — Convert Audio to WMA Online',
        seoDescription: 'Convert MP3, WAV, FLAC and more to Windows Media Audio format. Online WMA converter.',
    },
    'aiff.openvibe.tools': {
        toolId: 'aiff', brandName: 'OpenVibeAIFF', defaultOp: 'convert', defaultFormat: 'aiff',
        faIcon: 'fa-file-audio',
        seoTitle: 'OpenVibeAIFF — Convert Audio to AIFF Online',
        seoDescription: 'Convert audio files to Apple AIFF format. Lossless quality for music production and archiving.',
    },
    'ac3.openvibe.tools': {
        toolId: 'ac3', brandName: 'OpenVibeAC3', defaultOp: 'convert', defaultFormat: 'ac3',
        faIcon: 'fa-file-audio',
        seoTitle: 'OpenVibeAC3 — Convert Audio to AC3 (Dolby Digital) Online',
        seoDescription: 'Convert audio files to AC3 Dolby Digital format. Perfect for surround sound and home theater.',
    },

    // ── Audio Processing Tools ───────────────────────────────
    'trim.openvibe.tools': {
        toolId: 'trim', brandName: 'OpenVibeTrim', defaultOp: 'trim',
        faIcon: 'fa-scissors',
        seoTitle: 'OpenVibeTrim — Trim & Cut Audio Online',
        seoDescription: 'Cut and trim audio files to any length. Set start and end times with precision. Online audio trimmer.',
    },
    'merge.openvibe.tools': {
        toolId: 'merge', brandName: 'OpenVibeMerge', defaultOp: 'merge',
        faIcon: 'fa-object-group',
        seoTitle: 'OpenVibeMerge — Merge & Join Audio Files Online',
        seoDescription: 'Combine multiple audio files into one. Merge MP3, WAV, FLAC and more. Online audio joiner.',
    },
    'pitch.openvibe.tools': {
        toolId: 'pitch', brandName: 'OpenVibePitch', defaultOp: 'pitch',
        faIcon: 'fa-wave-square',
        seoTitle: 'OpenVibePitch — Change Audio Pitch Online',
        seoDescription: 'Shift audio pitch up or down by semitones without changing speed. Online pitch changer for music and voice.',
    },
    'speed.openvibe.tools': {
        toolId: 'speed', brandName: 'OpenVibeSpeed', defaultOp: 'speed',
        faIcon: 'fa-gauge-high',
        seoTitle: 'OpenVibeSpeed — Change Audio Speed Online',
        seoDescription: 'Speed up or slow down audio playback. Adjust tempo without affecting pitch. Online speed changer.',
    },
    'reverse.openvibe.tools': {
        toolId: 'reverse', brandName: 'OpenVibeReverse', defaultOp: 'reverse',
        faIcon: 'fa-backward',
        seoTitle: 'OpenVibeReverse — Reverse Audio Online',
        seoDescription: 'Reverse any audio file instantly. Play it backwards — great for creative effects and fun. Online tool.',
    },
    'normalize.openvibe.tools': {
        toolId: 'normalize', brandName: 'OpenVibeNormalize', defaultOp: 'normalize',
        faIcon: 'fa-sliders',
        seoTitle: 'OpenVibeNormalize — Normalize Audio Volume Online',
        seoDescription: 'Normalize audio loudness to a consistent level. Fix quiet or too-loud recordings. Online audio normalizer.',
    },
    'fade.openvibe.tools': {
        toolId: 'fade', brandName: 'OpenVibeFade', defaultOp: 'fade',
        faIcon: 'fa-volume-low',
        seoTitle: 'OpenVibeFade — Add Fade In/Out to Audio Online',
        seoDescription: 'Add smooth fade-in and fade-out effects to audio files. Professional transitions, online tool.',
    },
    'loop.openvibe.tools': {
        toolId: 'loop', brandName: 'OpenVibeLoop', defaultOp: 'loop',
        faIcon: 'fa-repeat',
        seoTitle: 'OpenVibeLoop — Loop Audio Online',
        seoDescription: 'Loop audio files a set number of times. Create repeated versions of any sound. Online audio looper.',
    },
    'bass.openvibe.tools': {
        toolId: 'bass', brandName: 'OpenVibeBass', defaultOp: 'bass',
        faIcon: 'fa-volume-high',
        seoTitle: 'OpenVibeBass — Boost Bass Online',
        seoDescription: 'Boost or reduce bass frequencies in audio files. Enhance that low end. Online bass booster.',
    },
    'equalizer.openvibe.tools': {
        toolId: 'equalizer', brandName: 'OpenVibeEQ', defaultOp: 'equalizer',
        faIcon: 'fa-bars-staggered',
        seoTitle: 'OpenVibeEQ — Online Audio Equalizer',
        seoDescription: 'Apply equalizer presets to audio files. Boost bass, treble, vocals and more. Online EQ tool.',
    },
    'vocal.openvibe.tools': {
        toolId: 'vocal', brandName: 'OpenVibeVocal', defaultOp: 'vocal',
        faIcon: 'fa-microphone',
        seoTitle: 'OpenVibeVocal — Remove/Isolate Vocals Online',
        seoDescription: 'Remove or isolate vocals from audio tracks. Create karaoke versions or extract vocals. Online tool.',
    },
    'karaoke.openvibe.tools': {
        toolId: 'vocal', brandName: 'OpenVibeKaraoke', defaultOp: 'vocal',
        faIcon: 'fa-microphone-lines', alias: 'vocal.openvibe.tools',
        seoTitle: 'OpenVibeKaraoke — Make Karaoke Tracks Online',
        seoDescription: 'Remove vocals from any song to create karaoke backing tracks. Online karaoke maker.',
    },

    // ── Extraction / Analysis ────────────────────────────────
    'extract.openvibe.tools': {
        toolId: 'extract', brandName: 'OpenVibeExtract', defaultOp: 'extract',
        faIcon: 'fa-music',
        seoTitle: 'OpenVibeExtract — Extract Audio from Video Online',
        seoDescription: 'Extract and rip audio tracks from video files. MP4, MKV, AVI, WebM to MP3/WAV/FLAC. Online extractor.',
    },
    'waveform.openvibe.tools': {
        toolId: 'waveform', brandName: 'OpenVibeWaveform', defaultOp: 'waveform',
        faIcon: 'fa-chart-line',
        seoTitle: 'OpenVibeWaveform — Generate Audio Waveform Images Online',
        seoDescription: 'Generate beautiful waveform visualizations from audio files. PNG or SVG output. Online waveform generator.',
    },

    // ── Specialized / Fun ────────────────────────────────────
    'ringtone.openvibe.tools': {
        toolId: 'ringtone', brandName: 'OpenVibeRingtone', defaultOp: 'ringtone',
        faIcon: 'fa-bell',
        seoTitle: 'OpenVibeRingtone — Create Ringtones Online',
        seoDescription: 'Create custom ringtones from any audio file. Trim, fade, and export as M4R (iPhone) or MP3 (Android). Online tool.',
    },
    'podcast.openvibe.tools': {
        toolId: 'podcast', brandName: 'OpenVibePodcast', defaultOp: 'podcast',
        faIcon: 'fa-podcast',
        seoTitle: 'OpenVibePodcast — Optimize Audio for Podcasts Online',
        seoDescription: 'Optimize audio for podcast publishing. Normalize loudness, compress dynamics, convert to podcast-ready format.',
    },
    'voice.openvibe.tools': {
        toolId: 'voice', brandName: 'OpenVibeVoice', defaultOp: 'voice',
        faIcon: 'fa-user-astronaut',
        seoTitle: 'OpenVibeVoice — Voice Effects & Changer Online',
        seoDescription: 'Apply fun voice effects — chipmunk, deep, robot, echo, and more. Online voice changer.',
    },
    'noise.openvibe.tools': {
        toolId: 'noise', brandName: 'OpenVibeNoise', defaultOp: 'noise',
        faIcon: 'fa-broom',
        seoTitle: 'OpenVibeNoise — Reduce Background Noise Online',
        seoDescription: 'Remove background noise from audio recordings. Clean up interviews, podcasts, and voice memos. Online tool.',
    },
    'bitcrusher.openvibe.tools': {
        toolId: 'bitcrusher', brandName: 'OpenVibeBitcrusher', defaultOp: 'bitcrusher',
        faIcon: 'fa-microchip',
        seoTitle: 'OpenVibeBitcrusher — Lo-Fi Bitcrusher Audio Effect Online',
        seoDescription: 'Apply lo-fi bitcrusher and sample rate reduction effects. Create retro 8-bit or crunchy audio textures. Online tool.',
    },
    'echo.openvibe.tools': {
        toolId: 'echo', brandName: 'OpenVibeEcho', defaultOp: 'echo',
        faIcon: 'fa-tower-broadcast',
        seoTitle: 'OpenVibeEcho — Add Echo & Delay to Audio Online',
        seoDescription: 'Add echo, delay, and repeat effects to audio files. Customizable timing and decay. Online tool.',
    },
    'reverb.openvibe.tools': {
        toolId: 'reverb', brandName: 'OpenVibeReverb', defaultOp: 'reverb',
        faIcon: 'fa-church',
        seoTitle: 'OpenVibeReverb — Add Reverb to Audio Online',
        seoDescription: 'Add room reverb, hall, cathedral, and plate reverb effects to audio. Online reverb tool.',
    },
    'chorus.openvibe.tools': {
        toolId: 'chorus', brandName: 'OpenVibeChorus', defaultOp: 'chorus',
        faIcon: 'fa-people-group',
        seoTitle: 'OpenVibeChorus — Add Chorus Effect to Audio Online',
        seoDescription: 'Apply lush chorus effect to audio tracks. Thicken vocals and instruments. Online chorus tool.',
    },
    'distortion.openvibe.tools': {
        toolId: 'distortion', brandName: 'OpenVibeDistortion', defaultOp: 'distortion',
        faIcon: 'fa-bolt',
        seoTitle: 'OpenVibeDistortion — Add Distortion to Audio Online',
        seoDescription: 'Apply overdrive, fuzz, and distortion effects to audio. Great for guitars and creative sound design.',
    },
    'compressor.openvibe.tools': {
        toolId: 'compressor', brandName: 'OpenVibeCompressor', defaultOp: 'compressor',
        faIcon: 'fa-compress',
        seoTitle: 'OpenVibeCompressor — Compress Audio Dynamics Online',
        seoDescription: 'Apply dynamic range compression to audio. Even out volume levels for professional-sounding results. Online tool.',
    },
    'stereo.openvibe.tools': {
        toolId: 'stereo', brandName: 'OpenVibeStereo', defaultOp: 'stereo',
        faIcon: 'fa-arrows-left-right',
        seoTitle: 'OpenVibeStereo — Stereo/Mono Audio Converter Online',
        seoDescription: 'Convert audio between stereo and mono. Adjust stereo width and channel balance. Online tool.',
    },
    'silence.openvibe.tools': {
        toolId: 'silence', brandName: 'OpenVibeSilence', defaultOp: 'silence',
        faIcon: 'fa-volume-xmark',
        seoTitle: 'OpenVibeSilence — Remove Silence from Audio Online',
        seoDescription: 'Automatically detect and remove silent sections from audio files. Perfect for editing recordings. Online tool.',
    },
    'metadata.openvibe.tools': {
        toolId: 'metadata', brandName: 'OpenVibeMeta', defaultOp: 'metadata',
        faIcon: 'fa-tags',
        seoTitle: 'OpenVibeMeta — Edit Audio Metadata & Tags Online',
        seoDescription: 'View and edit audio file metadata — title, artist, album, genre, year, artwork. ID3 tags for MP3. Online tool.',
    },

    // ── Aliases ──────────────────────────────────────────────
    'convert.audio.openvibe.tools': {
        toolId: 'hub', brandName: 'Audio.OpenVibe', defaultOp: 'convert',
        faIcon: 'fa-headphones', alias: 'audio.openvibe.tools',
        seoTitle: 'Audio.OpenVibe — Convert Audio Files Online',
        seoDescription: 'Convert between 20+ audio formats online. Fast audio converter.',
    },
};

const DEFAULT_CONTEXT = DOMAIN_MAP['audio.openvibe.tools'];

/**
 * Resolve hostname to subdomain context.
 * @param {string} hostname - e.g. 'mp3.openvibe.tools' (may include port)
 * @returns {Object} Domain context
 */
function resolveContext(hostname) {
    const host = String(hostname || '').split(':')[0].toLowerCase();
    return DOMAIN_MAP[host] || DEFAULT_CONTEXT;
}

/**
 * Get all registered hostnames (for nginx config / docs).
 */
function getAllHosts() {
    return Object.keys(DOMAIN_MAP);
}

module.exports = { resolveContext, getAllHosts, DOMAIN_MAP };
