'use strict';
// ═══════════════════════════════════════════════════════════════
// ffmpeg hardening (hard limits: they apply in report mode too).
//
// An upload is a file on disk, but ffmpeg decides by the bytes what to do with it: an HLS playlist or an
// ffconcat list makes it open other files (anything the service user can read) or URLs. So every
// input of every command and every probe gets
//   -protocol_whitelist file,pipe          nothing but local files and pipes
//   -format_whitelist <the operation's demuxers>   no hls, concat, image2, lavfi, sdp, tty, …
//   -t <limits.maxDurationSec>             never more than the descriptor's longest input is read
// and probeInputs() refuses an input longer than maxDurationSec before any work starts (the -t is the
// backstop for a file whose header lies). A synchronous run gets a deadline (limits.timeoutMs) and is
// killed like a cancelled job when it passes (the audio app runs sync calls in its job context).
//
// No dependencies: the app passes fluent-ffmpeg.
// ═══════════════════════════════════════════════════════════════

// Demuxer names (ffmpeg -formats): audio containers, and the video containers only the extractor takes.
const AUDIO_DEMUXERS = ['mp3', 'wav', 'flac', 'ogg', 'mov', 'aac', 'asf', 'aiff', 'ac3', 'eac3', 'matroska', 'amr'];
const VIDEO_DEMUXERS = ['avi', 'flv'];
const PROTOCOLS = 'file,pipe';

/** The demuxers an operation may open (extract takes video files too). */
function formatsFor(operation) {
    return operation === 'extract' ? [...AUDIO_DEMUXERS, ...VIDEO_DEMUXERS] : AUDIO_DEMUXERS;
}

/** Input options for one input. */
function inputArgs({ formats = AUDIO_DEMUXERS, maxDurationSec = null } = {}) {
    return [
        '-protocol_whitelist', PROTOCOLS,
        '-format_whitelist', formats.join(','),
        ...(maxDurationSec > 0 ? ['-t', String(maxDurationSec)] : []),
    ];
}

/** Options for ffprobe (no -t: a probe reads headers). */
function probeArgs({ formats = AUDIO_DEMUXERS } = {}) {
    return ['-protocol_whitelist', PROTOCOLS, '-format_whitelist', formats.join(',')];
}

/** Put the hardening options on every input of a fluent-ffmpeg command (once). */
function applyToCommand(cmd, opts) {
    for (const input of cmd._inputs || []) {
        if (input.__ovHardened) continue;
        input.options(...inputArgs(opts));
        input.__ovHardened = true;
    }
}

class InputRefused extends Error {
    constructor(message, reason) { super(message); this.status = reason === 'duration' ? 413 : 415; this.code = reason === 'duration' ? 'tools.file.too_large' : 'tools.file.unsupported_type'; this.guardReason = `ffmpeg.${reason}`; this.expose = true; }
}

/**
 * Wrap fluent-ffmpeg once: every command's inputs and every ffprobe get the options above.
 * @param {Function} ffmpeg                 require('fluent-ffmpeg')
 * @param {() => object} optionsNow         { formats, maxDurationSec } for the command being started
 *                                          (the app reads its AsyncLocalStorage context)
 */
function harden(ffmpeg, optionsNow) {
    const proto = ffmpeg.prototype;
    if (proto.__ovHardened) return;
    const run = proto.run;
    proto.run = function hardenedRun(...args) {
        applyToCommand(this, optionsNow() || {});
        return run.apply(this, args);
    };
    const probe = proto.ffprobe;
    proto.ffprobe = function hardenedProbe(...args) {
        // ffprobe([index], [options], callback): the options go first; ours are added to them.
        const cb = args[args.length - 1];
        let index = null, options = [];
        if (args.length === 3) { index = args[0]; options = args[1] || []; } else if (args.length === 2) { if (typeof args[0] === 'number') index = args[0]; else if (Array.isArray(args[0])) options = args[0]; }
        const all = [...probeArgs(optionsNow() || {}), ...options];
        return index === null ? probe.call(this, all, cb) : probe.call(this, index, all, cb);
    };
    proto.__ovHardened = true;
}

/**
 * Probe every input (hardened) before work starts: each must open with the allowed demuxers, and
 * together they must fit maxDurationSec. → the total duration in seconds (0 when unknown).
 * @param {Function} probe   (path) → Promise<ffprobe data>  (the app's helper; hardened by harden())
 */
async function probeInputs(probe, paths, { maxDurationSec = null } = {}) {
    let total = 0;
    for (let i = 0; i < paths.length; i++) {
        let info;
        try { info = await probe(paths[i]); } catch {
            throw new InputRefused(paths.length > 1 ? `File ${i + 1} is not an audio or video file this tool can read.` : 'This is not an audio or video file this tool can read.', 'format');
        }
        const d = parseFloat(info && info.format && info.format.duration);
        if (Number.isFinite(d) && d > 0) total += d;
    }
    if (maxDurationSec > 0 && total > maxDurationSec) {
        const len = (s) => (s >= 120 ? `${Math.round(s / 60)} minutes` : `${Math.round(s)} seconds`);
        throw new InputRefused(`The audio is ${len(total)} long; this tool takes at most ${len(maxDurationSec)}.`, 'duration');
    }
    return total;
}

module.exports = { AUDIO_DEMUXERS, VIDEO_DEMUXERS, PROTOCOLS, formatsFor, inputArgs, probeArgs, applyToCommand, harden, probeInputs, InputRefused };
