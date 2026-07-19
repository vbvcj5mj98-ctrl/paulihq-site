CREATE TABLE IF NOT EXISTS user_page_permissions (
  username TEXT NOT NULL,
  page_key TEXT NOT NULL CHECK(page_key IN ('assistant', 'lists', 'properties', 'user_management')),
  allowed INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (username, page_key)
);
