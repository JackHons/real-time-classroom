-- A staging cleanup has no user payload, but its durable completion must be
-- observable before a failed upload session can be safely forgotten.
CREATE TABLE upload_staging_cleanup_records (
  upload_session_id TEXT PRIMARY KEY REFERENCES upload_sessions(id) ON DELETE CASCADE,
  cleanup_code TEXT NOT NULL,
  cleaned_at_utc TEXT NOT NULL
);
