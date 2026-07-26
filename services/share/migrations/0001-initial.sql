-- Baseline schema for a fresh D1 database. The service has never been
-- deployed (wrangler.toml still carries REPLACE_WITH_REAL_ID), so there is no
-- predecessor to upgrade; migrations that evolve a live database start being
-- written the day one exists.
-- Share-service D1 schema (spec/src/sharing.md §The share service).
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
