import { env, fetchMock } from "cloudflare:test";

// Auth handlers call out to Resend to send magic-link/verification emails.
// The pool runs the worker with a real (fake) RESEND_API_KEY, and without
// this it would make a genuine network request to api.resend.com on every
// test that registers a user or requests a magic link -- which 401s in CI
// (no real key) and would also just be slow/flaky/order-dependent even
// with a real one. Intercept it once for the whole file instead.
fetchMock.activate();
fetchMock.disableNetConnect();
fetchMock
  .get("https://api.resend.com")
  .intercept({ method: "POST", path: "/emails" })
  .reply(200, JSON.stringify({ id: "test-email-id" }))
  .persist();

// Mirrors migrations/0001_initial.sql. Kept inline (rather than reading the
// .sql file from disk) because the pool runs this inside the workerd
// sandbox, which has no filesystem access — if you change the schema,
// mirror it here too.
const DDL = [
  `CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT, email_verified INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);`,
  `CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);`,
  `CREATE TABLE magic_links (token TEXT PRIMARY KEY, email TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);`,
  `CREATE TABLE email_verifications (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);`,
  `CREATE TABLE api_tokens (token TEXT PRIMARY KEY, id TEXT, preview TEXT NOT NULL DEFAULT '', user_id TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL);`,
  `CREATE TABLE apps (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', owner_email TEXT NOT NULL, owner_user_id TEXT REFERENCES users(id), signing_public_key TEXT NOT NULL, beta_token TEXT, created_at INTEGER NOT NULL);`,
  `CREATE TABLE versions (id INTEGER PRIMARY KEY AUTOINCREMENT, app_id TEXT NOT NULL REFERENCES apps(id), channel TEXT NOT NULL DEFAULT 'stable', version TEXT NOT NULL, build_number INTEGER NOT NULL, file_key TEXT NOT NULL, file_size INTEGER NOT NULL, sha256 TEXT NOT NULL, signature TEXT NOT NULL, release_notes TEXT, critical INTEGER NOT NULL DEFAULT 0, phased_rollout_interval INTEGER, created_at INTEGER NOT NULL);`,
  `CREATE INDEX idx_versions_app_channel ON versions(app_id, channel, build_number DESC);`,
  `CREATE TABLE rate_limit_hits (bucket TEXT NOT NULL, created_at INTEGER NOT NULL);`,
  `CREATE INDEX idx_rate_limit_bucket_time ON rate_limit_hits(bucket, created_at);`,
].join("\n");

await env.DB.exec(DDL);

// api_tokens.token and sessions.id are now stored as SHA-256 hashes of the
// raw secret (see index.ts) — tests need to insert hashes the same way the
// worker looks them up, while still sending the *raw* value as the
// Authorization header / Cookie in requests.
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

