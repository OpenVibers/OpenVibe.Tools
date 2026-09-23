'use strict';
// ═══════════════════════════════════════════════════════════════
// YT.OpenVibe — the YouTube downloader's descriptor, for the tool registry (tools.tool@1 spec, ADR-027).
//
// Page-only by decision (YouTube's terms and the legal exposure): api false and no run. It is listed so
// the registry is complete and says truthfully what the page does: a server download (egress to
// YouTube) of one video, as MP4/WebM video or MP3/M4A audio, within the length and size limits
// config.js enforces. While yt-dlp is missing on the host the satellite lists it as unavailable.
// ═══════════════════════════════════════════════════════════════

// config.js download.maxDuration (YT_MAX_DURATION) and download.timeout, read the same way.
const MAX_DURATION = parseInt(process.env.YT_MAX_DURATION, 10) || 3 * 60 * 60;
const TIMEOUT_MS = 10 * 60 * 1000;

const SPECS = [{
    id: 'yt', execution: 'job', api: false,
    input: null, files: null,
    // downloader.js mimeMap for the formats the page offers (mp4, webm, mp3, m4a).
    output: { kind: 'file', mime: ['video/mp4', 'video/webm', 'audio/mpeg', 'audio/mp4'] },
    limits: { timeoutMs: TIMEOUT_MS, maxDurationSec: MAX_DURATION, perTargetPerMinute: 10 },
    auth: { anonymous: true, capability: 'tools.tool.run' },
    quotaClass: 'tools-download', cost: 50, egress: true,
    requires: ['yt-dlp'],
}];

module.exports = { SPECS, MAX_DURATION, TIMEOUT_MS };
