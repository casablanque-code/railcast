-- Optional macOS version a release requires (e.g. "13.0"), served as
-- <sparkle:minimumSystemVersion> so Sparkle doesn't offer the update to Macs
-- that can't run it. NULL = no restriction (every release published before this).
ALTER TABLE versions ADD COLUMN min_system_version TEXT;
