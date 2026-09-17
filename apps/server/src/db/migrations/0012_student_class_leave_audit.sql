-- Keep the join history visible to teachers while marking membership inactive.
-- This never cascades into students, answers, submissions or class materials.
ALTER TABLE student_class_joins ADD COLUMN left_at_utc TEXT NULL;
CREATE INDEX student_class_joins_class_active ON student_class_joins(class_id,left_at_utc,last_joined_at_utc DESC,student_id DESC);
