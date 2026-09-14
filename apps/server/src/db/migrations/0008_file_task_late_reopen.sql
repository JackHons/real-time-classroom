-- A closed task can be explicitly reopened after its original deadline.
-- Null retains the normal deadline policy; a timestamp records the teacher
-- override and lets students submit until the teacher closes it again.
ALTER TABLE file_submission_tasks ADD COLUMN reopened_at_utc TEXT NULL;
