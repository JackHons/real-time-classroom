import { readFileSync } from 'node:fs';
import type { SqliteDatabase } from './connection.js';

const migrations = [
  { id: '0001_initial', sql: readFileSync(new URL('./migrations/0001_initial.sql', import.meta.url), 'utf8') },
  { id: '0002_answer_at_close_roster_snapshot', sql: readFileSync(new URL('./migrations/0002_answer_at_close_roster_snapshot.sql', import.meta.url), 'utf8') },
  { id: '0003_upload_session_recovery_metadata', sql: readFileSync(new URL('./migrations/0003_upload_session_recovery_metadata.sql', import.meta.url), 'utf8') },
  { id: '0004_upload_storage_integrity', sql: readFileSync(new URL('./migrations/0004_upload_storage_integrity.sql', import.meta.url), 'utf8') },
  { id: '0005_upload_staging_cleanup_audit', sql: readFileSync(new URL('./migrations/0005_upload_staging_cleanup_audit.sql', import.meta.url), 'utf8') },
  { id: '0006_file_task_close_notification_outbox', sql: readFileSync(new URL('./migrations/0006_file_task_close_notification_outbox.sql', import.meta.url), 'utf8') },
  { id: '0007_answer_export_deletion_snapshot', sql: readFileSync(new URL('./migrations/0007_answer_export_deletion_snapshot.sql', import.meta.url), 'utf8') }
] as const;

export function migrate(database: SqliteDatabase): void {
  database.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at_utc TEXT NOT NULL)');
  const applied = database.prepare('SELECT id FROM schema_migrations WHERE id = ?');
  const record = database.prepare('INSERT INTO schema_migrations (id, applied_at_utc) VALUES (?, ?)');
  for (const migration of migrations) {
    if (applied.get(migration.id) !== undefined) continue;
    database.transaction(() => { database.exec(migration.sql); record.run(migration.id, new Date().toISOString()); })();
  }
}
