-- Previously `apps.id` was both the internal key AND the client-chosen
-- public slug ("myapp") used directly in the appcast URL. Two problems:
--   1. It's a global namespace race — whoever registers "myapp" first
--      blocks everyone else who ships an app with that name.
--   2. It's guessable — anyone can try common app names against
--      /{id}/appcast.xml with no auth required (appcast has to stay public
--      for Sparkle clients, so the id itself was the only thing hiding it).
--
-- Fix: `id` becomes a server-generated opaque token (see index.ts,
-- randomAppId()), and the human-chosen name moves to this new `name`
-- column, which is NOT unique and never appears in a URL.
ALTER TABLE apps ADD COLUMN name TEXT NOT NULL DEFAULT '';
UPDATE apps SET name = id WHERE name = '';
