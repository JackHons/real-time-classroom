CREATE TABLE class_materials (
  id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  display_filename TEXT NOT NULL,
  declared_mime_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK(byte_length >= 0 AND byte_length <= 26214400),
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  storage_key TEXT NOT NULL UNIQUE,
  created_at_utc TEXT NOT NULL
);
CREATE INDEX class_materials_class_created ON class_materials(class_id,created_at_utc DESC,id DESC);
