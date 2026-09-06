-- DEFAULT 1 so existing rows (all created via magic link, which already
-- proves inbox ownership by definition) are treated as verified. Brand-new
-- password sign-ups explicitly insert 0 and only flip to 1 once they click
-- the confirmation link.
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1;

CREATE TABLE email_verifications (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
