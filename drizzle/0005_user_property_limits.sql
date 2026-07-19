CREATE TABLE IF NOT EXISTS user_property_limits (
  username TEXT PRIMARY KEY,
  monthly_limit INTEGER NOT NULL CHECK(monthly_limit >= 0 AND monthly_limit <= 50),
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_property_usage (
  username TEXT NOT NULL,
  period TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (username, period)
);
