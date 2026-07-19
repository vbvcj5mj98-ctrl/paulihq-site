CREATE TABLE IF NOT EXISTS property_valuation_cache (
  address_key TEXT PRIMARY KEY,
  formatted_address TEXT NOT NULL,
  estimated_value INTEGER NOT NULL,
  range_low INTEGER,
  range_high INTEGER,
  latitude REAL,
  longitude REAL,
  refreshed_at INTEGER NOT NULL
);
