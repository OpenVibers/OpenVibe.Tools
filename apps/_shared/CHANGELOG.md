# openvibe-tools-shared (apps/_shared)

The Tools apps' shared runtime. Each app declares the range it needs as `"openvibeToolsShared"` in
its `package.json`, and refuses to boot when this checkout does not satisfy it (`version.js`). A
breaking change bumps the major and every app's range in the same commit.

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
