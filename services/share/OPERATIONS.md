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

```sql
DELETE FROM audit WHERE at < datetime('now', '-90 days');
DELETE FROM document_revisions WHERE recordedAt < datetime('now', '-90 days');
DELETE FROM idempotency WHERE rowid IN (
  SELECT i.rowid FROM idempotency i
  -- keys embed no timestamp; prune with the audit horizon during the same job
);
```

Public CDN entries for updated or revoked documents are purged by
`Surrogate-Key` (`<kind>/<slug>`) within the service window described in
book/src/sharing.md.
