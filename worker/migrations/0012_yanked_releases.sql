-- Yanked releases stay in the database and in R2 but are left out of the
-- appcast (see handleSetYanked). 0 = live, 1 = yanked.
ALTER TABLE versions ADD COLUMN yanked INTEGER NOT NULL DEFAULT 0;
