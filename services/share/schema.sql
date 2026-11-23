-- Share-service D1 schema snapshot (spec/src/sharing.md §The share service).
-- Two tables, nothing else: published documents (tombstoned in place, never
-- reassigned) and fixed-window rate counters. Production and fresh databases
-- use the ordered migrations/ workflow; this file is a reference, not an
-- upgrade command.
CREATE TABLE IF NOT EXISTS documents (
  kind TEXT NOT NULL CHECK (kind IN ('list', 'post')),
  slug TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  body TEXT NOT NULL,
  revoked_at TEXT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, slug)
);

-- Transient fixed-window counters; rows past reset_at may be purged any time.
CREATE TABLE IF NOT EXISTS rate (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at TEXT NOT NULL
);

-- Sync (spec/src/sync.md §The service): libraries claimed by a token hash,
-- holding opaque encrypted rows ordered by a per-library sequence number.
CREATE TABLE IF NOT EXISTS libraries (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sync_rows (
  library_id TEXT NOT NULL,
  k TEXT NOT NULL,
  c TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (library_id, k)
);

CREATE INDEX IF NOT EXISTS sync_rows_by_seq ON sync_rows (library_id, seq);
