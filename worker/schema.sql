CREATE TABLE apps (
  id TEXT PRIMARY KEY,          -- короткий slug, напр. "myapp"
  owner_email TEXT NOT NULL,
  signing_public_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id TEXT NOT NULL REFERENCES apps(id),
  channel TEXT NOT NULL DEFAULT 'stable',   -- stable | beta
  version TEXT NOT NULL,                     -- "1.2.0"
  build_number INTEGER NOT NULL,
  file_key TEXT NOT NULL,                    -- ключ объекта в R2
  file_size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  signature TEXT NOT NULL,                   -- EdDSA подпись
  release_notes TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_versions_app_channel ON versions(app_id, channel, build_number DESC);
