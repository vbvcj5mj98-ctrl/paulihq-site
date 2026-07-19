CREATE TABLE IF NOT EXISTS property_favorites (
  username TEXT NOT NULL,
  source_id TEXT NOT NULL,
  search_id INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('primary', 'income')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (username, source_id, search_id)
);

CREATE INDEX IF NOT EXISTS property_favorites_user_mode_idx
  ON property_favorites (username, mode, created_at);
