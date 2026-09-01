-- api_tokens.token, sessions.id and magic_links.token were stored in
-- plaintext — the exact value used as the bearer token / cookie. A DB dump
-- would hand over every live credential with zero extra work.
--
-- Going forward (see index.ts) we store SHA-256(secret) instead of the
-- secret itself, and compare hashes on lookup. D1/SQLite has no SHA-256
-- builtin, so existing plaintext rows can't be hashed in place — and this
-- is pre-launch with only manually-granted early-access users, so the
-- simplest safe move is to invalidate everything that exists today rather
-- than leave plaintext credentials sitting in the table.
--
-- Action required after deploying: tell any existing users to log in again
-- (magic link) and regenerate their CLI API token from the dashboard.
DELETE FROM sessions;
DELETE FROM api_tokens;
DELETE FROM magic_links;

-- Non-secret preview (first 8 chars of the raw token) so the dashboard can
-- still show "a1b2c3d4…" to help users tell tokens apart, without us ever
-- storing the full secret again.
ALTER TABLE api_tokens ADD COLUMN preview TEXT NOT NULL DEFAULT '';
