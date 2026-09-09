-- A close invalidation is durable state, not merely a best-effort socket send.
-- Delivery is at-least-once: a process crash after emit but before the delivered
-- mark can replay the minimal invalidation, which clients deduplicate by their
-- monotonic realtime version and authoritative REST refetch.
CREATE TABLE file_task_close_notification_outbox (
  task_id TEXT PRIMARY KEY REFERENCES file_submission_tasks(id) ON DELETE CASCADE,
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  created_at_utc TEXT NOT NULL,
  delivered_at_utc TEXT NULL
);
CREATE INDEX file_task_close_notification_pending ON file_task_close_notification_outbox(delivered_at_utc) WHERE delivered_at_utc IS NULL;
