-- Per-app API tokens. Before this, any token belonging to an account could
-- publish to every app that account owns, so a single leaked CLI token was
-- effectively account-wide. app_id lets a token be scoped to exactly one
-- app instead.
--
-- NULL means an old-style, account-wide token — kept for backward
-- compatibility with tokens issued before this migration, which nobody
-- should be forced to regenerate. New tokens are encouraged (not required)
-- to pick a specific app_id at creation time; see handleApiCreateToken.
ALTER TABLE api_tokens ADD COLUMN app_id TEXT REFERENCES apps(id);
