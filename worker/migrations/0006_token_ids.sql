ALTER TABLE api_tokens ADD COLUMN id TEXT;
UPDATE api_tokens SET id = lower(hex(randomblob(16))) WHERE id IS NULL;
CREATE UNIQUE INDEX idx_api_tokens_id ON api_tokens(id);
