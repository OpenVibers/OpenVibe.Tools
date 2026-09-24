'use strict';
// ═══════════════════════════════════════════════════════════════
// Where the Tools apps listen on this host, for the loopback calls between them (the gateway's
// readiness checks, registry polling, run API and jobs facade; a satellite reading another's job
// result for a run's { job_id, index } reference).
//
// TOOLS_SATELLITE_PORTS="img=5012,yt=5013" overrides single entries (tests, a moved unit).
// Job types are routed by their prefix: img.process → img, audio.process → audio, docs.process → docs.
// ═══════════════════════════════════════════════════════════════

const DEFAULT_PORTS = Object.freeze({ maps: 4010, food: 4011, img: 4012, yt: 4013, audio: 4014, text: 4015, docs: 4016 });
const JOB_SATELLITES = Object.freeze(['img', 'audio', 'docs']);

/** { maps: 4010, …, docs: 4016 } with the environment's overrides. */
function satellitePorts(env = process.env) {
    const out = { ...DEFAULT_PORTS };
    for (const pair of String(env.TOOLS_SATELLITE_PORTS || '').split(',')) {
        const [name, port] = pair.split('=').map(x => String(x || '').trim());
        if (out[name] && /^\d{2,5}$/.test(port)) out[name] = Number(port);
    }
    return out;
}

/** The satellite that runs a job type ('img.process' → 'img'), or null. */
function satelliteForType(type) {
    const prefix = String(type || '').split('.')[0];
    return JOB_SATELLITES.includes(prefix) ? prefix : null;
}

module.exports = { DEFAULT_PORTS, JOB_SATELLITES, satellitePorts, satelliteForType };
