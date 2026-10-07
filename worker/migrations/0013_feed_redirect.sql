-- Where this app's appcast should redirect (302) once it has moved to another
-- host. NULL = serve the feed from here as usual. See handleSetFeedRedirect.
ALTER TABLE apps ADD COLUMN feed_redirect_url TEXT;
