-- Sync (spec/src/sync.md §The service): a library is claimed by the hash of
-- the bearer token its key derives, and holds opaque rows — a device-derived
-- key and a ciphertext. `seq` orders every write within a library so a device
-- can ask for everything after the last number it saw.
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
