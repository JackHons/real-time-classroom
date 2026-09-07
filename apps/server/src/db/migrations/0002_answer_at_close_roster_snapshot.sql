-- `answer_at_close` is a historical roster snapshot. Its Task 2 foreign key
-- to students caused close records to disappear when a student left a class.
-- Rebuild it without that FK and add nullable columns so previously closed
-- questions migrate safely; the read adapter uses neutral legacy labels.
CREATE TABLE answer_at_close_replacement (
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL,
  display_name TEXT NULL,
  student_number TEXT NULL,
  revision INTEGER NULL,
  submitted_at_utc TEXT NULL,
  payload_json TEXT NULL,
  no_answer INTEGER NOT NULL CHECK(no_answer IN (0,1)),
  closed_at_utc TEXT NOT NULL,
  PRIMARY KEY(question_id, student_id),
  CHECK((no_answer = 1 AND payload_json IS NULL) OR (no_answer = 0 AND payload_json IS NOT NULL))
);
INSERT INTO answer_at_close_replacement (question_id,student_id,display_name,student_number,revision,submitted_at_utc,payload_json,no_answer,closed_at_utc)
  SELECT question_id,student_id,NULL,NULL,revision,submitted_at_utc,payload_json,no_answer,closed_at_utc FROM answer_at_close;
DROP TABLE answer_at_close;
ALTER TABLE answer_at_close_replacement RENAME TO answer_at_close;
