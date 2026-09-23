'use strict';
// ═══════════════════════════════════════════════════════════════
// Job results as OpenVibe.Media objects (Media object API v2, roadmap Wave 4).
//
//   POST {media}/api/v2/tools/objects             init → { id: med_…, upload: { url, token } }
//   PUT  {upload.url}                              the bytes (upload token in the URL)
//   POST {media}/api/v2/tools/objects/:id/complete verify sha256 → lifecycle ready
//   GET  {media}/api/v2/tools/objects/:id/download?format=json → short-lived signed URL
//   DELETE {media}/api/v2/tools/objects/:id        when the job is pruned
//
// Auth: a Network client-credentials token (audience openvibe.media) granting
// media.object.upload and media.object.read for namespace "tools". The owner goes in
// X-OV-Subject when the job belongs to a signed-in person (user:usr_…); guest and session
// results are service-owned objects in the tools namespace. Objects are private.
//
// Calls go to the internal Media URL; Media's upload URL (built on its public origin) is
// rewritten onto it, so bytes never leave the host.
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const { Readable } = require('stream');

/**
 * @param {object} o
 * @param {string} o.internalUrl   e.g. http://127.0.0.1:4100
 * @param {string} [o.namespace='tools']
 * @param {object} o.tokens        contracts.serviceAuth.createTokenClient(...) (audience openvibe.media)
 * @param {function} [o.fetchImpl]
 * @param {number} [o.timeoutMs=120000]
 */
function createMediaResults(o) {
    const base = String(o.internalUrl || '').replace(/\/+$/, '');
    if (!base) throw new TypeError('createMediaResults needs internalUrl');
    const ns = encodeURIComponent(o.namespace || 'tools');
    const fetchImpl = o.fetchImpl || globalThis.fetch;
    const timeoutMs = o.timeoutMs || 120_000;
    const api = `${base}/api/v2/${ns}/objects`;

    async function call(url, init = {}, retried = false) {
        const headers = { Accept: 'application/json', ...(init.headers || {}), ...(await o.tokens.authHeaders()) };
        const res = await fetchImpl(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
        if (res.status === 401 && !retried && (init.body == null || typeof init.body === 'string')) { o.tokens.invalidate(); return call(url, init, true); }
        return res;
    }
    async function json(res, what) {
        const body = await res.json().catch(() => null);
        if (!res.ok) {
            const err = new Error(`Media ${what} ${res.status}: ${(body && (body.detail || body.error || body.code)) || 'no body'}`);
            err.status = res.status;
            err.code = body && body.code;
            throw err;
        }
        return body;
    }
    /** Media's upload URL is on its public origin; send the bytes to the internal one. */
    function internal(url) {
        const u = new URL(url);
        const b = new URL(base);
        u.protocol = b.protocol; u.host = b.host;
        return u.toString();
    }
    const subjectHeader = (owner) => {
        const m = /^user:(usr_[0-9A-HJKMNP-TV-Z]{26})$/.exec(String(owner || ''));
        return m ? { 'X-OV-Subject': m[1] } : {};
    };

    /** Store one file → MediaRef { media_id, role, namespace, size_bytes, content_hash, mime_type }. */
    async function upload({ path: file, name, mime, size, sha256, owner, jobId, service, type }) {
        const init = await json(await call(api, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...subjectHeader(owner) },
            body: JSON.stringify({
                kind: 'file', visibility: 'private', size_bytes: size, mime_type: mime, filename: name, content_hash: sha256,
                metadata: { source: 'openvibe.tools', service, job_id: jobId, job_type: type },
            }),
        }), 'init');
        const id = init && init.id;
        if (!id || !init.upload || !init.upload.url) throw new Error('Media init answered without an upload URL');
        try {
            const put = await fetchImpl(internal(init.upload.url), {
                method: 'PUT',
                headers: { 'Content-Type': mime || 'application/octet-stream', 'Content-Length': String(size) },
                body: Readable.toWeb(fs.createReadStream(file)),
                duplex: 'half',
                signal: AbortSignal.timeout(timeoutMs),
            });
            await json(put, 'content');
            const done = await json(await call(`${api}/${encodeURIComponent(id)}/complete`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content_hash: sha256 }),
            }), 'complete');
            return { media_id: id, role: 'output', namespace: o.namespace || 'tools', size_bytes: size, content_hash: sha256, mime_type: mime, status: done.lifecycle_status || 'ready' };
        } catch (err) {
            await remove(id).catch(() => {});
            throw err;
        }
    }

    /** A short-lived signed URL for the private object → { url, expires_at }. */
    async function downloadUrl(mediaId, ttlSec = 300) {
        const body = await json(await call(`${api}/${encodeURIComponent(mediaId)}/download?format=json&ttl=${ttlSec}`), 'download');
        if (!body || !body.url) throw new Error('Media download answered without a URL');
        return { url: body.url, expires_at: body.expires_at || null, internal_url: internal(body.url) };
    }

    async function remove(mediaId) {
        const res = await call(`${api}/${encodeURIComponent(mediaId)}`, { method: 'DELETE' });
        if (res.status === 404) return false;
        await json(res, 'delete');
        return true;
    }

    return { upload, downloadUrl, remove, namespace: o.namespace || 'tools' };
}

module.exports = { createMediaResults };
