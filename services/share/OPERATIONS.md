# Share service — operations

Deployment notes for the hosted share service (`wrangler.toml`, `schema.sql`).

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
book/src/sharing.md.
