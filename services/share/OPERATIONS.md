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

## Data retention

There are two tables and no internal logs (spec/src/sharing.md §The share
service). `documents` rows persist indefinitely: a live row is the published
page, and a revoked row is a tombstone that reserves its slug forever — deleting
one would let an old link come to mean someone else's content. A tombstone
retains no document body, only the slug and token hash.

`rate` rows are transient fixed-window counters and may be purged at any time
past their `reset_at`.

## Cache lifecycle

Public GETs carry `ETag` and `Cache-Control: public, s-maxage=60`. On a
successful update or revoke the Worker best-effort purges that single URL from
the default edge cache; the 60-second shared lifetime bounds whatever a purge
misses.

## Abuse and takedown

The operator-mediated takedown contact (spec/src/sharing.md) is the recourse
for abusive content — and for owners who lost their editor token, since a lost
token permanently orphans its publication. Takedown is a manual
`UPDATE documents SET revoked_at = <now>, body = '' WHERE kind = <kind> AND
slug = <slug> AND revoked_at IS NULL` — the same tombstone an owner's DELETE
produces.
