-- Retention migration (spec/src/sharing.md §Share service, OPERATIONS.md):
-- the deployed predecessor's idempotency table predates the age column, and
-- CREATE TABLE IF NOT EXISTS cannot add a column to an existing table.
-- SQLite forbids a non-constant DEFAULT in ALTER TABLE, so the column arrives
-- with a constant default and is backfilled in ISO-8601 "T" format — the same
-- text shape the purge cutoff uses, so comparisons stay chronological.
ALTER TABLE idempotency ADD COLUMN createdAt TEXT NOT NULL DEFAULT '';
UPDATE idempotency
SET createdAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE createdAt = '';
