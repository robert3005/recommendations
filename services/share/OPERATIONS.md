# Share service — operations

Deployment notes for the hosted share service (`wrangler.toml`, `migrations/`).

## Database migrations and deployment

The ordered D1 migrations are the only production schema-upgrade path. The
baseline deliberately describes the original list/note deployment; subsequent
migrations add retention timestamps and rebuild `documents` to accept posts.
That makes one sequence work for a fresh database and for the deployed
predecessor without losing documents or revision history.

From `services/share`:

```sh
pnpm db:migrate:local   # local D1 used during development
pnpm db:migrate:remote  # production D1
pnpm deploy             # runs the remote migration first via predeploy
```

Replace `REPLACE_WITH_REAL_ID` in `wrangler.toml` before a remote operation.
Back up the production D1 database before applying migrations, and verify that
the migration command reports 0001, 0002, and 0003 applied before deploying the
Worker.

`schema.sql` is the current-schema reference/snapshot only. Do **not** execute it
as an upgrade: `CREATE TABLE IF NOT EXISTS` cannot replace the predecessor's
`documents.kind` CHECK constraint, and mixing the snapshot with the ordered
migrations can make an already-present column collide with 0002.

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
