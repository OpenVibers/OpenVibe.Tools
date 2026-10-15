'use strict';
// ═══════════════════════════════════════════════════════════════
// Traceroute and MTR from this server, without raw sockets.
//
// Both run mtr (0.95+) in report mode with JSON output. Its mtr-packet helper sends ICMP echo through
// Linux's unprivileged ICMP sockets (net.ipv4.ping_group_range), so it needs no capability and runs
// under the unit's NoNewPrivileges. ICMP echo reaches hosts that ignore traceroute's classic UDP
// probes (9.9.9.9 answers at hop 11; tracepath waited out all 30 hops), probes every hop at once, and
// stops after 5 silent hops in a row (-U 5).
//
// The target is always the address the SSRF guard checked (never a name: no rebinding), passed in
// argv to execFile (no shell). At most RUNNING_MAX runs at once across everyone; a caller over that
// gets `busy` and tries again. The hops are the provider's own path; private hop addresses are shown
// as mtr reports them (they are answers, never dialled).
// ═══════════════════════════════════════════════════════════════

const { execFile } = require('child_process');
const net = require('net');

const MTR_BIN = process.env.NET_MTR_BIN || '/usr/bin/mtr';
const MAX_HOPS = 30;
const MAX_UNKNOWN = 5;
const RUNNING_MAX = 2;
const MODES = {
    // A quick path: three probes a hop.
    trace: { cycles: 3, timeoutMs: 30000 },
    // Loss and jitter per hop: ten probes a hop (about 11 s; non-root mtr cannot go under a second between rounds).
    mtr: { cycles: 10, timeoutMs: 45000 },
};

/** Run the mtr binary: resolves { stdout } or rejects with a coded error. */
function execMtr(args, timeoutMs) {
    return new Promise((resolve, reject) => {
        execFile(MTR_BIN, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL', env: { PATH: '/usr/bin:/bin', LANG: 'C' } }, (err, stdout, stderr) => {
            if (err) {
                const e = new Error(err.killed ? 'The trace took too long and was stopped' : (String(stderr || err.message).trim().split('\n')[0] || 'mtr failed'));
                e.code = err.killed ? 'trace_timeout' : err.code === 'ENOENT' ? 'trace_unavailable' : 'trace_failed';
                return reject(e);
            }
            resolve({ stdout: String(stdout) });
        });
    });
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

/** mtr's JSON report → hops in order: { hop, ip, asn, loss, sent, last, avg, best, worst, stdev } (ip null = no reply). */
function parseReport(stdout) {
    let doc;
    try { doc = JSON.parse(stdout); } catch { const e = new Error('mtr gave an answer that is not JSON'); e.code = 'trace_failed'; throw e; }
    const hubs = (doc && doc.report && Array.isArray(doc.report.hubs)) ? doc.report.hubs : [];
    return hubs.map((h) => {
        const ip = typeof h.host === 'string' && net.isIP(h.host) ? h.host : null;
        const asn = typeof h.ASN === 'string' && /^AS\d+$/.test(h.ASN) ? h.ASN : null;
        return {
            hop: Number(h.count) || 0, ip, asn,
            loss: num(h['Loss%']), sent: Number(h.Snt) || 0,
            last: ip ? num(h.Last) : null, avg: ip ? num(h.Avg) : null, best: ip ? num(h.Best) : null,
            worst: ip ? num(h.Wrst) : null, stdev: ip ? num(h.StDev) : null,
        };
    }).filter((h) => h.hop > 0);
}

/**
 * createTracer({ exec, reverse }) → { run(mode, dest) }. `exec(args, timeoutMs)` and `reverse(ip)` are
 * for tests; `dest` is egress.resolve()'s answer ({ address, family }).
 */
function createTracer({ exec = execMtr, reverse = null, max = RUNNING_MAX } = {}) {
    let running = 0;
    const names = new Map();   // ip → PTR name (or '' for none), a small bounded cache

    async function nameOf(ip) {
        if (!reverse || !ip) return null;
        if (names.has(ip)) return names.get(ip) || null;
        let name = '';
        try {
            const got = await Promise.race([reverse(ip), new Promise((r) => setTimeout(() => r([]), 1500).unref())]);
            name = Array.isArray(got) && typeof got[0] === 'string' ? got[0].slice(0, 253) : '';
        } catch { name = ''; }
        if (names.size > 2000) names.delete(names.keys().next().value);
        names.set(ip, name);
        return name || null;
    }

    async function run(mode, dest) {
        const m = MODES[mode];
        if (!m) throw new Error(`trace: unknown mode ${mode}`);
        if (!dest || !net.isIP(dest.address)) { const e = new Error('No address to trace'); e.code = 'trace_failed'; throw e; }
        if (running >= max) { const e = new Error('Other traces are running from this server right now; try again in a few seconds'); e.code = 'busy'; throw e; }
        running++;
        try {
            const family = net.isIP(dest.address) === 6 ? '-6' : '-4';
            const { stdout } = await exec([family, '-n', '-z', '-j', '-c', String(m.cycles), '-m', String(MAX_HOPS), '-U', String(MAX_UNKNOWN), '--', dest.address], m.timeoutMs);
            const hops = parseReport(stdout);
            await Promise.all(hops.map(async (h) => { h.host = await nameOf(h.ip); }));
            const last = hops.length ? hops[hops.length - 1] : null;
            return { hops, reached: !!(last && last.ip === dest.address), probes: m.cycles };
        } finally { running--; }
    }

    return { run, get running() { return running; } };
}

module.exports = { createTracer, parseReport, MODES, MAX_HOPS };
