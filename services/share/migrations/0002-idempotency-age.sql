-- Retention migration (spec/src/sharing.md §Share service, OPERATIONS.md):
-- the deployed predecessor's idempotency table predates the age column, and
-- CREATE TABLE IF NOT EXISTS cannot add a column to an existing table.
-- SQLite also forbids the required non-constant DEFAULT in ALTER TABLE, so
-- rebuild the small internal table. Existing replay handles are preserved and
-- future rows receive the same ISO-8601 "T" timestamp as a fresh database.
CREATE TABLE idempotency_with_age (
  key TEXT PRIMARY KEY,
  response TEXT NOT NULL,
  status INTEGER NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO idempotency_with_age (key, response, status, createdAt)
SELECT key, response, status, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM idempotency;

DROP TABLE idempotency;
ALTER TABLE idempotency_with_age RENAME TO idempotency;
