-- Share-service D1 schema (book/src/sharing.md §Share service).
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
  status INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rate (
  bucket TEXT PRIMARY KEY,
  windowStart INTEGER NOT NULL,
  count INTEGER NOT NULL
);
