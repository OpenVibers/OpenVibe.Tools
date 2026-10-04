# Cutover runbook — Tools job usage readings to OpenVibe.Billing (plan T5 step 7)

This PR adds one empty table, `tool_job_billing_readings`, and the code that fills it: every tool job that
succeeds or fails stores one `platform.usage-sample@1` reading in the transaction that records its end, and
the jobs tick posts the unsent ones to OpenVibe.Billing `POST /api/v1/usage`. It also bumps
`openvibe-contracts` from v0.79.0 to v0.92.0 in the img, audio, docs and gateway apps. Nothing existing is
renamed, dropped, altered or backfilled; the hourly `tools.usage.recorded` rollups (`tool_job_usage`) are
unchanged. No money moves here: Billing stores the readings and rates them in its own sweep.

## What the migration does

`migrations/0005_billing_readings.sql` (`phase: expand`) creates the new table and two partial indexes:

```sql
CREATE TABLE IF NOT EXISTS tool_job_billing_readings (
    job_id text PRIMARY KEY, app text NOT NULL DEFAULT '', reading jsonb NOT NULL,
    created_at bigint NOT NULL, sent_at bigint, attempts integer NOT NULL DEFAULT 0, last_error text
);
CREATE INDEX IF NOT EXISTS tool_job_billing_readings_unsent ON tool_job_billing_readings (app, attempts, created_at) WHERE sent_at IS NULL;
CREATE INDEX IF NOT EXISTS tool_job_billing_readings_sent ON tool_job_billing_readings (sent_at) WHERE sent_at IS NOT NULL;
```

The runner is `openvibe-sdk/db`'s `migrate()`, started by `apps/_shared/db.js` as the owner
(`DATABASE_DIRECT_URL`) when the first app of the new release boots: it locks `ov_migrations`, runs the file
in one transaction, records id `0005` with its checksum, and refuses a later edit of it. The other apps of the
release wait on the same lock and find it applied.

## Order

1. **Backup.** Take the logical dump of the `tools` database before the deploy (the pre-merge rule for any
   data change, even an additive one): `sudo ovhost backup --all --logical`. Note the stamp it prints; the
   way back uses it.
2. **Merge and deploy** through the pipeline (`ovhost deploy tools`, `--wait-idle` is not needed: no job
   state changes shape). The first app to boot applies `0005`.
3. **Leave `OV_BILLING_URL` unset at first.** With it unset the code is inert: nothing is stored in the new
   table, nothing is posted, the rollups and job events behave as before.
4. **Network grant** (OpenVibe.Network, its own PR): the `tools` client needs
   `billing.usage.record` on audience `openvibe.billing`. Without it every token request for that audience is
   refused, each post is logged as `[Billing] reading tools:job:<id> not sent: token: 400 invalid_scope`, the tick
   stops after that first reading, and the readings wait in the table (no job is affected).
5. **Turn it on** once the grant is live: add `OV_BILLING_URL` (Billing's internal URL) and, only if it
   differs, `OV_BILLING_AUDIENCE` to `/etc/openvibe/tools.env`, then restart through `ovhost deploy tools
   --restart`.

## Verification

- `ov access run openvibe-ovh health tools` (or `/api/ready` on each app) answers 200 after the deploy.
- The migration is recorded: `SELECT id, name, phase FROM ov_migrations WHERE id = '0005'` returns
  `0005 | billing_readings | expand`, and `SELECT COUNT(*) FROM tool_job_billing_readings` is 0 while
  `OV_BILLING_URL` is unset.
- After step 5: `GET /api/health` on img, audio or docs shows `jobs.billing` with `pending` going back to 0
  after a tick (5 minutes) and `posted` growing; `refused` with a `last_error` of `token: 400 invalid_scope` means the grant is
  missing. `SELECT COUNT(*) FROM tool_job_billing_readings WHERE sent_at IS NULL` stays small.
- In Billing: `GET /api/v1/usage?service=openvibe.tools` (`billing.ledger.admin`) lists the readings, one per
  ended job, `idempotency_key` `tools:job:<job id>`.

```rehearse
# 0005 is additive (one new table, no backfill): it must exist, empty, with its two indexes, next to the
# untouched tool_jobs, tool_job_usage and event_outbox.
node -e 'const a=require("assert");const {dep}=require("./apps/_shared/test/deps");const db=dep("openvibe-sdk/db").createDb({url:process.env.DATABASE_DIRECT_URL,service:"rehearsal",max:1});(async()=>{const c=await db.prepare("SELECT column_name AS c FROM information_schema.columns WHERE table_name = ? ORDER BY ordinal_position").all("tool_job_billing_readings");a.deepStrictEqual(c.map(r=>r.c),["job_id","app","reading","created_at","sent_at","attempts","last_error"]);a.strictEqual(Number((await db.prepare("SELECT COUNT(*) AS n FROM tool_job_billing_readings").get()).n),0);const i=await db.prepare("SELECT indexname AS i FROM pg_indexes WHERE tablename = ? ORDER BY indexname").all("tool_job_billing_readings");a.deepStrictEqual(i.map(r=>r.i),["tool_job_billing_readings_pkey","tool_job_billing_readings_sent","tool_job_billing_readings_unsent"]);for(const t of ["tool_jobs","tool_job_usage","event_outbox"])a.ok(await db.prepare("SELECT to_regclass(?) AS r").get(t).then(r=>r.r),t);console.log("0005: tool_job_billing_readings created empty with its two indexes; tool_jobs, tool_job_usage and event_outbox untouched")})().finally(()=>db.close()).catch((e)=>{console.error(e);process.exitCode=1})'
```

## Rollback

- **Code only** (the usual way back): `ovhost rollback tools` (or `deploy/scripts/deploy.sh --rollback`). The
  previous release does not know the table and ignores it; the migration stays applied, which the previous
  release's runner accepts (an applied id it does not have is not an error). Unsent readings stay in the table
  and are posted when the release comes back (Billing dedupes on `idempotency_key`).
- **Stop posting without a rollback:** remove `OV_BILLING_URL` from `/etc/openvibe/tools.env` and restart.
- **Remove the table** (only if it must go; a contract step, by hand as the owner, after a code rollback):
  `DROP TABLE tool_job_billing_readings; DELETE FROM ov_migrations WHERE id = '0005';`. Readings not yet posted
  are lost with it; Billing keeps the ones it stored.
- **Restore:** the dump from step 1 restores the database as it was before the deploy (`pg_restore` per
  OpenVibe.Host `docs/backups.md`); not needed for this additive change unless the database itself is damaged.
