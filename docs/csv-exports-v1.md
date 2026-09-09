# CSV exports v1

The only CSV download routes are authenticated teacher reads:

- `GET /api/questions/:questionId/answers/export.csv`
- `GET /api/classes/:classId/roster/export.csv`

Both return `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, an attachment-only server-selected filename, and `text/csv; charset=utf-8`. CSV starts with a UTF-8 BOM for traditional Chinese Excel, uses RFC 4180 quoting, and prefixes formula-like cells (including values hidden behind leading whitespace, controls, or bidi marks) with an apostrophe. NUL is replaced with U+FFFD.

Question export is available only after close and is keyset/batch streamed. Its columns are `studentNumber,displayName,status,answer,closedAtUtc`. Answer/name/number/time come only from `answer_at_close`; it never joins the mutable roster. `status` is `answered`, `noAnswer`, or `deleted`; a deletion suppresses answer text but retains the immutable close identity/status snapshot. Legacy snapshot NULLs become `Unknown` / `Unknown student`, never current roster data. Post-close answers are excluded.

Roster export columns are `studentNumber,displayName,isTemporary,approvedAtUtc`. It excludes IDs, normalized identity values, sessions, tokens, and pending requests. Internal keyset cursors never appear in the file.
