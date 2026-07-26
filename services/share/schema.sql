-- Share-service D1 schema snapshot (spec/src/sharing.md §Share service).
-- Production and fresh databases use the ordered migrations/ workflow; this
-- file is a reference, not an upgrade command.
CREATE TABLE IF NOT EXISTS documents (
  slug TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('list', 'post')),
  revision INTEGER NOT NULL,
  tokenHash TEXT NOT NULL,
  body TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (slug, kind)
);

-- Replay handles for retried publish/revoke jobs. Written AFTER the mutation
-- they acknowledge: an interrupted write simply re-executes, and recovery runs
-- through slug ownership and stored-body comparison, which carry the weight.
CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY,
  response TEXT NOT NULL,
  status INTEGER NOT NULL,
  -- ISO-8601 "T" so TEXT comparison against a purge cutoff is chronological.
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS rate (
  bucket TEXT PRIMARY KEY,
  windowStart INTEGER NOT NULL,
  count INTEGER NOT NULL
);
