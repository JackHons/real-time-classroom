# Task 2 domain and persistence baseline

## SQLite boundary

`openSqlite()` enables `foreign_keys`, WAL journal mode, and a 5-second `busy_timeout`. Runtime SQLite files remain under `%LOCALAPPDATA%\LanClassroomPlatform\database`, never the repository. Migration `0001_initial.sql` is applied once through `schema_migrations` and copied beside the compiled server during build.

## Core invariants

- Student and teacher sessions store independent absolute and idle expiry times plus revocation. Because a SQLite partial index cannot evaluate moving time, student-session creation transactionally revokes expired active rows before inserting a replacement.
- `Student.isTemporary` distinguishes teacher-approved temporary students from roster imports; normalized student number is unique per class.
- Questions and file tasks are persisted with only `draft → open → closed`. `closeQuestion()` obtains its time from the repository clock inside one transaction, snapshots every eligible student (including `noAnswer`), persists one anonymous result snapshot, then returns.
- Answer idempotency is a separate immutable response record. It stores a request fingerprint and response JSON so a later mutable current answer cannot change a replay result.
- File metadata tables model the complete upload state machine, SHA-256, byte count, staged/final keys, server completion time, errors, idempotency, submission integrity metadata, and deletion markers. The filesystem upload/rename implementation remains intentionally deferred to Task 5.
- Teacher-confirmed answer deletion physically removes answer payload rows, writes `answer_deletion_markers`, and never rewrites an anonymous close snapshot.

## Deferred work

This task creates no real authentication, password handling, HTTP routes, UI, Socket.IO, upload streams, filesystem rename, reconciliation worker, CSV/ZIP export, or runtime service database. The `FileMetadataRepository` is only the transaction-boundary contract for Task 5's verified-file rename and recovery logic.
