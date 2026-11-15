'use strict';
// ═══════════════════════════════════════════════════════════════
// GET /made-sandbox: where a code tool people made runs in a visitor's browser (plan 2026-11-13 §AD.12 (c)). The page
// that tries a tool frames this with sandbox="allow-scripts" (an opaque origin: no cookies, no storage, no way to the
// page), posts { t, source, input }, and gets { t, ok, out | error } back. The code runs in a Worker started here, so
// even an endless loop never freezes the tab; the framing page stops it after its time limit by removing the frame.
//
// Its own policy, not the site's: nothing may be fetched or framed, scripts are the inline one below and the Worker's
// blob, and only openvibe.tools may frame it.
// ═══════════════════════════════════════════════════════════════

const POLICY = "default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

const PAGE = `<!doctype html><meta charset="utf-8"><title>OpenVibe Tools sandbox</title><script>
(function () {
    var worker = null;
    var WRAP = '\\n;self.onmessage = async function (m) { try { if (typeof run !== "function") throw new Error("The code has no run(input) function"); var out = await run(m.data); self.postMessage({ ok: true, out: JSON.parse(JSON.stringify(out === undefined ? null : out)) }); } catch (err) { self.postMessage({ ok: false, error: String((err && err.message) || err) }); } };';
    window.addEventListener('message', function (e) {
        var d = e.data || {};
        if (e.source !== parent || typeof d.t !== 'string' || typeof d.source !== 'string') return;
        if (worker) worker.terminate();
        try { worker = new Worker(URL.createObjectURL(new Blob([d.source + WRAP], { type: 'text/javascript' }))); }
        catch (err) { parent.postMessage({ t: d.t, ok: false, error: 'The sandbox could not start: ' + ((err && err.message) || err) }, '*'); return; }
        worker.onmessage = function (m) { var r = m.data || {}; parent.postMessage({ t: d.t, ok: !!r.ok, out: r.out, error: r.error }, '*'); };
        worker.onerror = function (ev) { ev.preventDefault(); parent.postMessage({ t: d.t, ok: false, error: ev.message || 'The code failed' }, '*'); };
        worker.postMessage(d.input);
    });
    parent.postMessage({ sandbox: 'ready' }, '*');
})();
</script>`;

function sandboxPage(req, res) {
    res.set({ 'Content-Security-Policy': POLICY, 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' });
    res.removeHeader('X-Frame-Options');
    res.type('html').send(PAGE);
}

module.exports = { sandboxPage, POLICY, PAGE };
