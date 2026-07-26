-- Migration baseline for both a fresh D1 database and the original deployed
-- share service.  Existing tables are left in place; missing auxiliary tables
-- and revision triggers are added before later migrations evolve the schema.
-- `documents` intentionally starts with the pre-post CHECK: 0003 proves and
-- performs the data-preserving transition to the current list/post/note shape.
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

-- 0002 adds/backfills the retention timestamp. Keeping the baseline at the
-- predecessor shape makes the same ordered migration set work on a fresh DB.
CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY,
  response TEXT NOT NULL,
  status INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rate (
  bucket TEXT PRIMARY KEY,
  windowStart INTEGER NOT NULL,
  count INTEGER NOT NULL
);
