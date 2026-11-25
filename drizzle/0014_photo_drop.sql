CREATE TABLE IF NOT EXISTS photo_drop_uploads (
  id TEXT PRIMARY KEY NOT NULL,
  owner TEXT NOT NULL CHECK (owner IN ('carsonpauli', 'jessipauli')),
  client_id TEXT NOT NULL,
  cipher_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staging', 'queued', 'on_pc', 'backed_up', 'expired')),
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  object_deleted_at INTEGER,
  UNIQUE(owner, client_id)
);

CREATE INDEX IF NOT EXISTS photo_drop_owner_created_idx ON photo_drop_uploads (owner, created_at DESC);
CREATE INDEX IF NOT EXISTS photo_drop_status_expiry_idx ON photo_drop_uploads (status, expires_at);
