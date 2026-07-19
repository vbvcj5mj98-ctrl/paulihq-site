CREATE TABLE IF NOT EXISTS portfolio_properties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  apn TEXT NOT NULL DEFAULT '',
  occupancy TEXT NOT NULL CHECK(occupancy IN ('rented', 'primary', 'secondary', 'vacant')),
  estimated_value INTEGER NOT NULL DEFAULT 0,
  money_owed INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  latitude REAL,
  longitude REAL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS portfolio_properties_owner_idx ON portfolio_properties (owner, updated_at);
CREATE TABLE IF NOT EXISTS portfolio_members (
  property_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (property_id, username)
);
CREATE INDEX IF NOT EXISTS portfolio_members_user_idx ON portfolio_members (username, property_id);
