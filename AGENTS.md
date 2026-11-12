# AGENTS.md — OpenVibe.Tools

## Project overview

OpenVibe.Tools is the network's tools suite: hundreds of single-purpose tools (images, text, audio, docs,
maps, video) at `openvibe.tools` and `*.openvibe.tools`, each open by API. It is a multi-app monorepo —
a gateway plus seven satellites — that share a registry, a run API, a job runtime and an anti-abuse
guard.

```
apps/gateway   openvibe.tools, net./dev./pastes. and the tool aliases   :4001
apps/maps      maps.openvibe.tools                                      :4010
apps/food      food.openvibe.tools (the page moved to OpenVibe.Food)    :4011
apps/img       img.openvibe.tools + format aliases                      :4012
apps/yt        yt.openvibe.tools                                        :4013
apps/audio     audio.openvibe.tools + effect aliases                    :4014
apps/text      text./logo.openvibe.tools + aliases                      :4015
apps/docs      docs./pdf.openvibe.tools                                 :4016
apps/_shared   openvibe-tools-shared: host roles, internal auth, jobs, guard, egress
```

- **Registry:** `apps/gateway/server/registry` is the one list of tools/families; each has a canonical
  host, an optional short host and aliases that 301. Descriptors are `tools.tool@1`.
- **Run API:** `POST /api/v1/tools/:id/run` on the gateway and on img/audio/docs for their tools
  (`tools.run-request@1`, JSON or multipart, `wait_ms`, `idempotency_key`); SDK `openvibe-sdk/tools`.
- **Jobs:** `apps/_shared/jobs/` plus the gateway jobs facade and each satellite's job type; job
  records, abuse logs, revocations, analytics and the outbox are in PostgreSQL.
- **Guard:** `apps/_shared/guard/` (callers, quotas, sniffing, ffmpeg hardening, egress throttles,
  abuse log) and `apps/_shared/egress.js` (SSRF-safe fetch; public addresses only, checked after DNS,
  redirect hops re-checked).
- **Pages:** all server-rendered (the gateway index/family/tool pages, catalogue, sitemap/llms);
  browser tools ship their own JS, no bundler at the service level. `openvibe-shared` is pinned per app.

## Owns, does not own

Owns the tool registry (families, tools, descriptors, canonical/short/alias hosts), the catalog and
every tool page on `openvibe.tools` and `*.openvibe.tools`, the run API and jobs runtime (files, SSE
progress), the guard, the `tools.*` events, Tools' Search documents and the `tools.usage` user module.

Does not own: identity/sign-in (Network), pastes (Community; `pastes.openvibe.tools` hands over),
result storage (Media keeps job results), custom-domain records (Network's domains admin — the gateway
merges the owner's host overrides every minute).

## Who calls it, what it calls

People use the pages and the API; services and developers use `openvibe-sdk/tools` (`list`, `get`,
`schema`, `run`, `jobs`). The run API is the public capability (`tools.tool.run`; `tools.net.probe` for
network probes; `tools.tool.read` for the registry), with per-tier quotas and per-actor limits. Tools
calls Network (SSO, JWKS, registry/domains admin, notification/usage), Media (job results), Community
(pastes hand-over), Events (outbox and `host.release.published`) and the outside hosts a tool needs
through the SSRF guard. Billing receives Tools' job usage readings.

## Auth model

The gateway is the OAuth client (`client_id: tools`): `/auth/login` → Network authorize, `/auth/callback`
→ server-side code exchange → sets `ov_token` (JS-readable, `Domain=.openvibe.tools`, SameSite=Lax,
Secure) and `ov_refresh` (httpOnly, `Path=/auth`). A satellite never talks OAuth: it reads `ov_token`
and verifies offline with the Network JWKS. `next` accepts only a relative path, `https://*.openvibe.tools`
or `https://openvibe.network/...`. Every caller is identified (service principal, user, session or
address) and held to quotas/limits; every tool reaching a visitor-chosen host or URL goes through the
SSRF guard. `trust proxy` is one loopback hop.

## Database and migrations

One PostgreSQL database for all eight apps through `openvibe-sdk/db`; `DATABASE_DIRECT_URL` applies
the immutable `migrations/` at boot, `DATABASE_URL` serves. Development/tests use PGlite through the
same API. Transient guard throttle counters and the salt live in Valkey (`VALKEY_URL`), with
process-local state when unset. Migrations only add — never edit one that has run, and nothing may
block a rollback.

## Deploy

`sudo ovhost deploy tools` via `deploy/scripts/deploy.sh` (strategy `multi-app`; flags `--wait-idle`,
`--restart`, `--rollback`, `DRY_RUN=1`). The wrapper pulls as the checkout owner, installs in changed
apps (`apps/_*` are packages, not apps), checks every dependency resolves and the job runtime/guard
load, restarts every `openvibe-tools*` unit, waits for the gateway `/api/ready` and `/release.json` to
name the new sha with every unit active, rolls back otherwise, then announces the release. Production
path `/opt/openvibe.tools`; env `/etc/openvibe/tools.env` (0600, shared by all units; per-app `PORT` is
in each systemd unit, so tools.env must NOT define PORT). Units: `openvibe-tools.service` and
`openvibe-tools-<name>.service` (`apps/<name>/deploy/systemd/`); nginx satellites have specific
`server_name` blocks and the gateway's wildcard `*.openvibe.tools` catches the rest. New custom domain:
`sudo deploy/scripts/add-custom-domain.sh <domain>`.

## Commands and tests

```bash
npm ci && npm run install:all
npm run start:gateway        # http://localhost:4001
npm run start:img            # any satellite, e.g. :4012
npm test                     # syntax-check every server file + every apps/*/test/*.test.js
npm run test:pg              # the suite against PostgreSQL + Valkey
npm run test:discovery       # catalog/hosts/discovery/run-api/perf subset
npm run test:worker          # the worker runtime tests
```

`npm test` runs each file in its own process and covers the job runtime end to end (restart, reattach,
cancel, idempotency, owner scoping, SSE resume, pruning, Media results), real img/audio/docs processes
killed mid-job, canonical hosts, the registry-driven catalog, `registry-consistency.test.js` (every
catalogue tool resolves to a real operation/page or is marked unavailable), descriptors against the
contracts and code, every browser tool's engine against its output schema, the run API on gateway/img/
docs, the jobs facade and the pinned SDK client. Audio tests skip without `ffmpeg`; docs/img check the
503 path and run real qpdf/poppler/libheif work when installed. `sdk-client.test.js` needs an
OpenVibe.SDK checkout (`OV_SDK_DIR`) and says it skipped without one.

## Conventions and pitfalls

- **The registry is the source of truth:** adding a tool means a descriptor, a registry entry, a route/
  operation and a page that resolve to each other — `registry-consistency.test.js` fails otherwise.
  Never hand-write a catalog page that the registry does not know.
- **Descriptor first:** `execution` (`client`/`sync`/`job`), `api`, `run`, input schema, files, output,
  limits, auth, `quotaClass`, `cost`, `egress`, hosts and docs are one contract; the code must match it.
- **Every outbound fetch of a visitor-chosen URL uses `apps/_shared/egress.js`.** Uploads are sniffed
  against the descriptor before a job sees them; ffmpeg runs hardened. A new tool must not call `fetch`
  directly.
- **Idempotency:** a run with the same key replays; a different request under the key is a conflict.
  Jobs are owner-scoped and survive reattach after a restart.
- **One shared env file:** a `PORT` in `tools.env` will fight the per-unit ports. Secrets
  (`OV_OAUTH_CLIENT_SECRET`, `TOOLS_EVENTS_SECRET`, NET_IPINFO_TOKEN, RIDB/NPS keys) live only there.
- **YouTube refusal is infrastructure, not code:** `/api/health` reports `youtube: ok|blocked|unknown`
  and the page shows a banner; a proxy is set in `tools.env` and applied by restarting
  `openvibe-tools-yt`. Do not add a bypass that ignores the block.
- **`apps/_shared` is a versioned package:** every app declares the range it needs and refuses to boot
  when the checkout does not satisfy it.
