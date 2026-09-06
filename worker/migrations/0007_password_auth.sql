-- Nullable: existing magic-link-only users have no password until they set
-- one (via /auth/register on an already-registered email).
ALTER TABLE users ADD COLUMN password_hash TEXT;
