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
apps/_shared   # code the apps require by relative path: host roles, internal auth, the job runtime (jobs/),
               # the guard (guard/: callers, quotas, sniffing, ffmpeg hardening, egress throttles, abuse log),
               # the SSRF guard (egress.js) that every tool reaching a visitor-chosen host or URL goes
               # through (public addresses only, checked after DNS and dialled as checked, redirect hops
               # re-checked). Visit analytics come from openvibe-shared/analytics.
scripts/analytics-prune.js   # operator CLI: raw analytics retention + one-time scrub (dry run by default)
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

Deploy with `deploy/scripts/deploy.sh` (it refreshes the copied shared package inside each app). Once the
gateway is healthy, it runs `ovhost announce tools`. OpenVibe.Host then publishes `host.release.published`
to OpenVibe.Events, and open tabs check `/release.json` within seconds instead of at their next poll. This
is best effort: it is skipped without an `ovhost` that has `announce`, and it never fails the deploy.

## Tool registry API (ADR-027)

Every catalogue tool has one descriptor (`openvibe-contracts` `tools.tool@1`): how it runs (`execution`:
`client` in the browser, `sync` answered inline, `job`), whether the run API exposes it (`api`, `run`), its input
JSON Schema, files, output, limits, `auth` (anonymous or not; `tools.net.probe` for network probes), `quotaClass`,
`cost`, `egress`, hosts and docs page. Public, read-only, cacheable (capability `tools.tool.read`):

| Route | Answer |
|---|---|
| `GET /api/v1/tools` | `tools.tool-list@1`, schemas as `{ $ref }`. Filters `?family=` `?execution=client\|sync\|job` `?api=true\|false` `?status=` `?q=` (comma lists allowed); a bad value → 400 `tools.query.invalid` |
| `GET /api/v1/tools/:id` | `tools.tool@1` with the schemas embedded |
| `GET /api/v1/tools/:id/schema` | `{ $schema, $id, $defs: { input, output } }` (what the list's `$ref`s point at) |

All three answer `Access-Control-Allow-Origin: *` (the apps' own CORS rules do not apply to them), an ETag
(`If-None-Match` → 304) and `Cache-Control: public, max-age=300`, and count against the `/api/` limiter. An unknown
id is 404 problem+json `tools.tool.not_found` (planned placeholders and mirrors say what they are). The gateway
answers for every tool; each satellite answers the same routes for its own tools, with its own live status.
`/api/catalog.json` is unchanged.

- **Specs next to the code.** `apps/<app>/server/descriptors.js` (img, audio, docs, text, yt; maps holds maps and
  food) and `apps/gateway/server/{net,dev}/descriptors.js` are pure data: the operation, job type and preset come
  from the app's domain map, net endpoints from `net/config.js`; `apps/_shared/tools/descriptor.js` joins a spec
  with the catalogue's family, name, summary and hosts (owner overrides included).
- **Checked.** `apps/gateway/server/registry/descriptors.js` merges them and checks every build with
  `contracts.validate('tools.tool@1')`, `contracts.tools.checkDescriptor` and `contracts.tools.checkList`. A failing
  descriptor is left out and `/api/ready` lists it (`tool_registry`, degraded), never a crash.
- **Status.** Unavailable when the catalogue says so (net tools without an implementation) or when the satellite
  lacks a program the tool needs (`requires`: qpdf, pdftoppm/pdfinfo, heif-dec, ffmpeg, yt-dlp). The gateway reads
  each satellite's `GET /api/v1/tools` on loopback every minute and keeps its unavailable marks.
- **Server engines for browser tools.** The pure transforms behind the dev and text pages live in
  `apps/gateway/public/js/dev-engine.js`, `apps/text/public/js/text-engine.js` and `format-engine.js`, which the
  pages load; `apps/gateway/server/dev/engines.js` and `apps/text/server/engines.js` run the same code in Node, so
  those tools say `execution: client, api: true` (the pages stay browser-only). Tools that need a DOM, a CDN
  library or isolation (XML minify, HTML to Markdown, the JS minifier/beautifier, the regex tester, the canvas
  graphics makers) say `api: false`, as does the YouTube downloader (page-only by decision).

## Run API (ADR-027)

`POST /api/v1/tools/:id/run` runs any tool whose descriptor says `api: true` (capability `tools.tool.run`;
`tools.net.probe` for the network probes). The gateway (`https://openvibe.tools`) answers for every tool; img,
audio and docs answer the same route for their own tools. `openvibe-sdk/tools` (v0.6.0) is its client.

- **Request** (`tools.run-request@1`): JSON `{ input, files, wait_ms, idempotency_key }`, or
  `multipart/form-data` with each upload as a `file` part and the text parts `input` (JSON), `files` (the
  file references' JSON), `wait_ms`, `idempotency_key` — exactly what the SDK sends. `?wait_ms=` does the same
  as the field; the `Idempotency-Key` header wins over `idempotency_key`. A file reference is
  `{ job_id, index }` (a result file of one of your own jobs, on any satellite: one tool's output feeds the
  next) or `{ media_id }` (a result of one of your own jobs stored in OpenVibe.Media). Uploads come first,
  then references, in order; the count must fit the descriptor's `files`.
- **Answers** (`tools.run@1`): `200 { state: succeeded, tool, result: { data | text | files }, took_ms[, job] }`;
  `200 { state: failed | cancelled, tool, error, took_ms[, job] }` when the tool itself fails (its
  problem+json: `tools.job.failed`, `tools.pdf.wrong_password`, `tools.net.target_not_public`, …);
  `202 { state: queued | running, tool, job, location }` + `Location: /api/v1/jobs/:id` when a job tool has not
  finished within `wait_ms` (default 0); `200 + Idempotent-Replayed: true` for a replay.
- **Refusals** (problem+json, before the tool runs): `400 tools.run.invalid`, `401 token.missing |
  token.invalid | tools.session_required`, `403 capability.denied | tools.origin.refused`,
  `404 tools.tool.not_found | tools.tool.not_runnable` (`api: false`: the YouTube downloader, the regex tester,
  the canvas makers…) `| tools.run.file_not_found`, `405`, `409 tools.job.idempotency_conflict`,
  `413 tools.file.too_large | tools.input.too_large` (over `limits.maxInputBytes`), `415
  tools.file.unsupported_type` (the bytes are checked), `422 tools.input.invalid` (`errors[]` with JSON
  pointers, against the descriptor's input schema), `429 tools.quota.exceeded` (`Retry-After`), `503
  tools.tool.unavailable` (the descriptor's status is `unavailable`: traceroute, or Protect PDF while qpdf is
  missing), `503 tools.unavailable` (the engine found a program it needs missing: e.g. an HEIC upload without
  libheif), `503 tools.busy` (`Retry-After`).
- **Who.** Always enforced (authorization, not a quota): an app or service token needs the descriptor's
  `auth.capability`; the network probes (port, ping, latency) run only for tokens holding `tools.net.probe`
  (anonymous `401`, a person `403`: people use the probe pages); `auth.anonymous: false` tools (audio, PDF, SMTP)
  need a browser session, a sign-in or a token; a Bearer token that does not verify is `401 token.invalid`, not
  anonymity. Then the guard: the tool's `quotaClass` × the caller's tier, weighted by `cost` (mode-dependent),
  the per-target throttle for egress tools and upload sniffing (hard).
- **Where it runs.** Dev and text tools with a server engine: the page's own engine code in the gateway's
  worker pool (`TOOLS_WORKERS_GATEWAY`, default 2, 256 MB each; the descriptor's `timeoutMs` terminates a
  runaway input). Net tools and Open Graph: the same `/api/net` and `/api/dev` route the page calls, in
  process, with the run's input as its query (`myip` is the caller's address). Job tools (img, audio, docs): a
  job of the satellite that owns the tool (`{ ...input, ...preset, tool: operation }`), the run streamed there
  by the gateway, uploads included; the job's `tool` names the tool.
- **Cache and replays.** An inline answer is reused per tool and input where that is safe (spec `cacheTtlMs`:
  engines 10 minutes unless random or time-dependent — uuid, lorem, timestamp, cron, jwt, zalgo, case, sort, bio,
  nickname never; DNS 1 minute, IP 10, RDAP/whois 60, a few other lookups 5; probes, headers, redirects, uptime,
  SMTP and myip never), answered with `X-OV-Cache: hit` and without touching the target. An inline run's
  `Idempotency-Key` replays its first answer for 15 minutes (per caller); a job tool's key is its job's.
- **CORS.** First-party pages keep the credentialed rules; any other site's page gets `Access-Control-Allow-Origin: *`
  without credentials on the run and jobs routes (so its calls carry a token, never our cookies).
- `GET /api/health` on the gateway shows `run` (counts, cache, engine pool) and `jobs` (the facade).

## Jobs facade (gateway)

`https://openvibe.tools/api/v1/jobs…` fronts every satellite's job routes (below), so one origin serves the
run API's `Location`, `openvibe-sdk/jobs` without a `baseUrl`, and anything else. A submit is routed by its job
type's prefix (`img.process` → img …): `?type=`, the JSON body's `type`, or the multipart `type` part (read from
the first 64 KB of the stream — send it before the files; the uploads then stream through untouched). Every other
route (`GET`/`DELETE /:id`, `/:id/events`, `/:id/files/:n`, `/:id/retry`, `/:id/references/:ref`) is routed by the
job id: the satellite that answered its submit or run (remembered, 50,000 ids), else the one that says it holds
the job when asked on loopback (`GET /api/internal/jobs/:id`, direct loopback callers only, never rate
limited). Events (SSE) and files stream through. Owners, quotas, the Origin check and idempotency stay the
satellite's: the request reaches it with the caller's credentials and address.

## Older endpoints (deprecated, still answered)

`/api/process`, `/api/process/direct`, `/api/process/multi` (img, audio, docs), `/api/net/*` and `/api/dev/*`
keep their response shapes and add `Deprecation: true`, `Sunset: Thu, 31 Dec 2026 23:59:59 GMT` and
`Link: </api/v1/tools/{id}/run>; rel="successor-version"` (the host's own tool; `/api/net/tools` and
`/api/dev/tools` point at `/api/v1/tools?family=…`). The webhook bins (`/api/dev/webhook/…`, page-only) have no
successor and are not marked.

## Jobs (Img, Audio, Docs)

Heavy operations run as durable asynchronous jobs (`apps/_shared/jobs`, roadmap Wave 11). The same
routes answer on every host of the img, audio and docs satellites:

| Route | What it does |
|---|---|
| `POST /api/v1/jobs` | Submit: multipart `type`, `input` (JSON text), `file` / `files`, or JSON `{ type, input }`. `Idempotency-Key` header (8–200 chars). → `202` + `Location`; a repeat with the same key and request → `200` + `Idempotent-Replayed: true` (same job); same key, different request → `409 tools.job.idempotency_conflict`. |
| `GET /api/v1/jobs/:id` | The job: `state` (`queued`, `running`, `succeeded`, `failed`, `cancelled`), `progress {percent, message}`, `attempts`, `result {files, data}`, `error` (problem+json), `retryable`, `expires_at`. |
| `DELETE /api/v1/jobs/:id` | Cancel: queued → `200` cancelled at once; running → `202` (signalled; ffmpeg is killed, a sharp/pdf-lib worker thread is terminated) and ends `cancelled`; finished → `409 tools.job.already_finished`. |
| `GET /api/v1/jobs/:id/events` | SSE: `job.queued`, `job.running`, `job.progress`, `job.cancel_requested`, `job.succeeded`, `job.failed`, `job.cancelled`, each with an `id`. Reconnecting with `Last-Event-ID` (or `?last_event_id=`) replays only later events; a finished job with nothing newer answers `204`. |
| `GET /api/v1/jobs/:id/files/:n` | A result file (attachment); `?inline=1` for previews. |
| `POST /api/v1/jobs/:id/retry` | Retry a **failed** job: a new job with the same type, input and files (`retry_of` → the failed one, which gets `retried_by`) → `202` + `Location`. Idempotent: asking again returns that same retry with `200` + `Idempotent-Replayed: true`. Not failed → `409 tools.job.not_failed`; inputs gone → `410 tools.job.inputs_gone`. A failed job keeps its input files until it expires. |
| `PUT /api/v1/jobs/:id/references/:ref` | Keep a **succeeded** job's result while `<ref>` (`<service>:<kind>:<id>`, e.g. `community:paste:p_123`) points at it → `201` (`200` if already there). The job then shows `references` and `expires_at: null`. At most 50 per job; not for sandbox jobs. |
| `DELETE /api/v1/jobs/:id/references/:ref` | Drop it → `200`; after the last one the job expires one ttl later at the earliest. |

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
- **Worker threads.** sharp (img) and pdf-lib (docs) never run on the event loop: `apps/_shared/jobs/pool.js`
  runs them in `worker_threads`, `TOOLS_WORKERS` at once per satellite (default 2; `TOOLS_WORKERS_<APP>`), shared
  by the jobs and the synchronous `/api/process` endpoints (which submit to the pool and wait), with
  `TOOLS_WORKER_QUEUE` (64) more waiting before `503 tools.busy`. Each worker has a V8 heap limit
  (`TOOLS_WORKER_MEMORY_MB`, 512; `TOOLS_WORKER_MEMORY_MB_<APP>`): a run that needs more fails with
  `413 tools.input.too_large` and its worker is replaced. A run past its timeout (the job's, or the descriptor's
  `limits.timeoutMs` on the sync endpoints: `504 tools.run.timeout`), a cancelled job or a sync client that went
  away has its worker terminated at once. Idle workers stop after `TOOLS_WORKER_IDLE_MS` (60 s). qpdf and poppler
  tools stay on the main thread (their child processes have their own timeouts). `GET /api/health` shows `workers`.
- **Bounded.** `TOOLS_JOBS_CONCURRENCY` jobs run at once per satellite (default 2; `TOOLS_JOBS_CONCURRENCY_<APP>`
  overrides), `TOOLS_JOBS_MAX_ACTIVE` unfinished jobs per owner (default 10, then `429`), and all browser sessions
  from one address together `TOOLS_JOBS_MAX_ACTIVE_PER_ADDRESS` (default 3 × that; jobs keep only the guard's hashed
  address key), at most
  `TOOLS_JOBS_MAX_QUEUED` queued jobs in all (default 200) and `TOOLS_DISK_BUDGET_MB` under `data/jobs` (default
  8192) before a submit answers `503 tools.busy` with `Retry-After` (through the guard, below), plus the guard's
  quotas and the satellites' older burst and processing limits on submit.
- **Retention.** Finished jobs expire after 1 hour (browser sessions) or 24 hours (signed-in people, principals);
  the pruner deletes the row, its events, its files and its Media objects. It never touches a job that has a
  reference (above). If Media will not delete a result object (a retention hold, `409 media.object.held`), cannot
  be reached, or is no longer configured here, the job is kept, record and all, and looked at again 24 hours
  later, so no object is left without the record that would delete it.
- **Results in OpenVibe.Media** when `TOOLS_JOB_RESULTS=media`: each result file becomes a private Media object
  (v2 object API, namespace `tools`, owner `X-OV-Subject` for signed-in people) and the job's result carries its
  `media.media_id`; previews redirect to a short-lived signed Media URL, downloads stream through the satellite.
  This needs `OV_OAUTH_CLIENT_SECRET` and Network grants for the `tools` client:
  `media.object.upload` and `media.object.read` for audience `openvibe.media`, namespace `tools`, and a `tools`
  tenant in Media. Without them (or if an upload fails) results stay on local disk and the file says
  `storage: "local"`. Default: `local`.
- **Lifecycle events to OpenVibe.Events** when `EVENTS_URL` is set (`apps/_shared/jobs/events.js`):
  `tools.job.created` (submit or retry; actor the owner), `tools.job.started` (a worker claimed it; a job
  re-queued after a restart is announced again when it starts), `tools.job.succeeded` and `tools.job.failed`
  (payloads `openvibe-contracts` `tools.job.*@1`, validated before they are queued; subject `job <id>`, visibility
  `internal`, source `tools`). Each is written to an `event_outbox` table in the satellite's `jobs.db` (openvibe-sdk
  `createOutbox`) in the same SQLite transaction as the state change, so an event exists exactly when its
  transition committed, and relayed to `EVENTS_URL/api/v1/events` (at least once; Events dedupes on `event_id`).
  Payloads carry ids, type, owner, state, attempts, times, where result files are (index, mime, size, sha256,
  `local` or a Media `media_id`) and the error (`status`, `code`, `detail` with server paths and the job's file
  names taken out) — never the input, file names, output data or a browser session: a session's job has
  `owner: null`. Cancelled jobs, progress and sandbox app jobs are not announced; an Idempotency-Key replay
  creates no job and no event. The relay uses the `tools` client (`OV_OAUTH_CLIENT_ID`, `OV_OAUTH_CLIENT_SECRET`)
  with `events.event.publish` on audience `openvibe.events`. Without `EVENTS_URL` (or with `EVENTS_PUBLISH=off`, or
  no client secret) nothing is written or sent. `GET /api/health` shows `jobs.events` (pending, rejected).

Environment (all in `/etc/openvibe/tools.env`): `TOOLS_WORKERS`, `TOOLS_WORKERS_<APP>`, `TOOLS_WORKER_MEMORY_MB`,
`TOOLS_WORKER_MEMORY_MB_<APP>`, `TOOLS_WORKER_QUEUE`, `TOOLS_WORKER_IDLE_MS`, `TOOLS_JOBS_CONCURRENCY`, `TOOLS_JOBS_CONCURRENCY_<APP>`,
`TOOLS_JOBS_MAX_ACTIVE`, `TOOLS_JOB_RESULTS`, `TOOLS_MEDIA_NAMESPACE`, `OV_MEDIA_INTERNAL_URL`, `OV_MEDIA_URL`,
`OV_NETWORK_INTERNAL_URL`, `OV_OAUTH_CLIENT_ID`, `OV_OAUTH_CLIENT_SECRET`, `EVENTS_URL`, `EVENTS_PUBLISH`,
`EVENTS_RELAY_INTERVAL_MS`.

Not done yet: quotas for external developer apps are the guard's service and sandbox tiers, not a Codes-issued quota.

## Guard (anti-abuse, `apps/_shared/guard`)

One module used by the gateway and every satellite, driven by each tool's descriptor (`quotaClass`, `cost`, `auth`,
`files.accept`, `limits`) and the numbers in `apps/_shared/guard/limits.js` (the one place they live).

- **Who is asking** (`caller.js`, replacing the four copied `auth.js` files): a **service or app principal**
  (Bearer client-credentials token, audience `openvibe.tools`; a developer app's sandbox token is tier `sandbox`), a
  **user** (the `ov_token` cookie or a Bearer Network token, verified offline, issuer **and audience
  `openvibe.tools`** — the Network puts that audience on every browser sign-in; its `/internal/issue-token` tokens
  carry none and are not believed), a **session** (this browser's `ov_tools_jobs` cookie; the page's `/api/context`
  call and the first job or webhook bin start one) or else **anonymous**, counted by address (IPv6 by its /64).
  Tiers: anonymous < session < user < service.
- **One address source.** Every app sets `trust proxy` to `TRUST_PROXY`: exactly one hop, and only on loopback (the
  host's nginx, which sets `X-Forwarded-For` from `$remote_addr` after Cloudflare's real IP). `req.ip` is the only
  address anything reads. The gateway's proxy to a satellite passes its own `req.ip` as that one hop; food passes its
  visitor's to maps. A first-party service calling on loopback is identified by its service token (each has its own
  bucket at the service tier); without one it is anonymous, counted by the address it forwarded or its own.
- **Quotas.** A token bucket per quota class × tier in memory (`perMinute`, `burst`) and a UTC-day allowance in the
  app's `data/guard.db` (survives restarts), both counting the tool's `cost`. Browser sessions from one address share
  3 × one session's allowance, so dropping the cookie never resets anything. Counted answers carry
  `RateLimit-Limit`/`-Remaining`/`-Reset`; a refusal is `429` problem+json `tools.quota.exceeded` with `Retry-After`
  and `quota_class`, `scope`, `tier`.
- **Heavy work.** Synchronous `/api/process` (img, audio, docs) holds one of `TOOLS_SYNC_CONCURRENCY` slots
  (default 2; `TOOLS_SYNC_QUEUE` may wait, 8, for `TOOLS_SYNC_WAIT_MS`, 30 s), else `503 tools.busy`. Every sync
  path is stopped at the descriptor's `timeoutMs` (`504 tools.run.timeout`) or when the client goes away: audio's
  ffmpeg is killed, img's and docs' worker thread is terminated (Jobs → Worker threads). Liveness and readiness
  probes (`GET /api/health`, `/api/ready`) are never rate limited.
- **Uploads.** The bytes are checked against the descriptor's `files.accept` (`415 tools.file.unsupported_type`;
  a misleading extension is corrected); docs uploads go to disk. Tools whose descriptor says `auth.anonymous: false`
  (audio, PDF) need a session, a sign-in or a token (`401 tools.session_required`). Images: no input over
  `TOOLS_MAX_INPUT_PIXELS` (40 MP, as Media) is decoded (header first, sharp `limitInputPixels` behind it).
- **ffmpeg.** Every input and probe: `-protocol_whitelist file,pipe`, `-format_whitelist` of the operation's
  demuxers (never hls, concat, image2, lavfi…), `-t` = the descriptor's `limits.maxDurationSec` (3 h); inputs are
  probed first and a longer one is refused (`413`).
- **Egress.** A per-target throttle across all callers and tools (`limits.perTargetPerMinute`; a host's minute is
  shared by headers, SSL, ping…); the port checker takes at most 20 ports a request and 100 ports / 10 hosts per
  caller in 10 minutes (sessions counted by address). Probes through a token need `tools.net.probe`. Webhook bins
  belong to their maker (session, sign-in or token; anyone else gets 404), at most 5 per owner and 10 per address.
  YouTube downloads belong to whoever started them. Nominatim is paced to one request a second; Overpass waits are
  capped.
- **Abuse log.** Every refusal, and every would-be refusal in report mode, goes to `guard.db`: time, `HMAC-SHA256`
  of the address (or /64) with a random daily salt (only today's is kept, so older hashes cannot be tied to
  anything), principal or user id, tool, reason, enforced or not; repeats within a minute are one row with a count;
  kept 30 days. No raw address is stored anywhere (pseudonymous, ADR-021). Metrics: `tools_guard_refused_total{reason,tool}`,
  `tools_guard_enforcing`, `tools_guard_sync{kind}`.
- **Challenge hook.** `createGuard({ challenge })` takes a person-check provider (`required`, `verify`; Turnstile
  later); the default challenges nobody.
- **Cross-site requests (CSRF).** A mutation that rides on the browser's cookies (`ov_token`, the jobs session)
  must come from an OpenVibe.Tools page: `Origin` (else `Referer`) `https://openvibe.tools`,
  `https://*.openvibe.tools`, one of the tool's own hosts (custom domains included) or the request's own host.
  Calls with a Bearer token, calls without those cookies and requests with neither header pass. Checked on the
  run API, the job routes' writes, `/api/process…`, `/api/info`, `/api/probe` and the webhook bins' create and
  delete; `403 tools.origin.refused`, recorded as reason `origin`.
- **Mode.** `TOOLS_GUARD=report` (default) records and counts what it would refuse and refuses nothing, and the
  apps' older express-rate-limit limiters stay in force (now keyed by the resolved caller, after sign-in is read).
  `TOOLS_GUARD=enforce` refuses and the older limiters step aside. (On `/api/v1/…` an older limiter's refusal is
  problem+json `tools.quota.exceeded`, `scope: "legacy"`, with `Retry-After`; job runs through the run API pass the
  same burst and processing limiters as job submits.) Hard limits apply in both modes: the pixel limit,
  ffmpeg's whitelists and duration cap, upload sniffing, the port-scan cap and the per-target throttle.

Default quotas (units = descriptor `cost` per run; `perMinute` / `burst` / `perDay`, 0 = none):

| Class | anonymous | session | user | service | sandbox |
|---|---|---|---|---|---|
| `tools-api` (every `/api/` call, cost 1) | 120 / 60 / – | 180 / 90 / – | 480 / 240 / – | 2400 / 1200 / – | 60 / 30 / – |
| `tools-run` (text, dev engines) | 120 / 60 / 5000 | 180 / 90 / 10000 | 480 / 240 / 50000 | 2400 / 1200 / 500000 | 60 / 30 / 1000 |
| `tools-fetch` (lookups, Open Graph) | 60 / 30 / 2000 | 90 / 45 / 4000 | 240 / 120 / 20000 | 1200 / 600 / 200000 | 30 / 15 / 500 |
| `tools-probe` (port, ping, latency) | 30 / 15 / 600 | 45 / 25 / 1000 | 120 / 60 / 5000 | 600 / 300 / 50000 | 15 / 10 / 200 |
| `tools-job` (img, audio, docs) | 60 / 30 / 1500 | 90 / 45 / 3000 | 240 / 120 / 20000 | 1200 / 600 / 200000 | 30 / 15 / 300 |
| `tools-map` (maps, food) | 60 / 40 / 6000 | 90 / 60 / 8000 | 240 / 120 / 20000 | 1200 / 600 / 200000 | 30 / 20 / 500 |
| `tools-download` (yt, cost 50) | 50 / 100 / 1500 | 75 / 150 / 2500 | 150 / 300 / 5000 | 300 / 600 / 10000 | 25 / 50 / 100 |

Environment: `TOOLS_GUARD`, `TOOLS_GUARD_LIMITS` (JSON merged into the table, e.g.
`{"tools-job":{"anonymous":{"perDay":800}}}`), `TOOLS_SYNC_CONCURRENCY`, `TOOLS_SYNC_QUEUE`, `TOOLS_SYNC_WAIT_MS`,
`TOOLS_JOBS_MAX_QUEUED`, `TOOLS_JOBS_MAX_ACTIVE_PER_ADDRESS`, `TOOLS_DISK_BUDGET_MB`, `TOOLS_MAX_INPUT_PIXELS`, `TOOLS_PORTS_PER_CALLER`,
`TOOLS_PORT_TARGETS_PER_CALLER`, `AUDIO_MAX_DURATION`, `OV_TOOLS_AUDIENCE` (white-label installs).

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

## Metrics and readiness

Every server (gateway and satellites) mounts `apps/_shared/observe.js` with `openvibe-shared/metrics` and
`openvibe-shared/ready`:

- `GET /metrics` — Prometheus text for **direct loopback callers only** (127.0.0.1/::1 with no
  `X-Forwarded-For`/`X-Real-IP`); anything through nginx or the gateway gets 404, and each nginx server block
  also answers `location = /metrics` with 404. HTTP golden signals are labelled by route template
  (`/api/v1/jobs/:id`), proxied satellite traffic on the gateway by satellite (`proxy:img`), SPA pages and
  static files by a fixed label — never the raw URL. `release_info{service="tools"|"tools-<app>"}`, process
  metrics, and on img/audio/docs `tools_jobs{app,state}` (a group-by on jobs.db) and
  `tools_jobs_executing{app,kind="executing"|"limit"}`.
- `GET /api/ready` — named checks with `status`, `required`, `latency_ms`, `checked_at`; HTTP 503 only when a
  required check fails, otherwise 200 with failed optional checks listed in `degraded`. `/api/health` is
  unchanged.

| Server | Required | Optional (degraded when failing) |
|---|---|---|
| gateway (4001) | `catalog` | `network_key`, `service_directory` (Network registry vs fallback list), `community` (`/api/ready`), `satellite_<app>` for all seven (`/api/ready`, cached 15 s), `tool_registry` (every catalogue tool has a descriptor that meets the contracts) |
| img, docs (4012, 4016) | `jobs_db` (query), `job_runtime` (worker started), `data_dir`, `uploads_dir`, `output_dir` (write test) | `analytics_db`, `network_key`, `media_results` (only with `TOOLS_JOB_RESULTS=media`); img: `heif_decoder`; docs: `qpdf`, `pdftoppm`, `pdfinfo` |
| audio (4014) | same as img | same as img, plus `ffmpeg` on PATH |
| yt (4013) | `downloads_dir` | `analytics_db`, `yt_dlp`, `ffmpeg`, `yt_cookies` (when `YT_COOKIES_FILE` is set), `network_key` |
| food (4011) | `maps` (every food API is proxied to it) | `analytics_db` |
| maps, text (4010, 4015) | — | `analytics_db` (maps' external data sources are not probed) |

`TOOLS_SATELLITE_PORTS="img=5012,…"` overrides the gateway's satellite ports (tests, a moved unit); every app reads
it (`apps/_shared/tools/satellites.js`), so set it for all units if a port moves.

**Releases (ADR-016).** Every app mounts openvibe-shared's `release.mount` (`apps/_shared/release.js`): `GET
/release.json` and `POST /release-metrics` (the shared navbar's release-watch outcomes →
`release_client_updates_total` on `/metrics`). The gateway, img, audio and docs (which pin openvibe-contracts) serve
manifest 1.1.0 components: `shell` (what their pages are made of: `public/`, the server files that stamp the pages,
the job helper) and `server` (the rest), so a release that changes only API code no longer reloads open tabs. Maps,
food, text and yt serve the 1.0.0 fields.

## Tests

`npm test` (Node 22) syntax-checks every server file and runs every `apps/*/test/*.test.js`, each in its own
process: the job runtime end to end (restart, reattach, cancel, idempotency, owner scoping, SSE resume, pruning,
Media results with a stand-in Media), img/audio/docs as real processes killed with SIGKILL mid-job, canonical
hosts on every satellite, the registry-driven catalog, and `registry-consistency.test.js`: every catalogue
tool resolves to an operation, endpoint or page that exists, or is marked unavailable. `descriptors.test.js`
holds every descriptor to the contracts and to the code (a job's operation, validation, files and limits; a sync
tool's route), `engines.test.js` runs every browser tool's server engine in plain Node against its output schema,
and `tools-api.test.js` checks the three routes on the gateway and all seven satellites. `run-api.test.js` runs
the run API on the gateway, img and docs (with a stand-in Network for tokens, `apps/_shared/test/network.js`):
every answer against `tools.run@1`, the refusal codes, probes, quotas, idempotency, job tools and references
across satellites, the Origin check and the deprecation headers; `jobs-facade.test.js` routes jobs through the
gateway (by type, by id after a restart, events, files, retry, cancel); `sdk-client.test.js` drives
openvibe-sdk v0.6.0's `createToolsClient` against the real gateway (it requires a checkout of OpenVibe.SDK next to
this repo, or `OV_SDK_DIR`, and says it skipped without one); `pool.test.js` (shared and docs) hold the worker
pool to its limits. The audio tests need
`ffmpeg` and skip without it. The docs and img tests always check the 503 path with qpdf, poppler and libheif
pointed at nothing, and also run the real encrypt/decrypt, page rendering and HEIC decoding when those programs
are installed (or `QPDF_PATH` / `HEIF_DEC_PATH` point at them). Install first with `npm run install:all`.

## Analytics (ADR-021)

Every satellite except the gateway keeps visit analytics in its own `data/analytics.db` through
`openvibe-shared/analytics` (since openvibe-shared v1.4.0; the one module Live, Tools and Network use).
Bound by ADR-021 (OpenVibe.Contracts `docs/adr/ADR-021-analytics.md`):

- **A raw row carries** event type, service, route template (matched Express route, else a normaliser: no
  query string, ids/hashes → `:id`, the segment after `watch`, `jobs`, `recipe`, `place`, … → `:param`,
  `/@x` → `/@:user`), method, status, response time, a rotating session id, country (CDN header),
  user-agent class (`chrome/windows/desktop`, `bot:googlebot`) + browser/os/device, referer origin, bot
  flags, a signed-in flag, timestamp. **Never** an IP, a user id, a city, the UA string or a full referer
  (`ip`/`user_id`/`city` stay as always-NULL columns for compatibility).
- **Opt-out:** a request with `Sec-GPC: 1` or `DNT: 1` is not recorded at all (no raw row, visitor hash,
  session id or rate counter), so it is also missing from the rollups.
- **Session id:** random, in memory against the visitor hash, new after 30 idle minutes and at UTC midnight.
- **Bot rate check:** per-IP counters in memory only (current + previous minute); `analytics_rate_tracking`
  is emptied at boot and no longer written.
- **Unique visitors:** `HMAC-SHA256(day salt, ip + "\n" + ua)` (16 hex chars), random salt per UTC day. Hashes
  and the salt are kept only until the first hourly aggregation after their day ends (right after the
  day's final rollup), never in raw rows. Rollups keep counts; sub-48 h raw summaries count sessions.
- **Retention:** each satellite prunes raw rows older than 30 days in batches of 5000, 5 minutes after boot
  and every 24 h after; rollups stay.
- **CLI:** `node scripts/analytics-prune.js`, a wrapper over `openvibe-shared/analytics/prune-cli` (dry run
  over every `apps/*/data/analytics.db`; `--app`, `--db` to narrow). `--apply` needs `--backup <file|dir>`
  (verified owner-only online backup; a directory when several databases are targeted) or `--no-backup`;
  `--scrub` also rewrites rows written before ADR-021 and the rollups' top lists (counts unchanged). Ends
  with VACUUM unless `--no-vacuum`.

## Host packages some tools need

A few operations run a program that is not part of Node. Each satellite looks for it at boot (on `PATH`,
or at the path in its environment variable) and again every minute while it is missing; until it is
there, the operation answers **503 problem `tools.unavailable`** ("this tool is being set up") on
`/api/process` and at job submit, its page says so instead of offering the upload, and `/api/ready`
lists it under `degraded`. Nothing pretends to work.

| Package (Ubuntu) | Program | Used by | Override |
|---|---|---|---|
| `qpdf` | `qpdf` | Protect PDF (AES-256), Unlock PDF | `QPDF_PATH` |
| `poppler-utils` | `pdftoppm`, `pdfinfo` | PDF to image | `PDFTOPPM_PATH`, `PDFINFO_PATH` |
| `libheif-examples` + `libheif-plugin-libde265` | `heif-dec` (or `heif-convert`) with an HEVC decoder | HEIC (iPhone) photos on every image tool | `HEIF_DEC_PATH` |
| `ffmpeg` | `ffmpeg`, `ffprobe` | every audio tool | `FFMPEG_PATH` |

sharp's prebuilt libvips cannot decode HEIC (HEVC) at all, and it cannot read or write BMP or read ICO:
BMP and ICO are handled in JavaScript (`apps/img/server/tools/codec.js`), HEIC by libheif's CLI.

Limits (all in `/etc/openvibe/tools.env`): `PDF_MAX_PAGES` (500 pages per document, every PDF tool),
`PDF2IMG_MAX_PAGES` (50 pages per conversion up to 150 dpi; 40 % of that up to 300 dpi, 10 % above),
`YT_MAX_DURATION` (seconds, default 3 hours), `YT_MAX_FILESIZE_MB` (per downloaded part, default 2048),
`YT_INFO_CONCURRENCY` (yt-dlp lookups at once for `/api/info`, default 3; 20 more wait, then 503).
Net tools: `NET_IPINFO_TOKEN` makes IP lookups use ipinfo.io over HTTPS instead of ip-api.com's free tier
(HTTP only); ip-api/ipinfo, RDAP and DNS-over-HTTPS answers are cached either way. `NET_GLOBALPING_TOKEN`
is read but not used yet. Traceroute, MTR and the reputation report are marked unavailable (the first
two need raw sockets); ping and latency are timed TCP connections to port 443 from this server.

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
  (`apps/<name>/deploy/systemd/`). Resource bounds: `MemoryMax=2G` (img, audio,
  docs), `1G` (yt), `768M` (gateway, text, maps, food); `TasksMax=256`; `Nice=5`
  for img, audio, docs and yt. Every app writes `data/guard.db` (the gateway
  too: `ReadWritePaths=/opt/openvibe.tools/apps/gateway/data`; `deploy.sh`
  creates each `data/` before restarting).
- Nginx: satellites have specific `server_name` blocks; the gateway's
  wildcard `*.openvibe.tools` block catches everything else. TLS via
  `/etc/letsencrypt/live/openvibe.tools/`.
