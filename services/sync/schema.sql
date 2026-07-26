-- Sync-service Postgres schema (spec/src/storage-sync.md §Multi-device sync,
-- spec/src/tech-stack.md §Sync backend). Accounts exist only to name a sync
-- scope; the change log is append-only with a per-account monotonic sequence.
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

-- One bearer per DEVICE login; several devices sync one scope concurrently.
-- SHA-256 hex of the bearer token; the token itself is never stored.
CREATE TABLE IF NOT EXISTS account_tokens (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS login_codes (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Atomic per-account cursor allocation. The UPSERT row lock serializes
-- concurrent pushes without a racy MAX(seq)+1 read.
CREATE TABLE IF NOT EXISTS account_cursors (
  account_id TEXT PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  last_seq BIGINT NOT NULL CHECK (last_seq >= 0)
);

CREATE TABLE IF NOT EXISTS changes (
  account_id TEXT NOT NULL REFERENCES accounts (id),
  -- Server-monotonic per account; the pull cursor.
  seq BIGINT NOT NULL,
  mutation_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  hlc TEXT NOT NULL,
  -- Bounded client-authored causal context; HLC remains the total-order tie-breaker.
  version JSONB NOT NULL DEFAULT '{}'::jsonb,
  row JSONB NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (account_id, seq),
  -- Push idempotency: one accepted record per mutation id.
  UNIQUE (account_id, mutation_id)
);
-- Safe additive upgrade for deployments created before causal vectors shipped.
ALTER TABLE changes ADD COLUMN IF NOT EXISTS version JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS changes_entity ON changes (account_id, table_name, entity_id);

-- Backfill/advance counters when this schema is applied to a deployment that
-- already has an append log from the pre-counter implementation.
INSERT INTO account_cursors (account_id, last_seq)
SELECT account_id, MAX(seq) FROM changes GROUP BY account_id
ON CONFLICT (account_id) DO UPDATE
SET last_seq = GREATEST(account_cursors.last_seq, EXCLUDED.last_seq);

CREATE TABLE IF NOT EXISTS rate (
  bucket TEXT PRIMARY KEY,
  window_start BIGINT NOT NULL,
  count INTEGER NOT NULL
);
