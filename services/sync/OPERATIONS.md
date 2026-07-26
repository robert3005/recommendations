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

- **Database**: Postgres; apply the idempotent `schema.sql` before first start
  and again on each deployment so additive tables such as `account_cursors`
  exist before new code serves traffic. `Pool` satisfies the adapter's
  `PgLike` interface directly. No PostGIS required.
- **Mailer**: the login flow needs an email sender (`Mailer.send(email, code)`).
  Codes are 6 digits, single-use, 15-minute TTL, stored hashed.
- **TLS is mandatory** — bearer tokens cross only HTTPS.

## Protocol invariants (enforced by the app; verified by `src/*.test.ts`)

- Accounts do nothing but name the sync scope; completing a login mints a new
  per-device bearer, and the server stores only its SHA-256 hash (constant-time
  comparison). `POST /sync/logout` revokes only the calling device's bearer;
  `POST /sync/logout/others` retains the caller and revokes every other bearer
  for recovery from a lost device or copied token.
- `POST /sync/push` is idempotent by mutation id: a re-sent batch re-acks
  without duplicating change records.
- `GET /sync/pull` is a server-monotonic cursor over the per-account
  append-only change log; the client hands the cursor back verbatim and keeps
  paging until an empty response confirms it reached the tail.
- Login bodies are capped at 4 KiB; push requests and pull responses are each
  capped at 2 MiB measured as encoded UTF-8 bytes. The request reader enforces
  its limits while streaming, before retaining or parsing attacker input.
- Every new mutation carries a bounded per-entity version vector. Clients use
  it to distinguish a causal successor from a genuinely concurrent edit; HLC
  provides only the deterministic winner for a concurrent frontier.
- Accounts are isolated: a bearer only ever reads and writes its own log.
- Browser tabs serialize login, logout, and sync through a per-database Web
  Lock when that API is available; transaction-level scope checks remain the
  correctness backstop where it is unavailable.

## Retention

- The change log is append-only. Tombstoned rows (`row.deleted = true`) remain
  in the log so every device observes the deletion.
- Same-entity age-based compaction is currently **disabled**. A later row can
  be concurrent with an earlier one, so deleting merely because `seq` is
  greater can erase an unresolved note body. A future vector-aware compactor
  may remove an old record only when a retained record's version vector
  causally dominates it; it must preserve every incomparable frontier record
  and the newest tombstone. Until that exists, retain the complete append log.

- Login codes expire after 15 minutes and are single-use; expired rows may be
  purged at any time.

## Observability

- Log request counts and failure rates per route; never log bearer tokens,
  login codes, or row payloads (they contain private notes and coordinates —
  the client-side redaction rules in spec/src/roadmap.md apply server-side
  too).
