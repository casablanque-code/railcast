import { env } from "cloudflare:test";

// Mirrors schema.sql + migrations/0002_users_and_tokens.sql +
// migrations/0003_sessions.sql. Kept inline (rather than reading the .sql
// files from disk) because the pool runs this inside the workerd sandbox,
// which has no filesystem access — if you add a migration, mirror it here too.
const DDL = [
  `CREATE TABLE apps (id TEXT PRIMARY KEY, owner_email TEXT NOT NULL, signing_public_key TEXT NOT NULL, created_at INTEGER NOT NULL, owner_user_id TEXT REFERENCES users(id));`,
  `CREATE TABLE versions (id INTEGER PRIMARY KEY AUTOINCREMENT, app_id TEXT NOT NULL REFERENCES apps(id), channel TEXT NOT NULL DEFAULT 'stable', version TEXT NOT NULL, build_number INTEGER NOT NULL, file_key TEXT NOT NULL, file_size INTEGER NOT NULL, sha256 TEXT NOT NULL, signature TEXT NOT NULL, release_notes TEXT, created_at INTEGER NOT NULL);`,
  `CREATE INDEX idx_versions_app_channel ON versions(app_id, channel, build_number DESC);`,
  `CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL, access_granted INTEGER NOT NULL DEFAULT 0);`,
  `CREATE TABLE magic_links (token TEXT PRIMARY KEY, email TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);`,
  `CREATE TABLE api_tokens (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL, id TEXT);`,
  `CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);`,
  `CREATE TABLE waitlist (id TEXT PRIMARY KEY, email TEXT NOT NULL, created_at INTEGER NOT NULL);`,
].join("\n");

await env.DB.exec(DDL);
