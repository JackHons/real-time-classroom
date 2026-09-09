-- Deletions remove the live close view but preserve an immutable export status row.
ALTER TABLE answer_deletion_markers ADD COLUMN display_name TEXT NULL;
ALTER TABLE answer_deletion_markers ADD COLUMN student_number TEXT NULL;
ALTER TABLE answer_deletion_markers ADD COLUMN closed_at_utc TEXT NULL;
