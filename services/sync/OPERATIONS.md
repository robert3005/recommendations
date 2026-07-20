# Sync service — deployment & operations

The sync service (spec/src/storage-sync.md §Multi-device sync) moves private
owned entities between one owner's devices. It is independent of the share
service; public links never depend on it, and solo account-free use of the app
is unaffected when it is absent.

## Deployment shape

- **Runtime**: the Hono app from `createSyncApp` runs on any Node host
  (Fly.io/render/container). Wire it with node-postgres:

  ```ts
  import { serve } from "@hono/node-server";
  import { Pool } from "pg";
  import { createSyncApp, PgSyncStorage } from "@placemarks/sync-service";

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const app = createSyncApp({
    storage: new PgSyncStorage(pool),
    mailer: smtpMailer(process.env.SMTP_URL), // any Mailer implementation
  });
  serve({ fetch: app.fetch, port: 8788 });
  ```

- **Database**: Postgres; apply `schema.sql` before first start. `Pool`
  satisfies the adapter's `PgLike` interface directly. No PostGIS required.
- **Mailer**: the login flow needs an email sender (`Mailer.send(email, code)`).
  Codes are 6 digits, single-use, 15-minute TTL, stored hashed.
- **TLS is mandatory** — bearer tokens cross only HTTPS.

## Protocol invariants (enforced by the app; verified by `src/*.test.ts`)

- Accounts do nothing but name the sync scope; completing a login rotates the
  bearer token, and the server stores only its SHA-256 hash (constant-time
  comparison).
- `POST /sync/push` is idempotent by mutation id: a re-sent batch re-acks
  without duplicating change records.
- `GET /sync/pull` is a server-monotonic cursor over the per-account
  append-only change log; the client hands the cursor back verbatim.
- Accounts are isolated: a bearer only ever reads and writes its own log.

## Retention

- The change log is append-only. Tombstoned rows (`row.deleted = true`) remain
  in the log so every device observes the deletion.
- **Retention horizon: 365 days.** Rows older than the horizon whose entity
  has a newer change record may be compacted (delete the older records for
  the same `(account_id, table_name, entity_id)`); the newest record per
  entity is never removed, so a device syncing after a long absence still
  converges from the latest state per row. Run the compaction as a scheduled
  job:

  ```sql
  DELETE FROM changes c
  USING changes newer
  WHERE c.account_id = newer.account_id
    AND c.table_name = newer.table_name
    AND c.entity_id = newer.entity_id
    AND newer.seq > c.seq
    AND c.recorded_at < to_char(now() - interval '365 days', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  ```

- Login codes expire after 15 minutes and are single-use; expired rows may be
  purged at any time.

## Observability

- Log request counts and failure rates per route; never log bearer tokens,
  login codes, or row payloads (they contain private notes and coordinates —
  the client-side redaction rules in spec/src/roadmap.md apply server-side
  too).
