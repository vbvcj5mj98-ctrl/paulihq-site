CREATE TABLE IF NOT EXISTS user_preferences (
  username TEXT PRIMARY KEY,
  property_refresh TEXT NOT NULL DEFAULT 'weekly' CHECK(property_refresh IN ('weekly', 'daily', 'twice_daily')),
  updated_at INTEGER NOT NULL
);

ALTER TABLE property_searches ADD COLUMN last_synced_at INTEGER;
