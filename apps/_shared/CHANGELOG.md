# openvibe-tools-shared (apps/_shared)

The Tools apps' shared runtime. Each app declares the range it needs as `"openvibeToolsShared"` in
its `package.json`, and refuses to boot when this checkout does not satisfy it (`version.js`). A
breaking change bumps the major and every app's range in the same commit.

## 1.2.0 — 2026-09-27

Additive (roadmap WS-R task 4):

- `actor-limits.js`: `createToolsLimits({ app, createActorLimiter, guard, registry })`, per-actor
  limits (openvibe-sdk/limits, which the app passes in) only where the guard has no per-caller limit:
  `registryReads` (GET/HEAD `/api/v1/tools[/:id[/schema]]` by a signed-in person or a third-party
  principal, `TOOLS_LIMITS_MINUTE` / `TOOLS_LIMITS_HOUR`, 120 and 3000; signed-out reads and first-party
  services are not counted), `backstop(name)` (a ceiling above the guard's quotas on job submits,
  retries and runs: a person or address 600 a minute and 20 000 an hour, a principal 3000 and 100 000)
  and `admin` (30 a minute, 300 an hour). Callers come from `guard.caller`; the guard is unchanged.
  Refusals: 429 problem+json `rate_limited`, a `[Limits]` log line and `tools_rate_limited_total`.

## 1.1.0 — 2026-09-26

Additive (roadmap WS-N task 4):

- `jobs/usage.js`: a developer project's jobs that end are counted per project, environment,
  capability (`tools.job.create`, `tools.tool.run`), job type or tool and UTC hour, in the transaction
  that records the end, and each closed hour goes to the outbox once as `tools.usage.recorded`
  (openvibe-contracts 0.63.0). Inert without an outbox, like the job events.
- `jobs/`: `submit({ traceId })` keeps the submit request's trace id in `tool_jobs.trace_id`
  (added when missing); `jobs/http.js` and `tools/run.js` pass `req.ov.traceId`. `stats().usage`,
  `usage` and `flushUsage()` on the job system.

## 1.0.0 — 2026-09-26

The first versioned release (roadmap WS-L task 3). It contains what every satellite already took from
`apps/_shared`:

- `guard/`: callers, quotas, sniffing, ffmpeg hardening, egress throttles, the abuse log;
- `egress.js`: the SSRF guard for visitor-chosen hosts and URLs;
- `jobs/`: the durable job runtime, the worker pool, Media results and lifecycle events;
- `upload.js`: `createUploads` (memory or disk);
- `usage.js`, `observe.js`, `internal-auth.js`, `host-role.js`, `binaries.js`, `graceful.js`;
- `release.js`: `toolsRelease`, which now checks the app's declared range;
- `tools/`: descriptors, local and proxied runs, deprecation.
