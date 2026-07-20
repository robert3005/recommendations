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

CREATE TABLE IF NOT EXISTS changes (
  account_id TEXT NOT NULL REFERENCES accounts (id),
  -- Server-monotonic per account; the pull cursor.
  seq BIGINT NOT NULL,
  mutation_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  hlc TEXT NOT NULL,
  row JSONB NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (account_id, seq),
  -- Push idempotency: one accepted record per mutation id.
  UNIQUE (account_id, mutation_id)
);
CREATE INDEX IF NOT EXISTS changes_entity ON changes (account_id, table_name, entity_id);

CREATE TABLE IF NOT EXISTS rate (
  bucket TEXT PRIMARY KEY,
  window_start BIGINT NOT NULL,
  count INTEGER NOT NULL
);
