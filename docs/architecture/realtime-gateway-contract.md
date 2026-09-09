# Realtime gateway contract

Socket.IO is attached to the existing Node HTTP server in `server.ts`; it does
not own an HTTP listener and it exposes no write command. REST remains the only
way to create, edit, open, close, approve, upload, or delete data.

## Connection and scope

- The Engine.IO handshake requires an Origin that exactly equals
  `LAN_CLASSROOM_ALLOWED_ORIGIN`, a loopback or RFC1918/IPv6-ULA peer address,
  and either the existing `teacher_session` or `student_session` cookie.
- Student sockets join only their authenticated `class:<classId>:student` room.
  Teachers explicitly send `class:subscribe` with `{ "classId": "..." }`;
  the gateway verifies that the authenticated teacher is authorized for it and joins their
  `class:<classId>:teacher` room. A student cannot subscribe to a different
  class.
- The gateway rechecks the same session every 30 seconds. Revoked, expired, or
  replaced sessions disconnect. It uses a 25-second heartbeat, 100 concurrent
  connection ceiling, 1 KiB inbound message ceiling, subscription rate cap,
  and volatile fan-out so slow clients do not accumulate stale messages.
- On every connection (including reconnect), it sends `class:refetch` with
  `{ "reason": "connected" }`. It never replays state: clients must refetch
  their already-authorized REST views.

## Server events

`class:changed` is the only resource event and its complete payload is:

```json
{ "resourceType": "question", "id": "opaque-id", "version": 42, "event": "question_opened" }
```

`resourceType` is one of `question`, `file-task`, `pending`, `roster`, or
`submission`. The `event` is an invalidation label only. The event schema has
no answer content, reference answer, student ID/name/number, file name, hash,
or byte metadata. Notifications are best-effort and occur only after the REST
write is durable. Teacher-only resources (draft file tasks, roster/pending,
answer changes, and submission status) are emitted only to the teacher room;
open/close lifecycle changes reach both roles.

## Composition seam

`createApplication` returns `realtime` (cookie-session authentication and
class-existence ports) plus `realtimeNotifications` (a payload-free bus).
`main.ts` passes the former to `startServer` and attaches the latter only after
the single HTTP server's gateway exists. Tests can inject either side without
opening a network listener.
