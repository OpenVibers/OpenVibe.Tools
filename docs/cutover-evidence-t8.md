# T8 cutover: closeout evidence — OpenVibe.Tools

What the read-only interfaces can actually prove about the Tools PostgreSQL + Valkey cutover (plan T8). The
cutover landed **2026-10-02**; production serves the PostgreSQL-only release. Checked **2026-10-04 (UTC)** through
`ov access run openvibe-ovh <action>` — `health`, `service-status`, `plan`, `releases`, `validate`, `env-set`,
`show`, `journal`. Every result below is a literal output of one of those actions.

Nothing here was deployed, restarted, rolled back or imported; no credential, URL or env **value** was read or
printed. Checks that need an interface the broker does not expose are marked **pending** in their own section and
were not guessed.

SHAs are printed as `ovhost` reports them (12 hex characters).

## Release and readiness — verified

- `health tools` (exit 0): `tools a331ea36963a ready  openvibe-tools=active openvibe-tools-maps=active
  openvibe-tools-food=active openvibe-tools-img=active openvibe-tools-yt=active openvibe-tools-audio=active
  openvibe-tools-text=active openvibe-tools-docs=active running tool jobs=0`. `ovhost` needs each service's
  `/api/ready` to answer before it calls the service `ready`.
- `service-status tools` (exit 0): the same line.
- `plan tools` (exit 0): `tools: a331ea36963a → a331ea36963a (up to date) on main`; strategy `multi-app`, `0`
  files changed, `restart no`.
- `validate tools` (exit 0): `ok checkout /opt/openvibe.tools owned by ubuntu`; `ok checkout clean at
  a331ea36963a`; all eight `openvibe-tools*` units `active/running`; `ok port 4001 held by node`; `ok deps every
  dependency resolves`; `tools: valid (0 error(s), 0 warning(s))`.
- `releases tools` (exit 0): `834bed39e5b8 → 98f8bebf73ee → a331ea36963a deployed` (2026-10-03T11:35Z,
  2026-10-04T00:24Z, 2026-10-04T03:00Z). `a331ea36963a` is origin/main HEAD and the release running in
  production; `834bed39e5b8` was the PostgreSQL-only release deployed during the cutover.

**Why this is a PostgreSQL-only release.** Every app boots through `apps/_shared/db.js`, which in production
throws `DATABASE_URL is not set: Tools serves from PostgreSQL (plan T8)` and only falls back to embedded PGlite
(PGlite outside production). A release that is `active` and `ready` therefore booted with `DATABASE_URL` set and
serves from PostgreSQL. No app depends on `better-sqlite3` any more, guarded by
`apps/_shared/test/no-sqlite.test.js`; the migrations (`migrations/0001_tools.sql` … `0004_event_outbox.sql`) run
only as the owner via `DATABASE_DIRECT_URL`, never at runtime.

## Env presence and mode — verified

- `validate tools`: `ok env /etc/openvibe/tools.env mode 600`; `ok env 4 required name(s) present and non-empty`.
- `env-set tools` (names only, `empty: []`): **`DATABASE_URL`**, **`DATABASE_DIRECT_URL`**, **`VALKEY_URL`**,
  `VALKEY_PREFIX`. `fromUnits`: `NODE_ENV`, `PATH`, `PORT`.

## Valkey ACL scope — pending

Presence of `VALKEY_URL` and `VALKEY_PREFIX` is provable (above). The scope of the Valkey user — which commands
it holds and that it is confined to `~ov:tools:*` (`/etc/valkey/services.acl`) — needs a connection to Valkey
that no read-only action opens. **Not checked.**

## Row parity / rollback copy — pending

The importer has already run and production writes PostgreSQL, but the per-table parity report and the rollback
copy (`$COPY` = `/var/backups/openvibe/tools-pre-t8-<T0>.db`, `chmod 0400`) are not exposed by any read-only
action, which runs no query and lists no file. **Not checked.**

## Reproduce

```bash
ov access run openvibe-ovh health tools
ov access run openvibe-ovh service-status tools
ov access run openvibe-ovh plan tools
ov access run openvibe-ovh releases tools
ov access run openvibe-ovh validate tools
ov access run openvibe-ovh env-set tools
ov access run openvibe-ovh journal openvibe-tools.service 200
```

Every one of these is a low-risk read. `deploy`, `rollback`, `restart` and `db-backup` were not used.
