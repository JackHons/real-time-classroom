# Activity pagination integration contract

Teacher activity reads return a page object, rather than a bare array:

```json
{ "items": [/* DTOs */], "nextCursor": "opaque-token" }
```

The affected endpoints are `GET /api/teacher/classes` and each of
`GET /api/teacher/classes/:classId/{roster,pending-student-requests,questions,file-tasks}`.
They accept `limit` (default 50, maximum 100) and `cursor`.  The client must
pass `nextCursor` back unchanged to get the next page, and stop when it is
absent.  It must not construct, decode, store across classes, or reuse a
cursor for a different endpoint. An invalid `limit` or cursor returns the
generic `400 {"error":"INVALID_REQUEST"}` response.

`GET /api/student/activities` has two independently paged lists to avoid one
large activity type delaying the other:

```json
{
  "questions": { "items": [/* student-safe question DTOs */], "nextCursor": "..." },
  "fileTasks": { "items": [/* student-safe file-task DTOs */], "nextCursor": "..." }
}
```

It accepts the shared `limit`, plus `questionCursor` and `fileTaskCursor`.
The client may advance either cursor independently and should preserve the
other cursor while it remains active. All activity responses use
`Cache-Control: no-store`.

For a restored student page, `GET /api/auth/student/csrf` now requires an
exact `Origin` header equal to the configured classroom origin. `Sec-Fetch-Site`
is not a substitute. Browser clients should call it with `credentials:
'same-origin'` and the same origin; non-browser clients cannot use it to mint
a token.
