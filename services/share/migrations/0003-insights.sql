-- Hosted review insights (spec/src/reviews.md §Hosted on import): one cached
-- answer per Google place, as JSON — place facts, photo links and the profile
-- learned from its reviews. Review text is never stored.
CREATE TABLE IF NOT EXISTS insights (
  source_place_key TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
