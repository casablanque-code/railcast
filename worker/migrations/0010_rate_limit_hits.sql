-- Minimal rate limiting for endpoints that trigger outbound email
-- (magic link, waitlist notification) — otherwise anyone can spam a
-- victim's inbox via our domain, or burn the Resend quota, for free.
CREATE TABLE rate_limit_hits (
  bucket TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_rate_limit_bucket_time ON rate_limit_hits(bucket, created_at);
