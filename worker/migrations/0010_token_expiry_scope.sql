-- Token lifecycle: scope, optional expiry, and last-used tracking.
--
-- scope: 'publish' (default, preserves existing behavior for every token
-- created before this migration) can upload/publish/delete; 'read' can
-- only hit read-only endpoints (e.g. GET .../releases). This lets someone
-- issue a token to, say, a CI dashboard or a status page without handing
-- it publish rights.
--
-- expires_at: NULL means "never expires" (again, existing tokens keep
-- working exactly as before). New tokens can optionally be given a TTL at
-- creation time.
--
-- last_used_at: NULL until the token's first successful use; updated
-- opportunistically on every successful bearer auth (see
-- getBearerIdentity in index.ts) so a stolen-but-unused token is visibly
-- different from one still being used by the real CLI.
ALTER TABLE api_tokens ADD COLUMN scope TEXT NOT NULL DEFAULT 'publish';
ALTER TABLE api_tokens ADD COLUMN expires_at INTEGER;
ALTER TABLE api_tokens ADD COLUMN last_used_at INTEGER;
