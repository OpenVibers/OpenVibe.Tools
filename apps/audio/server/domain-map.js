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
        seoTitle: 'Audio.OpenVibe — Free Online Audio Converter & Tools',
        seoDescription: 'Convert, trim, merge, pitch-shift, speed-change, and process audio files online for free. Supports MP3, WAV, FLAC, OGG, M4A, OPUS, AAC, WMA, AIFF, and more.',
    },

    // ── Format-specific converters ───────────────────────────
    'mp3.openvibe.tools': {
        toolId: 'mp3', brandName: 'OpenVibeMP3', defaultOp: 'convert', defaultFormat: 'mp3',
        faIcon: 'fa-file-audio',
        seoTitle: 'OpenVibeMP3 — Convert Audio to MP3 Online Free',
        seoDescription: 'Convert WAV, FLAC, OGG, M4A, AAC, WMA, AIFF and more to MP3 format online. Free, fast, no sign-up required.',
    },
    'wav.openvibe.tools': {
        toolId: 'wav', brandName: 'OpenVibeWAV', defaultOp: 'convert', defaultFormat: 'wav',
        faIcon: 'fa-file-audio',
        seoTitle: 'OpenVibeWAV — Convert Audio to WAV Online Free',
        seoDescription: 'Convert MP3, FLAC, OGG, M4A, AAC and more to lossless WAV format online. Free, fast, no sign-up required.',
    },
    'flac.openvibe.tools': {
        toolId: 'flac', brandName: 'OpenVibeFLAC', defaultOp: 'convert', defaultFormat: 'flac',
        faIcon: 'fa-file-audio',
        seoTitle: 'OpenVibeFLAC — Convert Audio to FLAC Online Free',
        seoDescription: 'Convert MP3, WAV, OGG, M4A, AAC and more to lossless FLAC format online. Free, fast, no sign-up required.',
    },
    'ogg.openvibe.tools': {
        toolId: 'ogg', brandName: 'OpenVibeOGG', defaultOp: 'convert', defaultFormat: 'ogg',
        faIcon: 'fa-file-audio',
        seoTitle: 'OpenVibeOGG — Convert Audio to OGG Vorbis Online Free',
        seoDescription: 'Convert MP3, WAV, FLAC, M4A, AAC and more to OGG Vorbis format online. Free, open-source codec.',
    },
    'm4a.openvibe.tools': {
        toolId: 'm4a', brandName: 'OpenVibeM4A', defaultOp: 'convert', defaultFormat: 'm4a',
        faIcon: 'fa-file-audio',
        seoTitle: 'OpenVibeM4A — Convert Audio to M4A (AAC) Online Free',
        seoDescription: 'Convert MP3, WAV, FLAC, OGG, WMA and more to M4A/AAC format online. Great quality at small file sizes.',
    },
    'opus.openvibe.tools': {
        toolId: 'opus', brandName: 'OpenVibeOpus', defaultOp: 'convert', defaultFormat: 'opus',
        faIcon: 'fa-file-audio',
        seoTitle: 'OpenVibeOpus — Convert Audio to Opus Online Free',
        seoDescription: 'Convert audio files to Opus format — the modern open-source codec. Best quality-to-size ratio for voice and music.',
    },
    'aac.openvibe.tools': {
        toolId: 'aac', brandName: 'OpenVibeAAC', defaultOp: 'convert', defaultFormat: 'aac',
        faIcon: 'fa-file-audio',
        seoTitle: 'OpenVibeAAC — Convert Audio to AAC Online Free',
        seoDescription: 'Convert MP3, WAV, FLAC, OGG and more to AAC format online. Free, fast, great for mobile devices.',
    },
    'wma.openvibe.tools': {
        toolId: 'wma', brandName: 'OpenVibeWMA', defaultOp: 'convert', defaultFormat: 'wma',
        faIcon: 'fa-file-audio',
        seoTitle: 'OpenVibeWMA — Convert Audio to WMA Online Free',
        seoDescription: 'Convert MP3, WAV, FLAC and more to Windows Media Audio format. Free online WMA converter.',
    },
    'aiff.openvibe.tools': {
        toolId: 'aiff', brandName: 'OpenVibeAIFF', defaultOp: 'convert', defaultFormat: 'aiff',
        faIcon: 'fa-file-audio',
        seoTitle: 'OpenVibeAIFF — Convert Audio to AIFF Online Free',
        seoDescription: 'Convert audio files to Apple AIFF format. Lossless quality for music production and archiving.',
    },
    'ac3.openvibe.tools': {
        toolId: 'ac3', brandName: 'OpenVibeAC3', defaultOp: 'convert', defaultFormat: 'ac3',
        faIcon: 'fa-file-audio',
        seoTitle: 'OpenVibeAC3 — Convert Audio to AC3 (Dolby Digital) Online Free',
        seoDescription: 'Convert audio files to AC3 Dolby Digital format. Perfect for surround sound and home theater.',
    },

    // ── Audio Processing Tools ───────────────────────────────
    'trim.openvibe.tools': {
        toolId: 'trim', brandName: 'OpenVibeTrim', defaultOp: 'trim',
        faIcon: 'fa-scissors',
        seoTitle: 'OpenVibeTrim — Trim & Cut Audio Online Free',
        seoDescription: 'Cut and trim audio files to any length. Set start and end times with precision. Free online audio trimmer.',
    },
    'merge.openvibe.tools': {
        toolId: 'merge', brandName: 'OpenVibeMerge', defaultOp: 'merge',
        faIcon: 'fa-object-group',
        seoTitle: 'OpenVibeMerge — Merge & Join Audio Files Online Free',
        seoDescription: 'Combine multiple audio files into one. Merge MP3, WAV, FLAC and more. Free online audio joiner.',
    },
    'pitch.openvibe.tools': {
        toolId: 'pitch', brandName: 'OpenVibePitch', defaultOp: 'pitch',
        faIcon: 'fa-wave-square',
        seoTitle: 'OpenVibePitch — Change Audio Pitch Online Free',
        seoDescription: 'Shift audio pitch up or down by semitones without changing speed. Free online pitch changer for music and voice.',
    },
    'speed.openvibe.tools': {
        toolId: 'speed', brandName: 'OpenVibeSpeed', defaultOp: 'speed',
        faIcon: 'fa-gauge-high',
        seoTitle: 'OpenVibeSpeed — Change Audio Speed Online Free',
        seoDescription: 'Speed up or slow down audio playback. Adjust tempo without affecting pitch. Free online speed changer.',
    },
    'reverse.openvibe.tools': {
        toolId: 'reverse', brandName: 'OpenVibeReverse', defaultOp: 'reverse',
        faIcon: 'fa-backward',
        seoTitle: 'OpenVibeReverse — Reverse Audio Online Free',
        seoDescription: 'Reverse any audio file instantly. Play it backwards — great for creative effects and fun. Free online tool.',
    },
    'normalize.openvibe.tools': {
        toolId: 'normalize', brandName: 'OpenVibeNormalize', defaultOp: 'normalize',
        faIcon: 'fa-sliders',
        seoTitle: 'OpenVibeNormalize — Normalize Audio Volume Online Free',
        seoDescription: 'Normalize audio loudness to a consistent level. Fix quiet or too-loud recordings. Free online audio normalizer.',
    },
    'fade.openvibe.tools': {
        toolId: 'fade', brandName: 'OpenVibeFade', defaultOp: 'fade',
        faIcon: 'fa-volume-low',
        seoTitle: 'OpenVibeFade — Add Fade In/Out to Audio Online Free',
        seoDescription: 'Add smooth fade-in and fade-out effects to audio files. Professional transitions, free online tool.',
    },
    'loop.openvibe.tools': {
        toolId: 'loop', brandName: 'OpenVibeLoop', defaultOp: 'loop',
        faIcon: 'fa-repeat',
        seoTitle: 'OpenVibeLoop — Loop Audio Online Free',
        seoDescription: 'Loop audio files a set number of times. Create repeated versions of any sound. Free online audio looper.',
    },
    'bass.openvibe.tools': {
        toolId: 'bass', brandName: 'OpenVibeBass', defaultOp: 'bass',
        faIcon: 'fa-volume-high',
        seoTitle: 'OpenVibeBass — Boost Bass Online Free',
        seoDescription: 'Boost or reduce bass frequencies in audio files. Enhance that low end. Free online bass booster.',
    },
    'equalizer.openvibe.tools': {
        toolId: 'equalizer', brandName: 'OpenVibeEQ', defaultOp: 'equalizer',
        faIcon: 'fa-bars-staggered',
        seoTitle: 'OpenVibeEQ — Online Audio Equalizer Free',
        seoDescription: 'Apply equalizer presets to audio files. Boost bass, treble, vocals and more. Free online EQ tool.',
    },
    'vocal.openvibe.tools': {
        toolId: 'vocal', brandName: 'OpenVibeVocal', defaultOp: 'vocal',
        faIcon: 'fa-microphone',
        seoTitle: 'OpenVibeVocal — Remove/Isolate Vocals Online Free',
        seoDescription: 'Remove or isolate vocals from audio tracks. Create karaoke versions or extract vocals. Free online tool.',
    },
    'karaoke.openvibe.tools': {
        toolId: 'vocal', brandName: 'OpenVibeKaraoke', defaultOp: 'vocal',
        faIcon: 'fa-microphone-lines', alias: 'vocal.openvibe.tools',
        seoTitle: 'OpenVibeKaraoke — Make Karaoke Tracks Online Free',
        seoDescription: 'Remove vocals from any song to create karaoke backing tracks. Free online karaoke maker.',
    },

    // ── Extraction / Analysis ────────────────────────────────
    'extract.openvibe.tools': {
        toolId: 'extract', brandName: 'OpenVibeExtract', defaultOp: 'extract',
        faIcon: 'fa-music',
        seoTitle: 'OpenVibeExtract — Extract Audio from Video Online Free',
        seoDescription: 'Extract and rip audio tracks from video files. MP4, MKV, AVI, WebM to MP3/WAV/FLAC. Free online extractor.',
    },
    'waveform.openvibe.tools': {
        toolId: 'waveform', brandName: 'OpenVibeWaveform', defaultOp: 'waveform',
        faIcon: 'fa-chart-line',
        seoTitle: 'OpenVibeWaveform — Generate Audio Waveform Images Online Free',
        seoDescription: 'Generate beautiful waveform visualizations from audio files. PNG or SVG output. Free online waveform generator.',
    },

    // ── Specialized / Fun ────────────────────────────────────
    'ringtone.openvibe.tools': {
        toolId: 'ringtone', brandName: 'OpenVibeRingtone', defaultOp: 'ringtone',
        faIcon: 'fa-bell',
        seoTitle: 'OpenVibeRingtone — Create Ringtones Online Free',
        seoDescription: 'Create custom ringtones from any audio file. Trim, fade, and export as M4R (iPhone) or MP3 (Android). Free tool.',
    },
    'podcast.openvibe.tools': {
        toolId: 'podcast', brandName: 'OpenVibePodcast', defaultOp: 'podcast',
        faIcon: 'fa-podcast',
        seoTitle: 'OpenVibePodcast — Optimize Audio for Podcasts Online Free',
        seoDescription: 'Optimize audio for podcast publishing. Normalize loudness, compress dynamics, convert to podcast-ready format.',
    },
    'voice.openvibe.tools': {
        toolId: 'voice', brandName: 'OpenVibeVoice', defaultOp: 'voice',
        faIcon: 'fa-user-astronaut',
        seoTitle: 'OpenVibeVoice — Voice Effects & Changer Online Free',
        seoDescription: 'Apply fun voice effects — chipmunk, deep, robot, echo, and more. Free online voice changer.',
    },
    'noise.openvibe.tools': {
        toolId: 'noise', brandName: 'OpenVibeNoise', defaultOp: 'noise',
        faIcon: 'fa-broom',
        seoTitle: 'OpenVibeNoise — Reduce Background Noise Online Free',
        seoDescription: 'Remove background noise from audio recordings. Clean up interviews, podcasts, and voice memos. Free tool.',
    },
    'bitcrusher.openvibe.tools': {
        toolId: 'bitcrusher', brandName: 'OpenVibeBitcrusher', defaultOp: 'bitcrusher',
        faIcon: 'fa-microchip',
        seoTitle: 'OpenVibeBitcrusher — Lo-Fi Bitcrusher Audio Effect Online Free',
        seoDescription: 'Apply lo-fi bitcrusher and sample rate reduction effects. Create retro 8-bit or crunchy audio textures. Free tool.',
    },
    'echo.openvibe.tools': {
        toolId: 'echo', brandName: 'OpenVibeEcho', defaultOp: 'echo',
        faIcon: 'fa-tower-broadcast',
        seoTitle: 'OpenVibeEcho — Add Echo & Delay to Audio Online Free',
        seoDescription: 'Add echo, delay, and repeat effects to audio files. Customizable timing and decay. Free online tool.',
    },
    'reverb.openvibe.tools': {
        toolId: 'reverb', brandName: 'OpenVibeReverb', defaultOp: 'reverb',
        faIcon: 'fa-church',
        seoTitle: 'OpenVibeReverb — Add Reverb to Audio Online Free',
        seoDescription: 'Add room reverb, hall, cathedral, and plate reverb effects to audio. Free online reverb tool.',
    },
    'chorus.openvibe.tools': {
        toolId: 'chorus', brandName: 'OpenVibeChorus', defaultOp: 'chorus',
        faIcon: 'fa-people-group',
        seoTitle: 'OpenVibeChorus — Add Chorus Effect to Audio Online Free',
        seoDescription: 'Apply lush chorus effect to audio tracks. Thicken vocals and instruments. Free online chorus tool.',
    },
    'distortion.openvibe.tools': {
        toolId: 'distortion', brandName: 'OpenVibeDistortion', defaultOp: 'distortion',
        faIcon: 'fa-bolt',
        seoTitle: 'OpenVibeDistortion — Add Distortion to Audio Online Free',
        seoDescription: 'Apply overdrive, fuzz, and distortion effects to audio. Great for guitars and creative sound design.',
    },
    'compressor.openvibe.tools': {
        toolId: 'compressor', brandName: 'OpenVibeCompressor', defaultOp: 'compressor',
        faIcon: 'fa-compress',
        seoTitle: 'OpenVibeCompressor — Compress Audio Dynamics Online Free',
        seoDescription: 'Apply dynamic range compression to audio. Even out volume levels for professional-sounding results. Free tool.',
    },
    'stereo.openvibe.tools': {
        toolId: 'stereo', brandName: 'OpenVibeStereo', defaultOp: 'stereo',
        faIcon: 'fa-arrows-left-right',
        seoTitle: 'OpenVibeStereo — Stereo/Mono Audio Converter Online Free',
        seoDescription: 'Convert audio between stereo and mono. Adjust stereo width and channel balance. Free online tool.',
    },
    'silence.openvibe.tools': {
        toolId: 'silence', brandName: 'OpenVibeSilence', defaultOp: 'silence',
        faIcon: 'fa-volume-xmark',
        seoTitle: 'OpenVibeSilence — Remove Silence from Audio Online Free',
        seoDescription: 'Automatically detect and remove silent sections from audio files. Perfect for editing recordings. Free tool.',
    },
    'metadata.openvibe.tools': {
        toolId: 'metadata', brandName: 'OpenVibeMeta', defaultOp: 'metadata',
        faIcon: 'fa-tags',
        seoTitle: 'OpenVibeMeta — Edit Audio Metadata & Tags Online Free',
        seoDescription: 'View and edit audio file metadata — title, artist, album, genre, year, artwork. ID3 tags for MP3. Free tool.',
    },

    // ── Aliases ──────────────────────────────────────────────
    'convert.audio.openvibe.tools': {
        toolId: 'hub', brandName: 'Audio.OpenVibe', defaultOp: 'convert',
        faIcon: 'fa-headphones', alias: 'audio.openvibe.tools',
        seoTitle: 'Audio.OpenVibe — Convert Audio Files Online Free',
        seoDescription: 'Convert between 20+ audio formats online. Free, fast audio converter.',
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
