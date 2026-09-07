-- These fields are deliberately kept on the durable upload intent.  A process
-- can therefore finish the metadata transaction after an atomic filesystem
-- rename even when it restarted between those two operations.
ALTER TABLE upload_sessions ADD COLUMN original_filename TEXT NULL;
ALTER TABLE upload_sessions ADD COLUMN display_filename TEXT NULL;
ALTER TABLE upload_sessions ADD COLUMN declared_mime_type TEXT NULL;
