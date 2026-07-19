-- Share-service D1 schema (spec/src/sharing.md §Share service).
CREATE TABLE IF NOT EXISTS documents (
  slug TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('list', 'note')),
  revision INTEGER NOT NULL,
  tokenHash TEXT NOT NULL,
  body TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (slug, kind)
);

-- Append-only internal version backups: every committed body revision is
-- retained per (kind, slug, revision), populated by triggers so the adapter's
-- transactional batches stay minimal. Never publicly addressable.
CREATE TABLE IF NOT EXISTS document_revisions (
  slug TEXT NOT NULL,
  kind TEXT NOT NULL,
  revision INTEGER NOT NULL,
  body TEXT NOT NULL,
  recordedAt TEXT NOT NULL,
  PRIMARY KEY (kind, slug, revision)
);

CREATE TRIGGER IF NOT EXISTS documents_revision_on_insert
AFTER INSERT ON documents
BEGIN
  INSERT OR IGNORE INTO document_revisions (slug, kind, revision, body, recordedAt)
  VALUES (NEW.slug, NEW.kind, NEW.revision, NEW.body, NEW.updatedAt);
END;

CREATE TRIGGER IF NOT EXISTS documents_revision_on_update
AFTER UPDATE OF revision ON documents
WHEN NEW.revoked = 0
BEGIN
  INSERT OR IGNORE INTO document_revisions (slug, kind, revision, body, recordedAt)
  VALUES (NEW.slug, NEW.kind, NEW.revision, NEW.body, NEW.updatedAt);
END;

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  slug TEXT NOT NULL,
  kind TEXT NOT NULL,
  action TEXT NOT NULL,
  revision INTEGER
);

CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY,
  response TEXT NOT NULL,
  status INTEGER NOT NULL,
  -- Age column for the scheduled 90-day purge (OPERATIONS.md).
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rate (
  bucket TEXT PRIMARY KEY,
  windowStart INTEGER NOT NULL,
  count INTEGER NOT NULL
);
