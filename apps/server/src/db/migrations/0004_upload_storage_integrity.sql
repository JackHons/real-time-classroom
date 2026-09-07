-- Payload-free records make storage/metadata divergence observable to operators.
CREATE TABLE upload_integrity_records (
  upload_session_id TEXT PRIMARY KEY REFERENCES upload_sessions(id) ON DELETE CASCADE,
  integrity_code TEXT NOT NULL,
  detected_at_utc TEXT NOT NULL,
  resolved_at_utc TEXT NULL
);
