-- This is join telemetry, not a replacement for the historical roster.
-- Existing students are deliberately not backfilled: the teacher dashboard
-- must distinguish "listed before" from "actually joined this class".
CREATE TABLE student_class_joins (
  student_id TEXT PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  joined_at_utc TEXT NOT NULL,
  last_joined_at_utc TEXT NOT NULL
);
CREATE INDEX student_class_joins_class_last_joined ON student_class_joins(class_id,last_joined_at_utc DESC,student_id DESC);
