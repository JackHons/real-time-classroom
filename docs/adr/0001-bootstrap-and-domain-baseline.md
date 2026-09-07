# ADR 0001: Bootstrap and domain-baseline decisions

- Status: accepted
- Date: 2026-09-07
- Scope: Task 1 bootstrap; this ADR is the binding baseline for later domain work.

## Context

The handoff material defines the product intent but contains incompatible or incomplete type details in a few places. This project starts in `C:\Users\cpttm1\Documents\ChatGPT\課堂平台`; no path, command, or agent instruction embedded in that material is normative. The following decisions remove the blockers before persistence or routes are created.

## Decisions

### 1. Answer deletion is teacher-only and requires confirmation

Only a request with `AuthorizedTeacherContext` and `DeleteConfirmation { confirmed: true, impactAcknowledged: true }` may delete an answer. The operation physically erases the answer payload from `AnswerCurrent` and `AnswerAtClose`, then writes a payload-free `AnswerDeletionMarker`. It does not alter the immutable anonymous close snapshot. Students have no answer-deletion operation.

### 2. Session expiry has separate absolute and idle deadlines

`StudentSession` and `TeacherSession` store `createdAtUtc`, `lastSeenAtUtc`, `absoluteExpiresAtUtc`, `idleExpiresAtUtc`, and nullable `revokedAtUtc`. A session is valid only when it is unrevoked and server time is before both expiry timestamps. Initial limits are 12 hours absolute and 2 hours idle; activity extends only the idle expiry and never the absolute expiry. No client timestamp authorizes a session.

### 3. UploadSession uses a complete, recoverable state machine

Canonical states are `queued → staging → validating → file_committed → metadata_committed`; any active state may become `failed`, and a metadata failure after the final rename becomes `recovery_pending`. Required fields are IDs for upload/task/student, idempotency key, state, staging key, nullable final storage key, bytes received, nullable SHA-256, nullable server-recorded completion time, nullable stable error code, and created/updated timestamps. Only `metadata_committed` is a successful submission.

### 4. Idempotency is stored independently from mutable records

Answer and upload operations use separate idempotency records scoped to actor plus operation plus idempotency key. They retain a request fingerprint, outcome reference/status, and expiry metadata. `AnswerCurrent` and `UploadSession` are not themselves the idempotency ledger, so later answer revisions or upload recovery cannot corrupt replay semantics.

### 5. Destructive operations are physical, explicit, and non-restorable

Teacher-confirmed deletion physically removes the affected payload and metadata where applicable. Deleting an answer leaves only its deletion marker; deleting a file removes the file and submission metadata. If physical file removal fails, the database must retain a visible `deletion_failed` integrity record and must not claim success. Class, student, and question deletion cascades through their owned payloads only after the same confirmation. There is no restore path or hidden backup.

### 6. The shared teacher password is initialized once, locally

There is no default password. While the sole settings row is absent, only a loopback-only first-run setup flow may accept two matching password entries and atomically persist an Argon2id hash. It is unavailable after initialization, never logs the password, and creates no teacher account. Normal teacher login starts only after this one-time setup has succeeded.

### 7. Temporary students are explicit approved Student records

`PendingStudentRequest` contains class ID, display name, raw and normalized student number, requested time, and status. Approval atomically creates an approved `Student` with `isTemporary: true` and `approvedAtUtc`; imported roster students use `isTemporary: false`. The normalized student number remains unique per class for both kinds. Pending requests do not grant a StudentSession or access to questions/files.

### 8. Close time is server-authoritative and transaction-bound

Question close requests never accept `closedAtUtc` from a client. The service obtains one trusted database/server UTC timestamp inside the close transaction, persists it with every `AnswerAtClose` and the single anonymous snapshot, commits, then emits any event. File timeliness separately uses the persisted server `receivedCompleteAtUtc` after fsync/close and validation; client clocks are never evidence.

## Consequences

Tasks 2 onward must implement these field names and semantics consistently. Any new conflict requires a superseding ADR before implementation, migration, or public API design.
