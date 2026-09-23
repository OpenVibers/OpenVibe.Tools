# OpenVibe.Tools

The tools suite of the OpenVibe network — `openvibe.tools` plus dozens of
tool subdomains under `*.openvibe.tools`.

Identity is provided by **OpenVibe.Network** (`https://openvibe.network`).
This repo contains no identity provider: the gateway is an OAuth2 **client**
(`client_id: tools`) that sets the shared `ov_token` cookie on
`.openvibe.tools`; every satellite reads that cookie and verifies the JWT
offline against the Network's public key (JWKS).

## Layout

```
apps/
├── gateway   # apex (server-rendered index, family + tool pages, catalog.json), the tool registry
│             # and host roles, Net.OpenVibe + Dev.OpenVibe tools, proxy to the satellites
├── maps      # Maps.OpenVibe  — survival map for North America
├── food      # Food.OpenVibe  — grocery / food bank finder (proxies maps backend)
├── img       # Img.OpenVibe   — image converter & processing tools
├── yt        # YT.OpenVibe    — YouTube downloader
├── audio     # Audio.OpenVibe — audio converter & effects
├── text      # Text.OpenVibe + Logo.OpenVibe — text generators & logo makers
└── docs      # Docs.OpenVibe  — PDF & document tools
apps/_shared   # code the apps require by relative path: host roles, internal auth, the job runtime (jobs/)
(openvibe-shared is a pinned OpenVibe.Shared release in each app's package.json; no vendor/ copy)
```

## Ports

| App | Domain | Port |
|---|---|---|
| gateway | openvibe.tools + net./dev./pastes. + tool aliases | **4001** |
| maps | maps.openvibe.tools | **4010** |
| food | food.openvibe.tools | **4011** |
| img | img.openvibe.tools + format aliases | **4012** |
| yt | yt.openvibe.tools | **4013** |
| audio | audio.openvibe.tools + effect aliases | **4014** |
| text | text.openvibe.tools + logo.openvibe.tools + aliases | **4015** |
| docs | docs.openvibe.tools + pdf.openvibe.tools | **4016** |

Related services: Network **4000** (SSO/JWKS/themes/shared assets),
Media **4100**, Live **3000**, Community **4200** (pastes live on openvibe.community;
`pastes.openvibe.tools` hands over to it).

## Registry, hosts and domains

`apps/gateway/server/registry` is the one list of tools and families. Each has a **canonical** host
(links, sitemaps, `rel=canonical`), an optional **short** host people type, and **aliases** that 301
to the short host. Unknown `*.openvibe.tools` hosts 301 to the index; unknown custom domains 404.
The owner can attach hosts (including bought domains) to a tool in `openvibe.network/admin` →
Domains; the gateway merges those overrides every minute. New custom domain on the host:
`sudo deploy/scripts/add-custom-domain.sh <domain>`.

Public, cacheable outputs on the apex: `/` (every tool by family, planned tools as placeholders),
`/<family>-tools`, `/tool/<id>`, `/all-tools`, `/search?q=`, `/sitemap.xml`, `/robots.txt`,
`/llms.txt`, `/api/catalog.json`, `/terms`, `/privacy`, `/dmca`. All of it renders without JavaScript.

Deploy with `deploy/scripts/deploy.sh` (it refreshes the copied shared package inside each app).

## Jobs (Img, Audio, Docs)

Heavy operations run as durable asynchronous jobs (`apps/_shared/jobs`, roadmap Wave 11). The same
routes answer on every host of the img, audio and docs satellites:

| Route | What it does |
|---|---|
| `POST /api/v1/jobs` | Submit: multipart `type`, `input` (JSON text), `file` / `files`, or JSON `{ type, input }`. `Idempotency-Key` header (8–200 chars). → `202` + `Location`; a repeat with the same key and request → `200` + `Idempotent-Replayed: true` (same job); same key, different request → `409 tools.job.idempotency_conflict`. |
| `GET /api/v1/jobs/:id` | The job: `state` (`queued`, `running`, `succeeded`, `failed`, `cancelled`), `progress {percent, message}`, `attempts`, `result {files, data}`, `error` (problem+json), `retryable`, `expires_at`. |
| `DELETE /api/v1/jobs/:id` | Cancel: queued → `200` cancelled at once; running → `202` (signalled; ffmpeg is killed, sharp/pdf-lib work finishes and is discarded) and ends `cancelled`; finished → `409 tools.job.already_finished`. |
| `GET /api/v1/jobs/:id/events` | SSE: `job.queued`, `job.running`, `job.progress`, `job.cancel_requested`, `job.succeeded`, `job.failed`, `job.cancelled`, each with an `id`. Reconnecting with `Last-Event-ID` (or `?last_event_id=`) replays only later events; a finished job with nothing newer answers `204`. |
| `GET /api/v1/jobs/:id/files/:n` | A result file (attachment); `?inline=1` for previews. |

Job types: `img.process` (input `{ tool: convert|compress|resize|crop, format, quality, width, … }`, one image),
`audio.process` (`{ tool, …options }` as `/api/process` takes them, one audio/video file; progress from ffmpeg),
`docs.process` (`{ tool, …options }`, one PDF, or several files for `merge` / `img2pdf`). A format host fills
in its format (`webp.openvibe.tools` converts to WebP). The synchronous `/api/process` endpoints still work and
run the same code; the pages use jobs and keep the job id in the address (`?job=`) and in sessionStorage, so a
reload reattaches.

- **Durable.** A job and its uploaded input are in `data/jobs.db` and `data/jobs/<id>/` before the `202` is sent.
  After a restart, queued jobs run; jobs that were running are re-queued (all three types, up to their attempt
  limit) — a type can instead declare `onRestart: 'fail'`, which fails them with `retryable: true`.
- **Owner-scoped.** A job is visible only to whoever created it: a signed-in person (`user:usr_…` from the
  `ov_token` subject), an app/service principal (Network client-credentials token, audience `openvibe.tools`,
  capabilities `tools.job.create|read|cancel`), or else this browser's `ov_tools_jobs` cookie (only its hash is
  stored). Anyone else gets `404 tools.job.not_found`.
- **Bounded.** `TOOLS_JOBS_CONCURRENCY` jobs run at once per satellite (default 2; `TOOLS_JOBS_CONCURRENCY_<APP>`
  overrides), `TOOLS_JOBS_MAX_ACTIVE` unfinished jobs per owner (default 10, then `429`), plus the satellites'
  existing burst and processing rate limits on submit.
- **Retention.** Finished jobs expire after 1 hour (browser sessions) or 24 hours (signed-in people, principals);
  the pruner deletes the row, its events, its files and its Media objects.
- **Results in OpenVibe.Media** when `TOOLS_JOB_RESULTS=media`: each result file becomes a private Media object
  (v2 object API, namespace `tools`, owner `X-OV-Subject` for signed-in people) and the job's result carries its
  `media.media_id`; previews redirect to a short-lived signed Media URL, downloads stream through the satellite.
  This needs `OV_OAUTH_CLIENT_SECRET` and Network grants for the `tools` client:
  `media.object.upload` and `media.object.read` for audience `openvibe.media`, namespace `tools`, and a `tools`
  tenant in Media. Without them (or if an upload fails) results stay on local disk and the file says
  `storage: "local"`. Default: `local`.

Environment (all in `/etc/openvibe/tools.env`): `TOOLS_JOBS_CONCURRENCY`, `TOOLS_JOBS_CONCURRENCY_<APP>`,
`TOOLS_JOBS_MAX_ACTIVE`, `TOOLS_JOB_RESULTS`, `TOOLS_MEDIA_NAMESPACE`, `OV_MEDIA_INTERNAL_URL`, `OV_MEDIA_URL`,
`OV_NETWORK_INTERNAL_URL`, `OV_OAUTH_CLIENT_ID`, `OV_OAUTH_CLIENT_SECRET`.

Not done yet: job lifecycle events are not published to OpenVibe.Events; there is no retry endpoint (a failed
retryable job is submitted again); quotas for external developer apps are the per-owner limits above, not a
Codes-issued quota.

## Canonical hosts and the service registry

Every satellite honours the gateway's `X-OV-Tool` / `X-OV-Host-Role` / `X-OV-Canonical-Host` / `X-OV-Short-Host`
headers (`apps/_shared/host-role.js`): canonical links, `og:url` and JSON-LD use the canonical host (a custom
domain included), a custom domain gets its tool's page through `X-OV-Tool`, aliases the gateway missed are
redirected, and a host a satellite does not serve goes to the tools index. Reached directly, each host is its
own canonical as before.

The gateway resolves the other services' origins (Community for pastes, the "elsewhere on OpenVibe" links)
through Network's registry, `GET /api/v1/registry/services` (fetched on boot and every 10 minutes; the last good
answer is kept). Until it answers, a local list is used and `/api/catalog.json` says `services.source: "fallback"`.
Services the registry marks `placeholder` or `retired` are not linked. `OV_REGISTRY_URL` overrides the URL.

## Tests

`npm test` (Node 22) syntax-checks every server file and runs every `apps/*/test/*.test.js`, each in its own
process: the job runtime end to end (restart, reattach, cancel, idempotency, owner scoping, SSE resume, pruning,
Media results with a stand-in Media), img/audio/docs as real processes killed with SIGKILL mid-job, canonical
hosts on every satellite, and the registry-driven catalog. The audio test needs `ffmpeg` and skips without it.
Install first with `npm run install:all`.

## YouTube downloader: when YouTube refuses the server

YouTube blocks some datacentre addresses outright ("Sign in to confirm you're not a bot"). The app
checks every 30 minutes (`GET /api/health` → `youtube: ok | blocked | unknown`) and shows a banner
while blocked. Player-client switches, IPv6, proof-of-origin tokens, the nightly yt-dlp and Cloudflare
WARP were all tried on 2026-09-18 and all refused; what works is a different network identity, set in
`/etc/openvibe/tools.env` and followed by `sudo systemctl restart openvibe-tools-yt`:

- `YT_PROXY=socks5://user:pass@host:port` — a residential or mobile proxy (http, https, socks4/5).
- `YT_COOKIES_FILE=/etc/openvibe/yt-cookies.txt` — a Netscape cookies.txt exported from a throwaway
  YouTube account, readable by the service user. Accounts used this way can be suspended.

## Dev quickstart

```bash
# install every app's dependencies (openvibe-shared comes from the pinned release)
npm run install:all

# gateway — http://localhost:4001
cd apps/gateway && cp .env.example .env   # set OV_OAUTH_CLIENT_SECRET
npm run start:gateway

# any satellite, e.g. maps on http://localhost:4010
npm run start:maps
```

Host-header routing without DNS:

```bash
curl -H 'Host: net.openvibe.tools' http://localhost:4001/
```

The full OAuth round-trip needs OpenVibe.Network running on port 4000
(`BOOTSTRAP_PROFILE=local-dev` seeds a `tools` client with a
`http://localhost:4001/auth/callback` redirect).

## Auth model

- `GET /auth/login` on the gateway → Network `/oauth/authorize`
  (client_id `tools`, scope `profile theme`, state cookie).
- `GET /auth/callback` → server-side code exchange → sets `ov_token`
  (JS-readable, `Domain=.openvibe.tools`, SameSite=Lax, Secure) and
  `ov_refresh` (httpOnly, Path=/auth).
- `GET /auth/login?silent=1&next=…` adds `prompt=none`: the shared navbar
  uses it for one silent sign-in attempt per tab when the browser carries
  `ov_sso_hint=account`. No Network session → straight back to `next` with
  `?sso=none`. A successful callback sets `ov_sso_hint=account` (1 year,
  JS-readable, `Domain=.openvibe.tools`); `/auth/logout` sets it to `guest`.
- `next` must be a relative path, an `https://*.openvibe.tools` URL or an
  `https://openvibe.network/...` URL (the Network's sign-in/sign-out
  everywhere chain hops through the gateway).
- `GET /auth/me`, `POST /auth/refresh`, `GET /auth/logout`.
- Satellites never talk OAuth — they read `ov_token` and verify offline
  via the Network JWKS (`GET /api/.well-known/jwks`).
- Browser pages load shared JS absolutely from
  `https://openvibe.network/shared/` (theme-loader, navbar, …).

## Deploy

- Production path: `/opt/openvibe.tools` (apps under `apps/<name>`)
- Env file: `/etc/openvibe/tools.env` (0600) — shared by all units; per-app
  `PORT` is set in each systemd unit, so tools.env must NOT define PORT.
- Units: `openvibe-tools.service` (gateway) and
  `openvibe-tools-<name>.service` per satellite
  (`apps/<name>/deploy/systemd/`).
- Nginx: satellites have specific `server_name` blocks; the gateway's
  wildcard `*.openvibe.tools` block catches everything else. TLS via
  `/etc/letsencrypt/live/openvibe.tools/`.
