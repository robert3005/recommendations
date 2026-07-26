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
