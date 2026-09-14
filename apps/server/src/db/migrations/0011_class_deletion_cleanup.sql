-- This table deliberately has no foreign key to classes.  It is a durable
-- journal for private generated objects whose class metadata was already
-- cascaded.  Startup retries these entries until both DB and disk agree.
CREATE TABLE class_deletion_cleanup (
  id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL,
  object_kind TEXT NOT NULL CHECK(object_kind IN ('final','staging')),
  storage_key TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  UNIQUE(object_kind, storage_key)
);
CREATE INDEX class_deletion_cleanup_created ON class_deletion_cleanup(created_at_utc,id);
