# Share service — operations

Deployment notes for the hosted share service (`wrangler.toml`, `migrations/`).

## Database migrations and deployment

The ordered D1 migrations are the only production schema-upgrade path. There
are three — the baseline, `0002-sync.sql`, which adds the sync tables, and
`0003-insights.sql`, which adds the review-insights cache — and no
upgrade of a live predecessor yet, because the first deployment (a test one, 2026-11-23) was created with both
already written, so no database exists that predates the current schema. Migrations that upgrade a live predecessor start
being written the day one exists.

From `services/share`:

```sh
pnpm db:migrate:local   # local D1 used during development
pnpm db:migrate:remote  # production D1
pnpm deploy             # runs the remote migration first via predeploy
```

A test deployment exists since 2026-11-23:
`https://placemarks-share.together-in-girona.workers.dev`, on the D1 database
whose id is in `wrangler.toml`. Both migrations are applied to it.

Deploy with `pnpm deploy`, not a bare `wrangler deploy`: only the pnpm script
runs the remote migration first. A Worker deployed ahead of its migrations
answers 500 on every route that touches a table.
Once the service is live, back up the production D1 database before applying any
migration and verify the command reports it applied before deploying the Worker.

`schema.sql` is the current-schema reference/snapshot only. Do **not** execute it
as an upgrade once a deployment exists: `CREATE TABLE IF NOT EXISTS` cannot
replace an existing table's CHECK constraint.

## Review insights

`POST /i/places` reads a Google place's reviews and returns what was learned
(spec/src/reviews.md §Hosted on import). It needs three secrets and answers
501 until all are set:

```sh
cd services/share
# A random access key; paste the same value in the app under Settings → Review insights.
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=' | tee /dev/stderr | pnpm exec wrangler secret put INSIGHTS_ACCESS_KEY
pnpm exec wrangler secret put SERPAPI_KEY < ~/.config/placemarks/serpapi-key
pnpm exec wrangler secret put ANTHROPIC_API_KEY   # paste the key when asked
```

Plain settings in `wrangler.toml` under `[vars]`: `INSIGHTS_DAILY_PLACES`
(places fetched per rolling day, 100) and `INSIGHTS_MAX_REVIEWS` (reviews read
per place, 50, about four SerpApi credits). A cached answer costs nothing.

Rotating the access key: put a new secret and paste it in the app again. Every
browser holding the old key stops at its next lookup with "access key is wrong".

The `insights` table (migration `0003-insights.sql`) holds one row per Google
place: place facts, photo links and the profile as JSON. It never holds review
text. Rows may be deleted at any time; the next lookup refetches.

## Data retention

There are two tables and no internal logs (spec/src/sharing.md §The share
service). `documents` rows persist indefinitely: a live row is the published
page, and a revoked row is a tombstone that reserves its slug forever — deleting
one would let an old link come to mean someone else's content. A tombstone
retains no document body, only the slug and token hash.

`rate` rows are transient fixed-window counters and may be purged at any time
past their `reset_at`.

Sync (spec/src/sync.md) adds `libraries` and `sync_rows`, created by migration
`0002-sync.sql`. A library row is the hash of a bearer token and a sequence
counter; a sync row is an opaque key and a ciphertext the service cannot read.
Both persist until the owner deletes the synced copy from the app (`DELETE
/y/:library`). There is no account to contact and no way to recover a library
for someone who lost its key, and nothing in these tables identifies a person.
An abandoned library can only be recognised by its rows no longer being
written; any purge of old libraries is an operator policy to announce before
it is applied, not something the service does on its own.

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
