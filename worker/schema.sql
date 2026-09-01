-- NOTE: this file is the base schema for a brand-new database. An existing
-- deployment should NOT re-run this — apply the numbered files in
-- migrations/ instead (0001 covered the original version of this file;
-- 0007-0010 are the security fixes described in README/PR notes).

CREATE TABLE apps (
  id TEXT PRIMARY KEY,          -- server-generated opaque id, e.g. "aZ3kQ9mN2pRt" (see randomAppId in index.ts)
  name TEXT NOT NULL DEFAULT '', -- human label, free text, NOT unique, never used in a URL
  owner_email TEXT NOT NULL,
  signing_public_key TEXT NOT NULL,
  beta_token TEXT,               -- required as ?token=... to read any non-stable channel
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
