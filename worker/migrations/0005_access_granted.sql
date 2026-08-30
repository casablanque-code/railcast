-- Until a payment processor is wired up, access is granted by hand
-- (UPDATE users SET access_granted = 1 WHERE email = '...'). Defaults to 0
-- so every new signup is gated until explicitly let in. When billing exists,
-- only what *sets* this flips (a webhook instead of a manual UPDATE) — the
-- check at the call site (handleApiCreateApp) doesn't need to change.
ALTER TABLE users ADD COLUMN access_granted INTEGER NOT NULL DEFAULT 0;
