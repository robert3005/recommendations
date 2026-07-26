# Share service — operations

Deployment notes for the hosted share service (`wrangler.toml`, `migrations/`).

## Database migrations and deployment

The ordered D1 migrations are the only production schema-upgrade path. There is
exactly one — the baseline — because the service has never been deployed:
`wrangler.toml` still carries `REPLACE_WITH_REAL_ID`, so no database exists that
predates the current schema. Migrations that upgrade a live predecessor start
being written the day one exists.

From `services/share`:

```sh
pnpm db:migrate:local   # local D1 used during development
pnpm db:migrate:remote  # production D1
pnpm deploy             # runs the remote migration first via predeploy
```

Replace `REPLACE_WITH_REAL_ID` in `wrangler.toml` before a remote operation.
Once the service is live, back up the production D1 database before applying any
migration and verify the command reports it applied before deploying the Worker.

`schema.sql` is the current-schema reference/snapshot only. Do **not** execute it
as an upgrade once a deployment exists: `CREATE TABLE IF NOT EXISTS` cannot
replace an existing table's CHECK constraint.

## Internal data retention

Internal audit entries and `document_revisions` version backups are retained
for **90 days** and then purged (a scheduled job deletes rows whose
`at`/`recordedAt` is older than 90 days). These stores are never publicly
addressable: public reads serve only the current `documents` row, and revoked
slugs serve nothing.

Rows in `idempotency` are replay handles for client retries; they follow the
same 90-day purge. `rate` rows are transient fixed-window counters and may be
purged at any time past their window.

## Purge SQL (scheduled)

The purge is executable, not prose: `wrangler.toml` schedules a daily cron and
the Worker's `scheduled` handler (`src/worker.ts`, `purgeExpiredInternalData`)
runs exactly these statements:

```sql
DELETE FROM audit WHERE at < datetime('now', '-90 days');
DELETE FROM document_revisions WHERE recordedAt < datetime('now', '-90 days');
DELETE FROM idempotency WHERE createdAt < datetime('now', '-90 days');
```

Public CDN entries for updated or revoked documents are purged by
`Surrogate-Key` (`<kind>/<slug>`) within the service window described in
spec/src/sharing.md.
