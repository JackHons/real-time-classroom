# Task 2 domain and persistence baseline

## SQLite boundary

`openSqlite()` enables `foreign_keys`, WAL journal mode, and a 5-second `busy_timeout`. Runtime SQLite files remain under `%LOCALAPPDATA%\LanClassroomPlatform\database`, never the repository. Migration `0001_initial.sql` is applied once through `schema_migrations` and copied beside the compiled server during build.

## Core invariants

- Student and teacher sessions store independent absolute and idle expiry times plus revocation. Because a SQLite partial index cannot evaluate moving time, student-session creation transactionally revokes expired active rows before inserting a replacement.
- `Student.isTemporary` distinguishes teacher-approved temporary students from roster imports; normalized student number is unique per class.
- Questions and file tasks are persisted with only `draft → open → closed`. `closeQuestion()` obtains its time from the repository clock inside one transaction, snapshots every eligible student (including `noAnswer`), persists one anonymous result snapshot, then returns.
- Answer idempotency is a separate immutable response record. It stores a request fingerprint and response JSON so a later mutable current answer cannot change a replay result.
- File metadata tables model the complete upload state machine, SHA-256, byte count, staged/final keys, server completion time, errors, idempotency, submission integrity metadata, and deletion markers. `metadata_committed` is unique per task/student. The Task 5 boundary must pass the final storage key to `commitAfterFileRename`; a missing/mismatched key or unexpected state throws a defensive failure instead of claiming metadata success. The filesystem upload/rename implementation remains intentionally deferred to Task 5.
- Task 5's `UploadPipeline` consumes an `AsyncIterable<Uint8Array>` and never collects the file in memory. It applies a hard 100,000,000-byte maximum, incrementally computes SHA-256, `fsync`s and closes staging before recording the server completion clock, then accepts only `receivedCompleteAtUtc <= deadlineAtUtc` (equality is on time). Staging and final files live below one configured storage root, so the verified `rename` is same-filesystem and atomic. Final keys are server-generated UUIDs; filenames are only sanitized metadata and never paths or executable/preview instructions.
- `SqliteUploadPipelineRepository` records a durable `file_committed` intent before the rename, then performs the submission insert and `metadata_committed` transition in one transaction after it. A rename followed by database failure becomes `recovery_pending`; startup reconciliation can verify/rename a surviving staged file or commit a final file without trusting a path from the database. Invalid staging is removed and failed. Committed metadata with a missing final is reported for operator repair rather than silently rewritten.
- Teacher-confirmed answer deletion physically removes answer payload rows, writes `answer_deletion_markers`, and never rewrites an anonymous close snapshot.
- Closed-question teacher reads expose named answers in bounded HTTP pages (default 50, maximum 100; `cursor` is an offset). The current Task 2 repository port still materializes the class roster before the HTTP route slices it; a future repository pagination port should move that bound into SQLite before this is used with very large rosters.

## Deferred work

This task creates no real authentication, password handling, HTTP routes, UI, Socket.IO, upload streams, filesystem rename, reconciliation worker, CSV/ZIP export, or runtime service database. Any future CSV export must neutralize spreadsheet formula-injection prefixes (for example `=`, `+`, `-`, and `@`) in every user-controlled cell before writing the file. `SqliteDomainRepository` is a trusted-internal persistence API, not an authorization boundary: Task 3 must authenticate and authorize before calling it. The `FileMetadataRepository` is only the transaction-boundary contract for Task 5's verified-file rename and recovery logic.
