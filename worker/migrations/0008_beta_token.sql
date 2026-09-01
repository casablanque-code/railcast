-- Non-stable channels (e.g. "beta") were served from the same public,
-- unauthenticated /{id}/appcast.xml?channel=beta endpoint with no extra
-- check. If beta is meant to be limited to testers, the channel name
-- alone isn't a secret. This column gives each app a per-app token that
-- must be passed as ?token=... for any channel other than "stable".
ALTER TABLE apps ADD COLUMN beta_token TEXT;
UPDATE apps SET beta_token = lower(hex(randomblob(16))) WHERE beta_token IS NULL;
