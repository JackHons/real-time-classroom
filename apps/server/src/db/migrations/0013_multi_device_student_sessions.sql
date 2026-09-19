-- Student authentication is per device. Retain all historical sessions and
-- preserve every existing class/student/academic record while allowing more
-- than one active opaque token for the same student.
DROP INDEX IF EXISTS active_student_session_unique;
