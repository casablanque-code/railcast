-- Squashed schema for the open-source release. Replaces the old
-- 0001 (schema.sql) .. 0012 migration chain, which is why you won't find
-- files with those names anymore — this repo has no production history to
-- preserve, so there's no reason to make new clones replay 12 steps
-- (several of which added a payment/early-access gate, and later ones
-- removed it again) just to get a fresh database. If you're upgrading an
-- existing deployment that already ran the old chain, see the note in
-- README/CHANGELOG instead of applying this file — it will collide with
-- tables that already exist.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,              -- SHA-256 hash of the session cookie value, never the raw value
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE magic_links (
  token TEXT PRIMARY KEY,           -- SHA-256 hash of the emailed token, never the raw value
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE api_tokens (
  token TEXT PRIMARY KEY,           -- SHA-256 hash of the CLI bearer token, never the raw value
  id TEXT,                          -- public-facing id for listing/revoking (safe to show, not a secret)
  preview TEXT NOT NULL DEFAULT '', -- first few chars of the raw token, for the dashboard's "which token is this" UI
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE apps (
  id TEXT PRIMARY KEY,              -- server-generated opaque id (randomAppId() in index.ts) — never client-chosen
  name TEXT NOT NULL DEFAULT '',    -- human label, free text, NOT unique, never appears in a URL
  owner_email TEXT NOT NULL,
  owner_user_id TEXT REFERENCES users(id),
  signing_public_key TEXT NOT NULL,
  beta_token TEXT,                  -- required as ?token=... to read any non-stable appcast channel
  created_at INTEGER NOT NULL
);

CREATE TABLE versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id TEXT NOT NULL REFERENCES apps(id),
  channel TEXT NOT NULL DEFAULT 'stable',  -- stable | beta | anything else the publisher wants
  version TEXT NOT NULL,                    -- e.g. "1.2.0"
  build_number INTEGER NOT NULL,            -- must be strictly greater than the previous build on this channel (enforced in index.ts)
  file_key TEXT NOT NULL,                   -- R2 object key
  file_size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  signature TEXT NOT NULL,                  -- EdDSA signature, base64
  release_notes TEXT,
  critical INTEGER NOT NULL DEFAULT 0,             -- Sparkle sparkle:criticalUpdate
  phased_rollout_interval INTEGER,                 -- Sparkle sparkle:phasedRolloutInterval (seconds)
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_versions_app_channel ON versions(app_id, channel, build_number DESC);

CREATE TABLE rate_limit_hits (
  bucket TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_rate_limit_bucket_time ON rate_limit_hits(bucket, created_at);
