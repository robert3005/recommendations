-- /s/posts joins the share service (spec/src/sharing.md §Share service).
-- schema.sql's widened CHECK only affects fresh databases: SQLite cannot
-- alter a CHECK constraint in place, so a deployed predecessor rebuilds the
-- documents table — data-preservingly — and swaps the replacement in.
-- Triggers attached to the old table drop with it and are recreated.
CREATE TABLE IF NOT EXISTS documents_post_kind (
  slug TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('list', 'post', 'note')),
  revision INTEGER NOT NULL,
  tokenHash TEXT NOT NULL,
  body TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (slug, kind)
);

INSERT INTO documents_post_kind (slug, kind, revision, tokenHash, body, createdAt, updatedAt, revoked)
SELECT slug, kind, revision, tokenHash, body, createdAt, updatedAt, revoked
FROM documents;

DROP TABLE documents;

ALTER TABLE documents_post_kind RENAME TO documents;

-- The rebuild dropped the revision-backup triggers with the old table —
-- restore them so version retention keeps recording every committed body.
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
