-- Add the errors column to the pages database.
-- Convenience script for the one instance of the server :)

ALTER TABLE pages ADD COLUMN error INTEGER DEFAULT NULL;
