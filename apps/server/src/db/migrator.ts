import { readFileSync } from 'node:fs';
import type { SqliteDatabase } from './connection.js';

const migrations = [
  { id: '0001_initial', sql: readFileSync(new URL('./migrations/0001_initial.sql', import.meta.url), 'utf8') },
  { id: '0002_answer_at_close_roster_snapshot', sql: readFileSync(new URL('./migrations/0002_answer_at_close_roster_snapshot.sql', import.meta.url), 'utf8') },
  { id: '0003_upload_session_recovery_metadata', sql: readFileSync(new URL('./migrations/0003_upload_session_recovery_metadata.sql', import.meta.url), 'utf8') },
  { id: '0004_upload_storage_integrity', sql: readFileSync(new URL('./migrations/0004_upload_storage_integrity.sql', import.meta.url), 'utf8') },
  { id: '0005_upload_staging_cleanup_audit', sql: readFileSync(new URL('./migrations/0005_upload_staging_cleanup_audit.sql', import.meta.url), 'utf8') },
  { id: '0006_file_task_close_notification_outbox', sql: readFileSync(new URL('./migrations/0006_file_task_close_notification_outbox.sql', import.meta.url), 'utf8') },
  { id: '0007_answer_export_deletion_snapshot', sql: readFileSync(new URL('./migrations/0007_answer_export_deletion_snapshot.sql', import.meta.url), 'utf8') },
  { id: '0008_file_task_late_reopen', sql: readFileSync(new URL('./migrations/0008_file_task_late_reopen.sql', import.meta.url), 'utf8') },
  { id: '0009_student_class_joins', sql: readFileSync(new URL('./migrations/0009_student_class_joins.sql', import.meta.url), 'utf8') },
  { id: '0010_class_materials', sql: readFileSync(new URL('./migrations/0010_class_materials.sql', import.meta.url), 'utf8') }
] as const;

export const LATEST_SCHEMA_MIGRATION = '0010_class_materials';
export type MigrationReadiness = Readonly<{ schemaVersion: string; pendingMigrations: number; upgradeReady: boolean }>;

export function migrate(database: SqliteDatabase): void {
  database.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at_utc TEXT NOT NULL)');
  const applied = database.prepare('SELECT id FROM schema_migrations WHERE id = ?');
  const record = database.prepare('INSERT INTO schema_migrations (id, applied_at_utc) VALUES (?, ?)');
  for (const migration of migrations) {
    if (applied.get(migration.id) !== undefined) continue;
    database.transaction(() => { database.exec(migration.sql); record.run(migration.id, new Date().toISOString()); })();
  }
}

/** Read-only metadata for operators and the health surface; it never mutates data. */
export function migrationReadiness(database: SqliteDatabase): MigrationReadiness {
  const existing = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
  if (existing === undefined) return { schemaVersion: 'uninitialized', pendingMigrations: migrations.length, upgradeReady: false };
  const applied = database.prepare('SELECT id FROM schema_migrations').all() as readonly { id: string }[];
  const ids = new Set(applied.map((row) => row.id));
  const pendingMigrations = migrations.filter((migration) => !ids.has(migration.id)).length;
  const schemaVersion = [...migrations].reverse().find((migration) => ids.has(migration.id))?.id ?? 'uninitialized';
  return { schemaVersion, pendingMigrations, upgradeReady: pendingMigrations === 0 };
}
