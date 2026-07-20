CREATE TABLE property_researches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  lookup_key TEXT NOT NULL,
  query_type TEXT NOT NULL CHECK(query_type IN ('address', 'apn')),
  query_text TEXT NOT NULL,
  county TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',
  result_json TEXT NOT NULL,
  starred INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  refreshed_at INTEGER NOT NULL,
  UNIQUE(owner, lookup_key)
);

CREATE INDEX property_researches_owner_time_idx ON property_researches (owner, refreshed_at DESC);
